#!/usr/bin/env node
/**
 * bh — eval JS in the persistent CDP REPL. Auto-starts the REPL on first use.
 * (bin of the browser-harness-ts package)
 *
 * Usage:
 *   bh 'await session.connect({wsUrl:"ws://127.0.0.1:9222/devtools/browser/<id>"})'
 *   bh 'await session.Page.navigate({url:"https://example.com"})'
 *   bh <<'EOF'
 *     const t = await listPageTargets();
 *     globalThis.tid = t[0].targetId;
 *     await session.use(globalThis.tid);
 *     return globalThis.tid;
 *   EOF
 *
 *   bh --status   # is the REPL running? prints health JSON
 *   bh --stop     # gracefully shut it down
 *   bh --logs     # stream the server log
 *   bh --restart  # stop + start fresh (drops session state) — write op: needs --yes
 *   bh --start    # explicit start (no-op if already running)
 *
 * Structured commands (sessions/rmux/dashboard/doctor/skill/record/video/run)
 * go through Commander (D29); the bare-snippet and plugin-routing paths keep
 * the original hand-rolled passthrough (agent/plugin contract unchanged).
 * Write ops (--restart, skill sync) default to dry-run; --yes executes.
 * Exit codes (G002 contract): 0 ok, 1 fail, 2 usage, 3 not-found.
 */

import { readFileSync, appendFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { z } from 'zod';
import { derivedPort, instanceName, logFile } from './paths.js';
import { homeDir, dataDir } from './paths.js';
import { envNumber } from './env.js';

// Materialize the resolved BH_HOME into env so spawned daemons and in-process
// plugins (which cannot replicate dev-checkout detection) agree with us.
process.env.BH_HOME = process.env.BH_HOME ?? homeDir();

let PORT = String(process.env.CDP_REPL_PORT ?? derivedPort());
const HOST = '127.0.0.1';
let URL_ = `http://${HOST}:${PORT}`;
let LOG = process.env.CDP_REPL_LOG ?? logFile(instanceName());
const REPL = fileURLToPath(new URL('./repl.js', import.meta.url));

/** Exit-code contract (G002 退出码表): 0 ok / 1 fail / 2 usage / 3 not-found. */
const EXIT = { ok: 0, fail: 1, usage: 2, notFound: 3 } as const;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function die(msg: string): never {
  process.stderr.write(`bh: ${msg}\n`);
  process.exit(EXIT.fail);
}

async function isUp(): Promise<boolean> {
  try {
    const res = await fetch(`${URL_}/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function healthJson(): Promise<string> {
  try {
    const res = await fetch(`${URL_}/health`);
    return (await res.text()).trim();
  } catch {
    return '{"ok":false,"error":"down"}';
  }
}

async function startRepl(): Promise<void> {
  if (await isUp()) return;
  const { ensureDaemon } = await import('./admin.js');
  try {
    await ensureDaemon();
    return;
  } catch (e: any) {
    let tail = '';
    try {
      const text = await readFile(LOG, 'utf8');
      const lines = text.split(/\r?\n/).filter(Boolean).slice(-20);
      if (lines.length > 0) tail = `\n--- last ${lines.length} log lines ---\n${lines.join('\n')}`;
    } catch { /* log unreadable; path alone will have to do */ }
    die(`${String(e?.message ?? e)}${tail}`);
  }
}

/**
 * POST the snippet, print result. Body goes to stdout (only if non-empty)
 * on 200; otherwise to stderr with non-zero exit.
 */
async function postEval(code: string): Promise<void> {
  const timeoutS = envNumber('BH_EVAL_TIMEOUT', 300);
  const url = `${URL_}/eval?timeout=${timeoutS}`;
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', body: code, signal: AbortSignal.timeout((timeoutS + 5) * 1000) });
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (/aborted|timeout|TimeoutError/i.test(msg) || e?.name === 'TimeoutError') {
      process.stderr.write(`bh: /eval 请求超时（${timeoutS}s）。求值可能仍在 daemon 上运行；要停掉请 \`bh --restart\`。BH_EVAL_TIMEOUT=秒 可改超时。\n`);
    } else {
      process.stderr.write(`bh: ${msg}（daemon 无响应？先 bh doctor / bh --status）\n`);
    }
    process.exit(EXIT.fail);
  }
  const body = await res.text();
  if (res.status === 200) {
    if (body.length > 0) process.stdout.write(body.endsWith('\n') ? body : body + '\n');
    process.exit(EXIT.ok);
  } else {
    if (body.length > 0) process.stderr.write(body.endsWith('\n') ? body : body + '\n');
    process.exit(EXIT.fail);
  }
}

