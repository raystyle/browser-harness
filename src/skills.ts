/**
 * Skill + workspace distribution with the three-line drift guard:
 * repo payload (skill/, assets/) ↔ npm package ↔ deployed copies
 * (~/.claude/skills/browser, ~/.codex/skills/browser, <workspace>/apps+domain-skills).
 *
 * Hashing normalizes CRLF→LF for text payloads first — an autocrlf checkout
 * must compare equal to the LF copy we sync out, else status reports OUTDATED
 * forever (the M107 lesson). Provisioning is add-only: the workspace is
 * user/agent-owned, and only the explicit _RETIRED whitelist is ever removed.
 */

import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeDir } from './paths.js';

const PKG_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // <pkg> or <repo>

const SKILL_NAME = 'browser';

/** Deployed skill targets (Agent Skills layout <root>/skills/<name>/). */
function skillDirs(): Array<{ tool: string; dir: string }> {
  const home = homedir();
  return [
    { tool: 'claude', dir: path.join(home, '.claude', 'skills', SKILL_NAME) },
    { tool: 'codex', dir: path.join(home, '.codex', 'skills', SKILL_NAME) },
  ];
}

/**
 * Source payload inside the package, as (absPath, mirrorRelativePath) pairs:
 * SKILL.md + interaction-skills/ + primitives/ (D36) + domain-skills/ (D36 —
 * the 94-site knowledge rides WITH the skill so agents can actually reach it;
 * a skill that references knowledge it cannot ship never fires).
 */
function skillSourceEntries(): Array<{ src: string; rel: string }> {
  const out: Array<{ src: string; rel: string }> = [];
  const md = path.join(PKG_DIR, 'skill', 'SKILL.md');
  if (existsSync(md)) out.push({ src: md, rel: 'SKILL.md' });
  const trees: Array<{ srcDir: string; relDir: string }> = [
    { srcDir: path.join(PKG_DIR, 'skill', 'interaction-skills'), relDir: 'interaction-skills' },
    { srcDir: path.join(PKG_DIR, 'skill', 'primitives'), relDir: 'primitives' },
    { srcDir: path.join(PKG_DIR, 'assets', 'domain-skills'), relDir: 'domain-skills' },
  ];
  for (const { srcDir, relDir } of trees) {
    if (!existsSync(srcDir)) continue;
    (function walk(d: string) {
      for (const f of readdirSync(d).sort()) {
        const p = path.join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else out.push({ src: p, rel: path.join(relDir, p.slice(srcDir.length + 1)) });
      }
    })(srcDir);
  }
  return out;
}

const TEXT_SUFFIXES = ['.md', '.mjs', '.js', '.json'];

/** File bytes with CRLF folded to LF for text payloads (M107). */
function normBytes(p: string): Buffer {
  const data = readFileSync(p);
  if (TEXT_SUFFIXES.includes(path.extname(p))) {
    return Buffer.from(data.toString('utf8').replace(/\r\n/g, '\n'));
  }
  return data;
}

/** sha256(posix-relative-path + normalized content) over an entry set. */
function skillHash(files: Array<{ src: string; rel: string }>): string | null {
  if (files.length === 0) return null;
  const h = createHash('sha256');
  for (const { src, rel } of files) {
    h.update(rel.replace(/\\/g, '/'));
    h.update(normBytes(src));
  }
  return h.digest('hex').slice(0, 16);
}

/** Guard against shipping a pointer stub as the payload. */
function assertRealSkillMd(): void {
  const md = path.join(PKG_DIR, 'skill', 'SKILL.md');
  const text = readFileSync(md, 'utf8');
  if (text.startsWith('..') || !text.includes(`name: ${SKILL_NAME}`)) {
    throw new Error('packaged SKILL.md is the pointer stub — reinstall browser-harness-ts first');
  }
}

export type SkillStatus = { tool: string; dir: string; state: 'up to date' | 'OUTDATED' | 'not installed'; hash?: string | undefined };

