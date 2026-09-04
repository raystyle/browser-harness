/**
 * rmux CLI driver — deliberately NOT the official SDK.
 *
 * @rmux/sdk 0.6.1 is locked to rmux 0.6.x while machines run 0.10.0; its
 * start-server is a no-op on Windows and its default socket name embeds a
 * per-process hash, so cross-process discovery fails. We spawn the `rmux`
 * executable directly with a fixed `-L <label>` so the session daemon is
 * reachable from every process, and kill-server only ever touches our label.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export const DEFAULT_LABEL = 'browser-harness';

/** Preferred binary: our own install dir first (bind one deterministic binary), then PATH. */
export function rmuxBinary(): string | null {
  if (process.platform === 'win32') {
    const local = path.join(process.env['LOCALAPPDATA'] ?? '', 'rmux', 'bin', 'rmux.exe');
    const alt = path.join(process.env['LOCALAPPDATA'] ?? '', 'rmux', 'rmux.exe');
    for (const c of [local, alt]) {
      if (existsSync(c)) {
        try {
          const r = spawnSync(c, ['-V'], { timeout: 5000, windowsHide: true, encoding: 'utf8' });
          if (String(r.stdout ?? '').trim()) return c;
        } catch { /* keep looking */ }
      }
    }
  }
  try {
    const r = spawnSync('rmux', ['-V'], { timeout: 5000, windowsHide: true, encoding: 'utf8' });
    if (r.status === 0 && String(r.stdout ?? '').trim()) return 'rmux';
  } catch { /* not installed */ }
  return null;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export class Rmux {
  readonly label: string;
  private readonly bin: string | null;

  constructor(label = process.env.BH_RMUX_LABEL ?? DEFAULT_LABEL) {
    this.label = label;
    this.bin = rmuxBinary();
  }

  /** Installed version string, or null when rmux is missing. */
  version(): string | null {
    if (!this.bin) return null;
    try {
      const r = spawnSync(this.bin, ['-V'], { timeout: 5000, windowsHide: true, encoding: 'utf8' });
      return String(r.stdout ?? '').trim() || null;
    } catch {
      return null;
    }
  }

  private async run(args: string[], opts: { timeoutMs?: number } = {}): Promise<{ code: number; out: string; err: string }> {
    const bin = this.bin;
    if (!bin) throw new Error('rmux is not installed — get it from https://github.com/Helvesec/rmux/releases and put it on PATH (Windows: %LOCALAPPDATA%\\rmux)');
    return await new Promise((resolve, reject) => {
      const p: ChildProcess = spawn(bin, ['-L', this.label, ...args], { windowsHide: true });
      const timer = setTimeout(() => { try { p.kill(); } catch { /* already gone */ } }, opts.timeoutMs ?? 15_000);
      let out = '', err = '';
      p.stdout?.on('data', (d: Buffer) => { out += d; });
      p.stderr?.on('data', (d: Buffer) => { err += d; });
      p.on('error', e => { clearTimeout(timer); reject(e); });
      p.on('close', code => { clearTimeout(timer); resolve({ code: code ?? -1, out: out.trim(), err: err.trim() }); });
    });
  }

  /** new-session must be detached: the daemon inherits our pipes otherwise. */
  private spawnDetached(args: string[]): void {
    if (!this.bin) throw new Error('rmux is not installed — get it from https://github.com/Helvesec/rmux/releases');
    const p = spawn(this.bin, ['-L', this.label, ...args], {
      detached: true, windowsHide: true, stdio: 'ignore',
    });
    p.unref();
  }

  async listSessions(): Promise<string[]> {
    const r = await this.run(['list-sessions', '-F', '#{session_name}']);
    if (r.code !== 0) return [];
    return r.out.split('\n').map(s => s.trim()).filter(Boolean);
  }

  async listPanes(): Promise<string[]> {
    const r = await this.run(['list-panes', '-a', '-F', '#{session_name}|#{window_index}.#{pane_index}|#{pane_current_command}']);
    if (r.code !== 0) return [];
    return r.out.split('\n').filter(Boolean);
  }

  async hasSession(name: string): Promise<boolean> {
    const r = await this.run(['has-session', '-t', name]);
    return r.code === 0;
  }

  async newSession(name: string, opts: { command?: string; cwd?: string } = {}): Promise<void> {
    const args = ['new-session', '-d', '-s', name];
    if (opts.cwd) args.push('-c', opts.cwd);
    if (opts.command) args.push(opts.command);
    this.spawnDetached(args);
  }

  async killSession(name: string): Promise<void> {
    await this.run(['kill-session', '-t', name]);
  }

  /** Only our label's daemon — other tmux/rmux users are never touched. */
  async killServer(): Promise<void> {
    await this.run(['kill-server']);
  }

  async sendKeys(target: string, keys: string, opts: { literal?: boolean } = {}): Promise<void> {
    const args = ['send-keys', '-t', target];
    if (opts.literal) args.push('-l');
    args.push(keys);
    await this.run(args);
  }

  async capturePane(target: string): Promise<string> {
    const r = await this.run(['capture-pane', '-p', '-t', target]);
    return r.out;
  }

  /** has → new → poll has every 0.2s until readyTimeout. */
  async ensureSession(name: string, opts: { command?: string; cwd?: string; readyTimeout?: number } = {}): Promise<boolean> {
    if (await this.hasSession(name)) return true;
    await this.newSession(name, opts);
    const deadline = Date.now() + (opts.readyTimeout ?? 10) * 1000;
    while (Date.now() < deadline) {
      await sleep(200);
      if (await this.hasSession(name)) return true;
    }
    throw new Error(`rmux session "${name}" not ready after ${opts.readyTimeout ?? 10}s`);
  }
}
