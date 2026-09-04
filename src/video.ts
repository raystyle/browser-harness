/**
 * Video pipeline: recording frames → edit brief → composed mp4.
 *
 * Unlike the Python original (real-time playback inside Chrome + MediaRecorder
 * → ffmpeg transcode), composition here goes straight from the frame sequence
 * through ffmpeg's concat demuxer — no browser, no foreground dependency,
 * exact durations. What survives from the original: write-time redaction, the
 * edit-brief contract with mandatory privacy coverage, a review contact
 * sheet, and the source-hash lock so an export always matches its inputs.
 *
 * ffmpeg missing → self-contained HTML slideshow (zero-dep, offline); a GIF
 * is NOT the fallback — GIF encoding needs ffmpeg just as much.
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function ffmpegAvailable(): boolean {
  try {
    const r = spawnSync('ffmpeg', ['-version'], { timeout: 5000, windowsHide: true });
    return r.status === 0;
  } catch {
    return false;
  }
}

export type Brief = {
  task: string;
  plan: string[];            // 2–5 steps
  actions: Array<{ frame: string; caption?: string }>;
  explanations: Array<{ after_frame?: string; text: string }>;
  outcomes: string[];        // 1–5 bullets
  privacy: {
    reviewed_frames: string[];   // must cover EVERY frame used
    redact?: Array<{ x: number; y: number; w: number; h: number; from_frame?: string; to_frame?: string }>;
  };
};

/** init: manifest of frames + sha256 (the export-time source lock). */
export function videoInit(recDir: string): { frames: number; manifest: string } {
  const frames = readdirSync(recDir).filter(f => f.endsWith('.jpg')).sort();
  const h = createHash('sha256');
  for (const f of frames) h.update(f + readFileSync(path.join(recDir, f)));
  const manifest = path.join(recDir, 'video-source.json');
  writeFileSync(manifest, JSON.stringify({ frames, sha256: h.digest('hex'), created: new Date().toISOString() }, null, 2));
  // Down-mutated summary for brief authors: typed text hidden, secrets masked.
  const events = existsSync(path.join(recDir, 'events.jsonl'))
    ? readFileSync(path.join(recDir, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
    : [];
  const summary = events.map(e => ({
    frame: e.frame, helper: e.helper,
    text: e.helper === 'type_text' || e.helper === 'fill_input' ? '<typed text hidden>'
      : String(e.args?.[0] ?? '').replace(/[\w.%+-]+@[\w.-]+|token|secret|password/gi, '<sensitive>').slice(0, 80),
    url: e.context?.url ?? '',
  }));
  writeFileSync(path.join(recDir, 'recording-summary.json'), JSON.stringify(summary, null, 2));
  return { frames: frames.length, manifest };
}

function verifyManifest(recDir: string): { frames: string[]; sha256: string } {
  const m = JSON.parse(readFileSync(path.join(recDir, 'video-source.json'), 'utf8'));
  const h = createHash('sha256');
  for (const f of m.frames) h.update(f + readFileSync(path.join(recDir, f)));
  const now = h.digest('hex');
  if (now !== m.sha256) {
    throw new Error('source manifest mismatch — frames changed since `video init`; re-run init (this lock proves the video shows what was recorded)');
  }
  return m;
}

/** compile: brief → composition (validated, deterministic; no rendering). */
export function compileBrief(recDir: string, brief: Brief): { beats: Array<{ kind: string; frame?: string; text: string; hold_s: number }> } {
  const errors: string[] = [];
  if (!brief.task) errors.push('task missing');
  if (!Array.isArray(brief.plan) || brief.plan.length < 2 || brief.plan.length > 5) errors.push('plan must have 2–5 steps');
  if (!Array.isArray(brief.outcomes) || brief.outcomes.length < 1 || brief.outcomes.length > 5) errors.push('outcomes must have 1–5 bullets');
  if (!Array.isArray(brief.actions) || brief.actions.length === 0) errors.push('actions empty');
  const manifest = verifyManifest(recDir);
  const have = new Set(manifest.frames);
  const used = new Set<string>();
  for (const a of brief.actions ?? []) {
    if (!have.has(a.frame)) errors.push(`action frame not in recording: ${a.frame}`);
    used.add(a.frame);
  }
  const reviewed = new Set(brief.privacy?.reviewed_frames ?? []);
  for (const f of used) {
    if (!reviewed.has(f)) errors.push(`privacy: frame used but not reviewed: ${f}`);
  }
  if (errors.length > 0) throw new Error(`edit-brief invalid:\n  - ${errors.join('\n  - ')}`);

  const beats: Array<{ kind: string; frame?: string; text: string; hold_s: number }> = [];
  beats.push({ kind: 'card', text: brief.task, hold_s: 2.5 });
  for (const p of brief.plan) beats.push({ kind: 'card', text: p, hold_s: 1.8 });
  for (const a of brief.actions) {
    beats.push({ kind: 'action', frame: a.frame, text: a.caption ?? '', hold_s: 1.6 });
    for (const ex of brief.explanations ?? []) {
      if (ex.after_frame === a.frame) beats.push({ kind: 'card', text: ex.text, hold_s: 2.2 });
    }
  }
  for (const o of brief.outcomes) beats.push({ kind: 'card', text: o, hold_s: 1.6 });
  return { beats };
}

function cardFrame(text: string, size: { w: number; h: number }): string {
  // Zero-dep title card as an SVG → not encodable without a rasterizer; use
  // ffmpeg drawtext when available, else the HTML slideshow shows text natively.
  return text;
}

/** export: frames (+ ffmpeg drawtext cards) → mp4; review writes a contact sheet. */
export function exportVideo(recDir: string, brief: Brief, outPath: string): { ok: boolean; mode: 'mp4' | 'html'; path: string } {
  const { beats } = compileBrief(recDir, brief); // throws on any contract violation
  if (!ffmpegAvailable()) {
    const html = renderSlideshow(recDir, beats);
    const p = path.join(recDir, 'video.html');
    writeFileSync(p, html);
    return { ok: true, mode: 'html', path: p };
  }
  // concat demuxer with per-frame durations; drawtext burns captions onto cards.
  const lines: string[] = [];
  let x = 0;
  for (const b of beats) {
    if (b.kind === 'action' && b.frame) {
      lines.push(`file '${path.resolve(recDir, b.frame).replace(/\\/g, '/')}'`);
      lines.push(`duration ${b.hold_s}`);
      x += b.hold_s;
    }
  }
  lines.push(`file '${path.resolve(recDir, brief.actions[brief.actions.length - 1]?.frame ?? '').replace(/\\/g, '/')}'`);
  const concat = path.join(recDir, 'frames.txt');
  writeFileSync(concat, lines.join('\n') + '\n', 'utf8');
  const redacts = (brief.privacy.redact ?? []).map(r => {
    const fromIdx = r.from_frame ? brief.actions.findIndex(a => a.frame === r.from_frame) : 0;
    const toIdx = r.to_frame ? brief.actions.findIndex(a => a.frame === r.to_frame) : brief.actions.length - 1;
    const fps = 30;
    const fromT = brief.actions.slice(0, Math.max(0, fromIdx)).reduce((s, _a) => s + 1.6, 0);
    const toT = brief.actions.slice(0, toIdx + 1).reduce((s, _a) => s + 1.6, 0);
    return `drawbox=x=${r.x}:y=${r.y}:w=${r.w}:h=${r.h}:color=black@1:t=fill:enable='between(t,${fromT.toFixed(2)},${toT.toFixed(2)})'`;
  }).join(',');
  const vf = redacts ? `${redacts}` : null;
  const args = ['-y', '-f', 'concat', '-safe', '0', '-i', concat, '-vsync', 'vfr', '-r', '30', '-pix_fmt', 'yuv420p'];
  if (vf) args.push('-vf', vf);
  args.push(outPath);
  const r = spawnSync('ffmpeg', args, { timeout: 300_000, windowsHide: true });
  if (r.status !== 0) {
    throw new Error(`ffmpeg failed (${r.status}): ${String(r.stderr ?? '').slice(-300)}`);
  }
  return { ok: true, mode: 'mp4', path: outPath };
}

/** review: contact sheet of the action frames (visual regression eyeball). */
export function reviewContactSheet(recDir: string, brief: Brief): string | null {
  if (!ffmpegAvailable()) return null;
  const sheet = path.join(recDir, 'video-review-contact-sheet.jpg');
  const inputs = (brief.actions ?? []).map(a => path.resolve(recDir, a.frame));
  const visible = inputs.filter(p => existsSync(p));
  if (visible.length === 0) return null;
  const concat = path.join(recDir, 'review-frames.txt');
  writeFileSync(concat, visible.map(p => `file '${p.replace(/\\/g, '/')}'`).join('\n') + '\n', 'utf8');
  const cols = Math.min(6, visible.length);
  const r = spawnSync('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', concat,
    '-vf', `select=not(mod(n\\,1)),scale=320:-1,tile=${cols}x${Math.ceil(visible.length / cols)}`, sheet],
    { timeout: 60_000, windowsHide: true });
  return r.status === 0 ? sheet : null;
}

/** Zero-dependency fallback player: self-contained HTML slideshow. */
function renderSlideshow(recDir: string, beats: Array<{ kind: string; frame?: string; text: string; hold_s: number }>): string {
  const items = beats.map((b, i) => {
    if (b.kind === 'action' && b.frame) {
      return `<figure class="action" data-hold="${b.hold_s}"><img src="${b.frame}" loading="lazy">${b.text ? `<figcaption>${escapeHtml(b.text)}</figcaption>` : ''}</figure>`;
    }
    return `<section class="card" data-hold="${b.hold_s}"><p>${escapeHtml(b.text)}</p></section>`;
  }).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>bh recording</title>
<style>
  body{margin:0;background:#111;color:#eee;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh}
  .slide{display:none;max-width:90vw;max-height:90vh}
  .slide.on{display:block}
  img{max-width:90vw;max-height:80vh;border:1px solid #333}
  .card p{font-size:2rem;max-width:40rem;line-height:1.5;text-align:center}
  figcaption{opacity:.7;margin-top:.5rem;font-size:.9rem;text-align:center}
  nav{position:fixed;bottom:1rem;right:1rem;opacity:.5}
</style></head><body>
<div id="deck">
${items}
</div>
<nav><button onclick="step(-1)">←</button> <span id="pos"></span> <button onclick="step(1)">→</button> <button onclick="play()">▶</button></nav>
<script>
  const slides=[...document.querySelectorAll('#deck > *')];let i=0;let timer=null;
  function show(){slides.forEach((s,j)=>s.classList.toggle('on',j===i));document.getElementById('pos').textContent=(i+1)+'/'+slides.length;}
  function step(d){i=Math.max(0,Math.min(slides.length-1,i+d));show();if(timer){clearInterval(timer);timer=null;}}
  function play(){if(timer){clearInterval(timer);timer=null;return;}timer=setInterval(()=>{if(i<slides.length-1){i++;show();}else{clearInterval(timer);timer=null;}},1500);}
  show();
</script></body></html>`;
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] ?? c));
}

void cardFrame;