export function skillStatus(): SkillStatus[] {
  assertRealSkillMd();
  const srcHash = skillHash(skillSourceEntries());
  return skillDirs().map(({ tool, dir }) => {
    if (!existsSync(path.dirname(path.dirname(dir)))) return { tool, dir, state: 'not installed' as const };
    const dstFiles = existsSync(dir) ? collectMirror(dir) : [];
    const dstHash = skillHash(dstFiles);
    if (dstFiles.length === 0) return { tool, dir, state: 'not installed' as const };
    return dstHash === srcHash
      ? { tool, dir, state: 'up to date' as const, hash: dstHash ?? undefined }
      : { tool, dir, state: 'OUTDATED' as const, hash: dstHash ?? undefined };
  });
}

/** The mirrored payload subtrees (D36: primitives + domain-skills ride along). */
const MIRROR_SUBTREES = ['interaction-skills', 'primitives', 'domain-skills'];

function collectMirror(dir: string): Array<{ src: string; rel: string }> {
  const out: Array<{ src: string; rel: string }> = [];
  const md = path.join(dir, 'SKILL.md');
  if (existsSync(md)) out.push({ src: md, rel: 'SKILL.md' });
  for (const sub of MIRROR_SUBTREES) {
    const root = path.join(dir, sub);
    if (!existsSync(root)) continue;
    (function walk(d: string) {
      for (const f of readdirSync(d).sort()) {
        const p = path.join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else out.push({ src: p, rel: path.join(sub, p.slice(root.length + 1)) });
      }
    })(root);
  }
  return out;
}

/** Mirror the skill payload, forcing LF line endings on write. */
export function skillSync(dryRun = false): Array<{ tool: string; action: string }> {
  assertRealSkillMd();
  const actions: Array<{ tool: string; action: string }> = [];
  for (const { tool, dir } of skillDirs()) {
    if (!existsSync(path.dirname(path.dirname(dir)))) continue; // tool not installed on this machine
    if (dryRun) { actions.push({ tool, action: `would sync → ${dir}` }); continue; }
    // Mirror: SKILL.md + the payload subtrees (delete-then-copy, all ours).
    mkdirSync(dir, { recursive: true });
    const srcMd = path.join(PKG_DIR, 'skill', 'SKILL.md');
    writeFileSync(path.join(dir, 'SKILL.md'), normBytes(srcMd), 'utf8');
    const trees: Array<{ srcDir: string; relDir: string }> = [
      { srcDir: path.join(PKG_DIR, 'skill', 'interaction-skills'), relDir: 'interaction-skills' },
      { srcDir: path.join(PKG_DIR, 'skill', 'primitives'), relDir: 'primitives' },
      { srcDir: path.join(PKG_DIR, 'assets', 'domain-skills'), relDir: 'domain-skills' },
    ];
    for (const { srcDir, relDir } of trees) {
      const dst = path.join(dir, relDir);
      if (existsSync(dst)) rmSync(dst, { recursive: true, force: true });
      if (!existsSync(srcDir)) continue;
      cpSync(srcDir, dst, { recursive: true });
      // Force LF on copied text files.
      (function lf(d: string) {
        for (const f of readdirSync(d)) {
          const p = path.join(d, f);
          if (statSync(p).isDirectory()) lf(p);
          else if (TEXT_SUFFIXES.includes(path.extname(p))) writeFileSync(p, normBytes(p));
        }
      })(dst);
    }
    actions.push({ tool, action: `synced → ${dir}` });
  }
  return actions;
}

// ---------------------------------------------------------------------------
// Domain-skills access primitives (D36): agents read site knowledge by
// COMMAND, not by knowing filesystem layout.
// ---------------------------------------------------------------------------

/** List available site-knowledge segments (deployed copy first, package fallback). */
export function skillSites(): string[] {
  const dir = firstExisting([
    path.join(skillDirs()[0]?.dir ?? '', 'domain-skills'),
    path.join(PKG_DIR, 'assets', 'domain-skills'),
  ]);
  if (!dir) return [];
  try {
    return readdirSync(dir).filter(f => statSync(path.join(dir, f)).isDirectory()).sort();
  } catch { return []; }
}

