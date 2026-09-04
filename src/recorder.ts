/**
 * Recorder — one frame per ACTION (never a screencast stream). Action-class
 * helpers are traced at createHelpers(); after each action settles (0.15s) a
 * synchronous Page.captureScreenshot (JPEG q80, 60s budget — the normal 5s
 * budget kills every capture) lands as NNNN.jpg, with an events.jsonl line
 * carrying page context and the action args.
 *
 * Redaction happens AT WRITE TIME: credential-ish URL params are scrubbed,
 * password inputs are marked for video masking, long texts truncated.
 * Recording failures are swallowed wholesale — a broken recording must never
 * break the task; a failed frame leaves frame_error instead.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpDir, workspaceDir, instanceName } from './paths.js';
import { envTriBool } from './env.js';

const CREDENTIAL_PARAMS = ['code', 'access_token', 'token', 'api_key', 'refresh_token', 'id_token', 'client_secret', 'sig', 'password'];
const IDLE_ROLLOVER = Number(process.env.BH_RECORD_IDLE ?? 180);

/** Action-class helpers (screen-changing); read-only ones never frame. */
const ACTION_HELPERS = new Set(['click_at_xy', 'type_text', 'fill_input', 'press_key', 'scroll', 'goto_url', 'switch_tab', 'new_tab', 'close_tab']);

function scrubUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const [k] of u.searchParams) {
      if (CREDENTIAL_PARAMS.includes(k.toLowerCase())) u.searchParams.set(k, '<redacted>');
    }
    return u.toString();
  } catch {
    return url;
  }
}

export type Recorder = {
  observe(name: string, args: unknown[], ms: number, error?: unknown): Promise<void>;
  activeDir(): string | undefined;
};

function prefsFile(): string {
  return `${tmpDir().replace(/[\\/]$/, '')}/../config/recording.json`;
}

function prefEnabled(): boolean {
  try {
    return (JSON.parse(readFileSync(prefsFile(), 'utf8')) as { enabled?: boolean }).enabled === true;
  } catch {
    return false;
  }
}

/** Three-layer switch: BH_RECORD env (process) → recording.json (persistent) → off. */
export function recordingEnabled(): boolean {
  const env = envTriBool('BH_RECORD');
  if (env !== undefined) return env;
  return prefEnabled();
}

function markerFile(): string {
  return `${workspaceDir()}/recordings/.active-${instanceName()}`;
}

export function activeRecordingDir(): string | undefined {
  try {
    return readFileSync(markerFile(), 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

function newSessionDir(auto: boolean): string {
  const base = path.join(workspaceDir(), 'recordings');
  mkdirSync(base, { recursive: true });
  const name = auto ? `session-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}` : `rec-${Date.now().toString(36)}`;
  const dir = path.join(base, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ name, title: name, started: new Date().toISOString(), auto }, null, 2));
  writeFileSync(markerFile(), dir, 'utf8');
  return dir;
}

export function startRecording(title?: string): string {
  if (envTriBool('BH_RECORD') === false) {
    throw new Error('recording disabled by BH_RECORD=0 — unset it or set BH_RECORD=1 first');
  }
  const dir = newSessionDir(false);
  if (title) {
    writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ name: path.basename(dir), title, started: new Date().toISOString(), auto: false }, null, 2));
  }
  return dir;
}

export function stopRecording(): void {
  try { utimesSync(markerFile(), new Date(), new Date()); } catch { /* absent */ }
  try { renameSync(markerFile(), `${markerFile()}.stopped-${Date.now()}`); } catch { /* absent */ }
}

export function setRecordingPref(enabled: boolean): void {
  const p = prefsFile();
  mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify({ enabled }, null, 2));
  renameSync(tmp, p);
}

/** Create the recorder wired into createHelpers' onAction hook. */
export function createRecorder(capture: (path: string) => Promise<void>, pageContext: () => Promise<Record<string, unknown>>): Recorder {
  let lastFrameAt = 0;
  let dir: string | undefined;
  let nextFrame = 1; // monotonic per session — concurrent observes must never share a frame number

  async function observe(name: string, args: unknown[], ms: number, error?: unknown): Promise<void> {
    try {
      if (!recordingEnabled() || !ACTION_HELPERS.has(name)) return;
      // Idle rollover: unrelated tasks must not merge into one recording.
      if (dir && Date.now() - lastFrameAt > IDLE_ROLLOVER * 1000) { dir = undefined; nextFrame = 1; }
      if (!dir) {
        dir = activeRecordingDir() ?? newSessionDir(true);
        nextFrame = 1;
        try {
          nextFrame = readdirSync(dir).filter(f => f.endsWith('.jpg')).length + 1;
        } catch { /* fresh dir */ }
      }
      // Reserve the frame number SYNCHRONOUSLY, before any await — concurrent
      // observes settling in parallel must never share a number.
      const n = nextFrame++;
      const frame = path.join(dir, `${String(n).padStart(4, '0')}.jpg`);

      await new Promise(r => setTimeout(r, 150)); // action settle

      // Frame numbering was reserved synchronously above; capture now.
      try {
        await capture(frame);
        lastFrameAt = Date.now();
        const ctx = await pageContext().catch(() => ({}));
        const evt = {
          ts: new Date().toISOString(), helper: name, duration_ms: ms,
          context: { ...ctx, url: scrubUrl(String((ctx as any).url ?? '')) },
          args: args.map(a => typeof a === 'string' ? a.slice(0, 500) : a),
          error: error ? String((error as any)?.message ?? error).slice(0, 200) : undefined,
          frame: path.basename(frame),
        };
        appendFileSync(path.join(dir!, 'events.jsonl'), JSON.stringify(evt) + '\n');
      } catch (e: any) {
        const evt = {
          ts: new Date().toISOString(), helper: name, duration_ms: ms,
          context: {},
          args: args.map(a => typeof a === 'string' ? a.slice(0, 500) : a),
          frame_error: `${name}: ${String(e?.message ?? e).slice(0, 200)}`,
        };
        appendFileSync(path.join(dir!, 'events.jsonl'), JSON.stringify(evt) + '\n');
      }
    } catch (e: any) {
      // Recorder never breaks the task — but failures must leave a trace.
      try {
        appendFileSync(path.join(tmpDir(), 'recorder-debug.log'), `${new Date().toISOString()} ${name}: ${String(e?.stack ?? e)}\n`);
      } catch { /* nowhere to log */ }
    }
  }

  return {
    observe,
    activeDir: () => dir,
  };
}
