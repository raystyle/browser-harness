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

/** Source payload inside the package: skill/SKILL.md + skill/interaction-skills/**. */
function skillSourceFiles(): string[] {
  const out: string[] = [];
  const skillDir = path.join(PKG_DIR, 'skill');
  const md = path.join(skillDir, 'SKILL.md');
  if (existsSync(md)) out.push(md);
  const inter = path.join(skillDir, 'interaction-skills');
  if (existsSync(inter)) {
    (function walk(d: string) {
      for (const f of readdirSync(d).sort()) {
        const p = path.join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else out.push(p);
      }
    })(inter);
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

/** sha256(posix-relative-path + normalized content) over the mirror set. */
function skillHash(files: string[], root: string): string | null {
  if (files.length === 0) return null;
  const h = createHash('sha256');
  for (const p of files) {
    h.update(p.slice(root.length + 1).replace(/\\/g, '/'));
    h.update(normBytes(p));
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

export type SkillStatus = { tool: string; dir: string; state: 'up to date' | 'OUTDATED' | 'not installed'; hash?: string };

export function skillStatus(): SkillStatus[] {
  assertRealSkillMd();
  const src = skillSourceFiles();
  const srcHash = skillHash(src, path.join(PKG_DIR, 'skill'));
  return skillDirs().map(({ tool, dir }) => {
    if (!existsSync(path.dirname(path.dirname(dir)))) return { tool, dir, state: 'not installed' as const };
    const dstFiles = existsSync(dir) ? collectMirror(dir) : [];
    const dstHash = skillHash(dstFiles, dir);
    if (dstFiles.length === 0) return { tool, dir, state: 'not installed' as const };
    return dstHash === srcHash
      ? { tool, dir, state: 'up to date' as const, hash: dstHash ?? undefined }
      : { tool, dir, state: 'OUTDATED' as const, hash: dstHash ?? undefined };
  });
}

function collectMirror(dir: string): string[] {
  const out: string[] = [];
  (function walk(d: string) {
    for (const f of readdirSync(d).sort()) {
      const p = path.join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (f === 'SKILL.md' || p.includes('interaction-skills')) out.push(p);
    }
  })(dir);
  return out;
}

/** Mirror the skill payload, forcing LF line endings on write. */
export function skillSync(dryRun = false): Array<{ tool: string; action: string }> {
  assertRealSkillMd();
  const actions: Array<{ tool: string; action: string }> = [];
  for (const { tool, dir } of skillDirs()) {
    if (!existsSync(path.dirname(path.dirname(dir)))) continue; // tool not installed on this machine
    if (dryRun) { actions.push({ tool, action: `would sync → ${dir}` }); continue; }
    // Mirror: SKILL.md + interaction-skills/ (delete-then-copy, both ours).
    mkdirSync(dir, { recursive: true });
    const srcMd = path.join(PKG_DIR, 'skill', 'SKILL.md');
    writeFileSync(path.join(dir, 'SKILL.md'), normBytes(srcMd), 'utf8');
    const interSrc = path.join(PKG_DIR, 'skill', 'interaction-skills');
    const interDst = path.join(dir, 'interaction-skills');
    if (existsSync(interDst)) rmSync(interDst, { recursive: true, force: true });
    if (existsSync(interSrc)) cpSync(interSrc, interDst, { recursive: true });
    // Force LF on copied text files.
    (function lf(d: string) {
      for (const f of readdirSync(d)) {
        const p = path.join(d, f);
        if (statSync(p).isDirectory()) lf(p);
        else if (TEXT_SUFFIXES.includes(path.extname(p))) writeFileSync(p, normBytes(p));
      }
    })(interDst);
    actions.push({ tool, action: `synced → ${dir}` });
  }
  return actions;
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
      if (!dryRun) rmSync(p, { force: true });
      retired.push(f);
    }
  }
  return { copied, retired };
}