async function stopRepl(): Promise<void> {
  if (await isUp()) {
    try { await fetch(`${URL_}/quit`, { method: 'POST' }); } catch { /* already gone */ }
    console.log('{"ok":true,"stopped":true}');
  } else {
    console.log('{"ok":true,"stopped":false,"note":"already down"}');
  }
}

/** tail -f equivalent: print the file, then stream appended bytes until Ctrl-C. */
async function tailLog(): Promise<void> {
  let size = 0;
  try {
    size = (await stat(LOG)).size;
    process.stdout.write(await readFile(LOG, 'utf8'));
  } catch {
    die(`cannot read log ${LOG}`);
  }
  for (;;) {
    await sleep(300);
    let now: number;
    try {
      now = (await stat(LOG)).size;
    } catch {
      continue; // vanished mid-poll; keep waiting
    }
    if (now === size) continue;
    try {
      if (now < size) {
        // truncated (e.g. a fresh server start with 'w') — reprint from the top
        size = 0;
        process.stdout.write(await readFile(LOG, 'utf8'));
        size = (await stat(LOG)).size;
      } else {
        const text = await readFile(LOG, 'utf8');
        process.stdout.write(text.slice(size));
        size = now;
      }
    } catch {
      continue;
    }
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Identity must land in env BEFORE anything derives ports/paths from it. */
function applyIdentity(): void {
  PORT = String(process.env.CDP_REPL_PORT ?? derivedPort());
  URL_ = `http://${HOST}:${PORT}`;
  LOG = process.env.CDP_REPL_LOG ?? logFile(instanceName());
}

/**
 * Write-op guard (D29): without --yes a write op only prints its plan — the
 * CLI is read-only by default. --dry-run is the explicit spelling of the
 * same; --yes + --dry-run together still only prints.
 */
function guardWrite(label: string, opts: { yes?: boolean | undefined; dryRun?: boolean | undefined }): boolean {
  if (opts.yes && !opts.dryRun) return true;
  console.log(`[dry-run] ${label}${opts.dryRun ? '' : '（--yes 执行）'}`);
  return false;
}

/** Global write-op flags shared by the top level and skill sync (Zod-checked). */
const WriteOpts = z.object({
  yes: z.boolean().optional(),
  dryRun: z.boolean().optional(),
});

/**
 * One app-run record appended to <BH_HOME>/data/app-runs.jsonl — the
 * platform-level run ledger every app gets for free (no app changes). File
 * rotates at ~2MB keeping the tail. Telemetry must never break the run.
 */
function recordAppRun(app: string, argv: string[], code: number, ms: number, log: string[]): void {
  try {
    const file = path.join(dataDir(), 'app-runs.jsonl');
    mkdirSync(dataDir(), { recursive: true });
    try {
      if (statSync(file).size > 2_000_000) {
        const tail = readFileSync(file, 'utf8').slice(-1_000_000);
        writeFileSync(file, tail.slice(tail.indexOf('\n') + 1) + '\n');
      }
    } catch { /* fresh file */ }
    appendFileSync(file, JSON.stringify({
      ts: new Date().toISOString(), app, argv: argv.join(' ').slice(0, 160),
      code, ms: Math.round(ms), log: log.slice(-12),
    }) + '\n');
  } catch { /* best-effort */ }
}

/** Load and run a plugin with the runner-injected ctx (remote-host helpers). */
async function runPlugin(name: string, args: string[]): Promise<void> {
  const { loadPlugin } = await import('./plugins.js');
  const plugin = await loadPlugin(name);
  if (!plugin) { process.stderr.write(`bh: no plugin "${name}" in <workspace>/apps/${name}.mjs\n`); process.exit(EXIT.fail); }
  const { remoteHost } = await import('./remote.js');
  const { createHelpers } = await import('./helpers.js');
  const { createBrowserHelpers } = await import('./browser_helpers.js');
  const { ensureDaemon } = await import('./admin.js');
  // selfManaged plugins (x-intel) bring up and supervise their OWN daemon —
  // pre-ensuring the DEFAULT daemon here would spawn it and let its
  // marker-first attach policy steal the app's tab.
  if (!(plugin as { selfManaged?: boolean }).selfManaged) {
    await ensureDaemon().catch((e: any) => {
      process.stderr.write(`bh: ${String(e?.message ?? e)}\n`);
      process.exit(EXIT.fail);
    });
  }
  const host = remoteHost(Number(PORT));
  const helpers = createHelpers(host);
  const browserHelpers = createBrowserHelpers(helpers as any);
  // tee stderr so the run ledger keeps the app's own log lines.
  const log: string[] = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  (process.stderr.write as any) = (chunk: any, ...rest: any[]) => {
    try { for (const l of String(chunk).split(/\r?\n/)) if (l.trim()) log.push(l.slice(0, 200)); } catch { /* keep going */ }
    return (origWrite as any)(chunk, ...rest);
  };
  const t0 = Date.now();
  let code: number;
  try {
    code = await plugin.main(args, { helpers: helpers as any, browserHelpers: browserHelpers as any });
  } catch (e: any) {
    (process.stderr.write as any)(`bh: ${String(e?.stack ?? e)}\n`);
    code = EXIT.fail;
  } finally {
    (process.stderr.write as any) = origWrite;
  }
  recordAppRun(name, args, typeof code === 'number' ? code : 0, Date.now() - t0, log);
  process.exit(typeof code === 'number' ? code : EXIT.ok);
}

/**
 * Legacy passthrough — the ORIGINAL default path, unchanged (agent/plugin
 * contract): a bare JS snippet, or unknown-word plugin routing with raw args.
 */
async function legacyPassthrough(argv: string[]): Promise<void> {
  const arg = argv[0]!;
  if (/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(arg)) {
    const { pluginPath } = await import('./plugins.js');
    if (pluginPath(arg)) {
      await runPlugin(arg, argv.slice(1));
      return;
    }
  }
  await startRepl();
  await postEval(arg);
}

// --- structured commands (Commander, D29) -------------------------------------

const KNOWN_COMMANDS = new Set(['sessions', 'rmux', 'dashboard', 'doctor', 'skill', 'skills', 'record', 'video', 'run']);

function pkgVersion(): string {
  return (JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version: string }).version;
}

function buildProgram(): Command {
  const program = new Command();
  program
    .name('bh')
    .description('eval JS in the persistent CDP REPL; auto-starts the daemon on first use')
    .version(pkgVersion())
    .option('--status', 'print daemon health JSON')
    .option('--start', 'explicit start (no-op if already running)')
    .option('--stop', 'graceful shutdown (idempotent)')
    .option('--restart', 'stop + start fresh, drops session state (write op: needs --yes)')
    .option('--logs', 'stream the daemon log')
    .option('--new-tab', 'open a fresh about:blank tab, attach, run the snippet there (tab stays)')
    .option('-n, --dry-run', 'write ops only print what they would do')
    .option('-y, --yes', 'write ops execute (default is dry-run)')
    // Unknown options pass through untouched — the bare-snippet path may
    // carry anything, and structured commands parse their own flags strictly.
    .allowUnknownOption()
    .exitOverride((err: { code?: string; message?: unknown; exitCode?: number }) => {
      if (err.code === 'commander.help' || err.code === 'commander.version' || err.code === 'commander.helpDisplayed') {
        process.exit(err.exitCode ?? EXIT.ok);
      }
      // Usage/argument errors are exit 2 (G002), never 1. Commander already
      // printed the error line to stderr ("error: ..."); only fix the code.
      process.exit(EXIT.usage);
    });

  program.action(async (operands: string[]) => {
    const raw = program.opts<Record<string, unknown>>();
    const flags = WriteOpts.parse(raw);
    if (raw['status'] !== undefined) {
      if (await isUp()) {
        console.log(await healthJson());
      } else {
        console.log('{"ok":false,"error":"down"}');
        process.exit(EXIT.fail);
      }
      return;
    }
    if (raw['start'] !== undefined) {
      await startRepl();
      console.log(await healthJson());
      return;
    }
    if (raw['stop'] !== undefined) {
      await stopRepl();
      return;
    }
    if (raw['restart'] !== undefined) {
      if (!guardWrite(`restart ${instanceName()} daemon (${URL_})，会丢弃会话状态`, flags)) return;
      if (await isUp()) {
        try { await fetch(`${URL_}/quit`, { method: 'POST' }); } catch { /* already gone */ }
      }
      await sleep(200);
      await startRepl();
      console.log(await healthJson());
      return;
    }
    if (raw['logs'] !== undefined) {
      await tailLog();
      return;
    }
    if (raw['newTab'] !== undefined) {
      // Explicit-new-tab primitive: open about:blank, attach the session to it,
      // then run the snippet there. The tab stays open after. (postEval exits
      // the process per call, so this is ONE composite snippet.)
      await startRepl();
      const code = operands[0] ?? await readStdin();
      await postEval(`const __bh_new_tab = await session.domains.Target.createTarget({ url: 'about:blank' }); await session.use(__bh_new_tab.targetId);\n${code}`);
      return;
    }
    // No flag, no subcommand: bare snippet from argv (flag-combos) or stdin.
    if (operands.length > 0) {
      await startRepl();
      await postEval(operands.join('\n'));
      return;
    }
    // The bash version blocked reading a TTY stdin forever; fail fast instead.
    if (process.stdin.isTTY) program.help();
    await startRepl();
    await postEval(await readStdin());
  });

  program.command('sessions')
    .description('object model + live inventory: instances, daemons, tab tables')
    .action(async () => {
      const { runSessions } = await import('./admin.js');
      console.log(JSON.stringify(await runSessions(), null, 1));
    });

  program.command('rmux')
    .description('rmux supervision plane: install, daemon, session/pane tree')
    .action(async () => {
      const { Rmux } = await import('./rmux.js');
      console.log(JSON.stringify(await new Rmux().status(), null, 1));
    });

  program.command('dashboard')
    .description('read-only web board (SSE) on 127.0.0.1')
    .argument('[sub]', 'start | stop | status')
    .action(async (sub: string | undefined) => {
      // Read-only board: instances / attach surface / rmux supervision /
      // worker heartbeat / page verdicts / resident apps.
      sub = sub ?? 'start';
      const { DASHBOARD_PORT } = await import('./dashboard.js');
      const URLD = `http://127.0.0.1:${DASHBOARD_PORT}`;
      const alive = async () => {
        try { const r = await fetch(URLD, { signal: AbortSignal.timeout(1000) }); return r.ok; } catch { return false; }
      };
      if (sub === 'stop') {
        // No /quit endpoint by design (read-only); kill via registry-free port probe is
        // out of scope — tell the operator the PID instead.
        const { spawnSync } = await import('node:child_process');
        const r = spawnSync('powershell', ['-NoProfile', '-Command',
          `Get-NetTCPConnection -LocalPort ${DASHBOARD_PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess`],
          { timeout: 8000, windowsHide: true, encoding: 'utf8' });
        const pid = Number(String(r.stdout ?? '').trim());
        if (Number.isInteger(pid) && pid > 0) {
          try { process.kill(pid, 'SIGTERM'); console.log(`dashboard (pid ${pid}) stopped`); } catch { console.log(`dashboard pid ${pid} not killable`); }
        } else {
          console.log('dashboard not running');
        }
        return;
      }
      if (sub === 'status') {
        console.log(JSON.stringify({ running: await alive(), url: URLD }));
        return;
      }
      // start (idempotent, detached)
      if (await alive()) { console.log(`dashboard already up: ${URLD}`); return; }
      const { spawn } = await import('node:child_process');
      const { openSync, closeSync } = await import('node:fs');
      const { tmpDir } = await import('./paths.js');
      const log = openSync(path.join(tmpDir(), 'dashboard.log'), 'w');
      const child = spawn(process.execPath, [fileURLToPath(new URL('./dashboard.js', import.meta.url))],
        { detached: true, windowsHide: true, stdio: ['ignore', log, log], env: { ...process.env, BH_HOME: process.env.BH_HOME ?? '' } });
      child.unref();
      closeSync(log);
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        await sleep(200);
        if (await alive()) { console.log(`dashboard up: ${URLD}`); return; }
      }
      process.stderr.write(`bh: dashboard did not come up — check ${path.join(tmpDir(), 'dashboard.log')}\n`);
      process.exit(EXIT.fail);
    });

  program.command('doctor')
    .description('diagnose the local install (daemon, browser attach, assets)')
    .option('--json', 'machine-readable report')
    .option('--require-existing-daemon', 'fail if no daemon is running')
    .action(async (opts: { json?: boolean; requireExistingDaemon?: boolean }) => {
      const { runDoctor } = await import('./admin.js');
      const r = await runDoctor({ requireExistingDaemon: opts.requireExistingDaemon === true });
      if (opts.json) {
        console.log(JSON.stringify({ schema_version: 1, healthy: r.healthy, ...r.header, checks: r.checks }));
      } else {
        for (const [k, v] of Object.entries(r.header)) console.log(`${k.padEnd(10)} ${v}`);
        for (const c of r.checks) console.log(`${c.ok ? '  [ok  ]' : '  [FAIL]'} ${c.name} — ${c.detail}`);
      }
      process.exit(r.healthy ? EXIT.ok : EXIT.fail);
    });

  program.command('skill')
    .alias('skills')
    .description('skill/asset distribution: status | sync')
    .argument('[sub]', 'status | sync')
    .option('-n, --dry-run', 'sync only prints what it would copy')
    .option('-y, --yes', 'sync executes (default is dry-run)')
    .action(async (sub: string | undefined, opts: { dryRun?: boolean; yes?: boolean }) => {
      const s = sub ?? 'status';
      const { skillStatus, skillSync, provisionWorkspace } = await import('./skills.js');
      const { workspaceDir } = await import('./paths.js');
      if (s === 'sync') {
        // Write op (D29): without --yes only the plan is printed.
        const guard = WriteOpts.parse(opts);
        const dryRun = !guard.yes || guard.dryRun === true;
        for (const a of skillSync(dryRun)) console.log(`${a.tool.padEnd(8)} ${a.action}`);
        const prov = provisionWorkspace(workspaceDir(), dryRun);
        console.log(`workspace ${dryRun ? 'would copy' : 'copied'} ${prov.copied.length} file(s)${prov.retired.length ? `, retired ${prov.retired.length}` : ''}`);
        prov.copied.slice(0, 5).forEach(f => console.log(`  + ${f}`));
        if (prov.copied.length > 5) console.log(`  … ${prov.copied.length - 5} more`);
      } else if (s === 'status') {
        for (const st of skillStatus()) {
          console.log(`${st.state.padEnd(14)} ${st.tool.padEnd(8)} ${st.dir}${st.hash ? `  (${st.hash})` : ''}`);
        }
      } else {
        process.stderr.write('bh: usage: bh skill status|sync [--dry-run] [--yes]\n');
        process.exit(EXIT.usage);
      }
      process.exit(EXIT.ok);
    });

  program.command('record')
    .description('per-action frame recording: enable|disable|start|stop|status')
    .argument('[sub]', 'enable | disable | start | stop | status')
    .action(async (sub: string | undefined) => {
      if (sub === 'enable') { (await import('./recorder.js')).setRecordingPref(true); console.log('recording pref: enabled'); return; }
      if (sub === 'disable') { (await import('./recorder.js')).setRecordingPref(false); console.log('recording pref: disabled'); return; }
      if (sub === 'start') {
        await startRepl();
        await postEval('start_recording()');
        return;
      }
      if (sub === 'stop') { await postEval('stop_recording()'); return; }
      // status
      const { recordingEnabled, activeRecordingDir } = await import('./recorder.js');
      console.log(JSON.stringify({ enabled: recordingEnabled(), dir: activeRecordingDir() ?? null }));
    });

  program.command('video')
    .description('recording pipeline: init|export|review <recording-dir>')
    .argument('<sub>', 'init | export | review')
    .argument('[recDir]', 'recording directory')
    .option('--brief <path>', 'edit brief JSON (default <recDir>/edit-brief.json)')
    .option('--out <path>', 'output path (default <recDir>/video.mp4)')
    .action(async (sub: string, recDir: string | undefined, opts: { brief?: string; out?: string }) => {
      const video = await import('./video.js');
      if (sub === 'init' && recDir) {
        const r = video.videoInit(recDir);
        console.log(`manifest written: ${r.manifest} (${r.frames} frames)`);
        return;
      }
      if (sub === 'export' && recDir) {
        const briefPath = opts.brief ?? path.join(recDir, 'edit-brief.json');
        const brief = JSON.parse(readFileSync(briefPath, 'utf8'));
        const out = opts.out ?? path.join(recDir, 'video.mp4');
        const r = video.exportVideo(recDir, brief, out);
        console.log(r.mode === 'mp4' ? `exported: ${r.path}` : `ffmpeg missing — HTML slideshow written instead: ${r.path}`);
        return;
      }
      if (sub === 'review' && recDir) {
        const briefPath = opts.brief ?? path.join(recDir, 'edit-brief.json');
        const brief = JSON.parse(readFileSync(briefPath, 'utf8'));
        const sheet = video.reviewContactSheet(recDir, brief);
        console.log(sheet ? `contact sheet: ${sheet}` : 'contact sheet unavailable (needs ffmpeg)');
        return;
      }
      process.stderr.write('bh: usage: bh video init|export|review <recording-dir> [--brief path] [--out path]\n');
      process.exit(EXIT.usage);
    });

  program.command('run')
    .description('run a plugin app with raw args')
    .argument('<name>', 'plugin name (workspace/apps/<name>.mjs)')
    .argument('[args...]', 'raw args forwarded to the app')
    .allowUnknownOption() // app flags are the app's own contract
    .allowExcessArguments()
    .action(async (name: string, args: string[]) => {
      await runPlugin(name, args);
    });

  return program;
}