/** Print one site's knowledge files (joined, LF). Empty string = no knowledge. */
export function skillSite(seg: string): string {
  const clean = seg.replace(/^www\./, '').split('.')[0] ?? seg;
  for (const base of skillDirs().map(d => path.join(d.dir, 'domain-skills')).concat(path.join(PKG_DIR, 'assets', 'domain-skills'))) {
    const dir = path.join(base, clean);
    if (!existsSync(dir)) continue;
    const parts: string[] = [];
    (function walk(d: string) {
      for (const f of readdirSync(d).sort()) {
        const p = path.join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (f.endsWith('.md')) parts.push(`# ${f}\n${readFileSync(p, 'utf8')}`);
      }
    })(dir);
    if (parts.length > 0) return parts.join('\n\n---\n\n');
  }
  return '';
}

function firstExisting(dirs: string[]): string | null {
  for (const d of dirs) if (d && existsSync(d)) return d;
  return null;
}

// ---------------------------------------------------------------------------
// Workspace provisioning: add-only
// ---------------------------------------------------------------------------

const PROVISION_DIRS = ['apps', 'sdk', 'domain-skills'];
const PAYLOAD_EXT = ['.md', '.mjs', '.py', '.js']; // .js = built page-resident SDKs (assets/sdk)

/** Legacy v0.4-era filenames; the ONLY things provisioning ever removes. */
const RETIRED_WORKSPACE_FILES: string[] = [
  'browser_watch.py', 'browser_wizard.py', 'page_text.py', 'start-x-monitor.ps1',
  'x_monitor.py', 'x_search.py', 'x_supervisor.py', 'x_worker.py',
  'apps/x-core', 'apps/x-core.mjs',
  'apps/x-intel/supervisor.mjs',
  'apps/x-intel/search.mjs', 'apps/x-intel/harvest.mjs', // D46: search lanes moved to apps/x-search/
  'apps/x-intel/lib.mjs', 'apps/x-search/lib.mjs', // D47a: merged into the shared apps/lib.mjs
];

export function provisionWorkspace(workspaceDir: string, dryRun = false): { copied: string[]; retired: string[] } {
  const copied: string[] = [];
  const retired: string[] = [];
  // Dist stamp: workspace plugins locate package internals via this path when
  // no daemon record exists yet (queries before the first `bh --start`).
  if (!dryRun) {
    try {
      writeFileSync(path.join(runtimeDir(), 'dist.path'), PKG_DIR, 'utf8');
    } catch { /* best-effort stamp */ }
  }
  for (const dirName of PROVISION_DIRS) {
    const src = path.join(PKG_DIR, 'assets', dirName);
    if (!existsSync(src)) continue;
    const files: string[] = [];
    (function walk(d: string) {
      for (const f of readdirSync(d).sort()) {
        const p = path.join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (PAYLOAD_EXT.includes(path.extname(p))) files.push(p);
      }
    })(src);
    for (const p of files) {
      const rel = p.slice(src.length + 1);
      const dst = path.join(workspaceDir, dirName, rel);
      if (existsSync(dst)) {
        try {
          if (normBytes(dst).equals(normBytes(p))) continue; // identical
        } catch { /* unreadable → re-copy */ }
      }
      if (!dryRun) {
        mkdirSync(path.dirname(dst), { recursive: true });
        cpSync(p, dst);
      }
      copied.push(`${dirName}/${rel}`);
    }
  }
  // browser_helpers.mjs override sample: copy only when absent (user-editable).
  const bhSrc = path.join(PKG_DIR, 'assets', 'browser_helpers.mjs');
  if (existsSync(bhSrc)) {
    const dst = path.join(workspaceDir, 'browser_helpers.mjs');
    if (!existsSync(dst)) {
      if (!dryRun) cpSync(bhSrc, dst);
      copied.push('browser_helpers.mjs');
    }
  }
  // Retired whitelist — explicit removals only.
  for (const f of RETIRED_WORKSPACE_FILES) {
    const p = path.join(workspaceDir, f);
    if (existsSync(p)) {
      if (!dryRun) rmSync(p, { force: true, recursive: true });
      retired.push(f);
    }
  }
  return { copied, retired };
}