async function main(): Promise<void> {
  // bh needs the built-in WebSocket client.
  const nodeMajor = Number((process.versions.node.split('.')[0] ?? '0'));
  if (!(nodeMajor >= 22)) die(`Node >= 22 required (found ${process.versions.node}) — bh relies on Node's built-in WebSocket client`);
  // `--name <instance>` — set the bh instance identity BEFORE anything derives
  // ports/paths from it (guardian apps like page-detect watch run as their own
  // named daemon instance, x-monitor style). Eaten from argv so dispatch never
  // sees it. (Hand-stripped pre-Commander: it may appear anywhere in argv.)
  const argv = process.argv.slice(2);
  const nameIdx = argv.indexOf('--name');
  if (nameIdx >= 0 && argv[nameIdx + 1]) {
    process.env.BH_NAME = argv[nameIdx + 1];
    argv.splice(nameIdx, 2);
  }
  applyIdentity();

  // Legacy passthrough keeps the ORIGINAL path for bare snippets and plugin
  // routing (e.g. `bh google-search <q> --top 5`) — zero interface change for
  // the agent/plugin contract; Commander never mangles those args.
  const first = argv[0];
  if (first !== undefined && !first.startsWith('-') && !KNOWN_COMMANDS.has(first)) {
    await legacyPassthrough(argv);
    return;
  }
  await buildProgram().parseAsync(argv, { from: 'user' });
}

await main();
