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
 *   bh --restart  # stop + start fresh (drops session state)
 *   bh --start    # explicit start (no-op if already running)
 */

import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { derivedPort, instanceName, logFile } from './paths.js';
import { applyFromArgv } from './taskIsolation.js';
import { homeDir } from './paths.js';

// Materialize the resolved BH_HOME into env so spawned daemons and in-process
// plugins (which cannot replicate dev-checkout detection) agree with us.
process.env.BH_HOME = process.env.BH_HOME ?? homeDir();

const PORT = String(process.env.CDP_REPL_PORT ?? derivedPort());
const HOST = '127.0.0.1';
const URL_ = `http://${HOST}:${PORT}`;
const LOG = process.env.CDP_REPL_LOG ?? logFile(instanceName());
const REPL = fileURLToPath(new URL('./repl.js', import.meta.url));

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function die(msg: string): never {
  process.stderr.write(`bh: ${msg}\n`);
  process.exit(1);
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
  let res: Response;
  try {
    res = await fetch(`${URL_}/eval`, { method: 'POST', body: code });
  } catch (e: any) {
    process.stderr.write(`bh: ${e?.message ?? e}\n`);
    process.exit(1);
  }
  const body = await res.text();
  if (res.status === 200) {
    if (body.length > 0) process.stdout.write(body.endsWith('\n') ? body : body + '\n');
    process.exit(0);
  } else {
    if (body.length > 0) process.stderr.write(body.endsWith('\n') ? body : body + '\n');
    process.exit(1);
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

function usage(): never {
  const lines = [
    'bh — eval JS in the persistent CDP REPL. Auto-starts the REPL on first use.',
    '',
    'Usage:',
    "  bh 'await session.connect({wsUrl:\"ws://127.0.0.1:9222/devtools/browser/<id>\"})'",
    "  bh 'await session.Page.navigate({url:\"https://example.com\"})'",
    '  bh <<EOF ... EOF        (multi-statement snippet from stdin; use explicit `return`)',
    '',
    '  bh --status   # is the REPL running? prints health JSON',
    '  bh --start    # explicit start (no-op if already running)',
    '  bh --stop     # gracefully shut it down',
    '  bh --restart  # stop + start fresh (drops session state)',
    '  bh --logs     # stream the server log',
    '',
    '  bh sessions   # object model + live inventory: instances, daemons, tab tables',
    '  bh rmux       # rmux supervision plane: install, daemon, session/pane tree',
    "  bh --new-tab '<js>'  # open a fresh about:blank tab, attach, run there (tab stays)",
    '',
    `Env: CDP_REPL_PORT (default 9876), CDP_REPL_LOG (default ${LOG}).`,
    'Requires Node >= 22 (native WebSocket).',
  ];
  process.stdout.write(lines.join('\n') + '\n');
  process.exit(0);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  // Task isolation MUST run first — it pins BH_NAME/port/profile before
  // anything derives endpoints from them.
  const argv = process.argv.slice(2);
  const taskStack = await applyFromArgv(argv);
  const arg = argv[0] === '--once' || argv[0] === '--batch' ? argv[1] : argv[0];

  try {
    await dispatch(arg, argv);
  } finally {
    if (taskStack) {
      // Chrome BEFORE daemon (Browser.close needs a live daemon); isolated
      // tasks stop their browser unconditionally.
      try { const ac = await import('./agentChrome.js'); await ac.stopAgentChrome(); } catch { /* best-effort */ }
      await stopRepl().catch(() => {});
      await taskStack.teardown();
    }
  }
}

/** Load and run a plugin with the runner-injected ctx (remote-host helpers). */
async function runPlugin(name: string, args: string[]): Promise<void> {
  const { loadPlugin } = await import('./plugins.js');
  const plugin = await loadPlugin(name);
  if (!plugin) { process.stderr.write(`bh: no plugin "${name}" in <workspace>/apps/${name}.mjs\n`); process.exit(1); }
  const { remoteHost } = await import('./remote.js');
  const { createHelpers } = await import('./helpers.js');
  const { createBrowserHelpers } = await import('./browser_helpers.js');
  const { ensureDaemon } = await import('./admin.js');
  await ensureDaemon().catch((e: any) => {
    process.stderr.write(`bh: ${String(e?.message ?? e)}\n`);
    process.exit(1);
  });
  const host = remoteHost(Number(PORT));
  const helpers = createHelpers(host);
  const browserHelpers = createBrowserHelpers(helpers as any);
  const code = await plugin.main(args, { helpers: helpers as any, browserHelpers: browserHelpers as any });
  process.exit(typeof code === 'number' ? code : 0);
}

async function dispatch(arg: string | undefined, argv: string[]): Promise<void> {
  if (argv[0] === '--once') {
    await startRepl();
    const code = argv[1] ?? await readStdin();
    await postEval(code);
    return;
  }
  if (argv[0] === '--new-tab') {
    // Explicit-new-tab primitive: open about:blank, attach the session to it,
    // then run the snippet there. The tab stays open after. (postEval exits
    // the process per call, so this is ONE composite snippet.)
    await startRepl();
    const code = argv[1] ?? await readStdin();
    await postEval(`const __bh_new_tab = await session.domains.Target.createTarget({ url: 'about:blank' }); await session.use(__bh_new_tab.targetId);\n${code}`);
    return;
  }
  if (argv[0] === 'sessions') {
    const { runSessions } = await import('./admin.js');
    console.log(JSON.stringify(await runSessions(), null, 1));
    return;
  }
  if (argv[0] === 'rmux') {
    // Probe the rmux supervision plane: install, daemon liveness, session/pane tree.
    const { Rmux } = await import('./rmux.js');
    console.log(JSON.stringify(await new Rmux().status(), null, 1));
    return;
  }
  if (argv[0] === '--batch') {
    const src = argv[1] === '-' || argv[1] === undefined ? await readStdin()
      : await readFile(argv[1]!, 'utf8');
    await startRepl();
    let failed = 0;
    for (const line of src.split(/\r?\n/)) {
      const code = line.trim();
      if (!code || code.startsWith('#')) continue;
      try { await postEval(code); } catch { failed++; }
    }
    process.exit(failed > 0 ? 1 : 0);
    return;
  }
  switch (arg) {
    case '--status': {
      if (await isUp()) {
        console.log(await healthJson());
      } else {
        console.log('{"ok":false,"error":"down"}');
        process.exit(1);
      }
      return;
    }
    case '--start':
      await startRepl();
      console.log(await healthJson());
      return;
    case '--stop':
      await stopRepl();
      return;
    case '--restart': {
      if (await isUp()) {
        try { await fetch(`${URL_}/quit`, { method: 'POST' }); } catch { /* already gone */ }
      }
      await sleep(200);
      await startRepl();
      console.log(await healthJson());
      return;
    }
    case '--logs':
      await tailLog();
      return;
    case '--version': {
      const { readFileSync } = await import('node:fs');
      const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version: string };
      console.log(pkg.version);
      process.exit(0);
      return;
    }
    case 'doctor': {
      const flags = process.argv.slice(3);
      const { runDoctor } = await import('./admin.js');
      const r = await runDoctor({ requireExistingDaemon: flags.includes('--require-existing-daemon') });
      if (flags.includes('--json')) {
        console.log(JSON.stringify({ schema_version: 1, healthy: r.healthy, ...r.header, checks: r.checks }));
      } else {
        for (const [k, v] of Object.entries(r.header)) console.log(`${k.padEnd(10)} ${v}`);
        for (const c of r.checks) console.log(`${c.ok ? '  [ok  ]' : '  [FAIL]'} ${c.name} — ${c.detail}`);
      }
      process.exit(r.healthy ? 0 : 1);
      return;
    }
    case 'chrome-mode': {
      const mode = process.argv[3];
      if (mode !== 'on' && mode !== 'off' && mode !== 'status') {
        process.stderr.write('bh: usage: bh chrome-mode on|off|status\n');
        process.exit(2);
      }
      const { runChromeMode } = await import('./admin.js');
      process.exit(await runChromeMode(mode));
      return;
    }
    case 'skill':
    case 'skills': {
      const sub = argv[1] ?? 'status';
      const dryRun = argv.includes('--dry-run');
      const { skillStatus, skillSync, provisionWorkspace } = await import('./skills.js');
      const { workspaceDir } = await import('./paths.js');
      if (sub === 'sync') {
        for (const a of skillSync(dryRun)) console.log(`${a.tool.padEnd(8)} ${a.action}`);
        const prov = provisionWorkspace(workspaceDir(), dryRun);
        console.log(`workspace ${dryRun ? 'would copy' : 'copied'} ${prov.copied.length} file(s)${prov.retired.length ? `, retired ${prov.retired.length}` : ''}`);
        prov.copied.slice(0, 5).forEach(f => console.log(`  + ${f}`));
        if (prov.copied.length > 5) console.log(`  … ${prov.copied.length - 5} more`);
      } else if (sub === 'status') {
        for (const s of skillStatus()) {
          console.log(`${s.state.padEnd(14)} ${s.tool.padEnd(8)} ${s.dir}${s.hash ? `  (${s.hash})` : ''}`);
        }
      } else {
        process.stderr.write('bh: usage: bh skill status|sync [--dry-run]\n');
        process.exit(2);
      }
      process.exit(0);
      return;
    }
    case 'record': {
      const sub = argv[1];
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
      return;
    }
    case 'video': {
      const sub = argv[1];
      const recDir = argv[2];
      const val = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
      const video = await import('./video.js');
      if (sub === 'init' && recDir) {
        const r = video.videoInit(recDir);
        console.log(`manifest written: ${r.manifest} (${r.frames} frames)`);
        return;
      }
      if (sub === 'export' && recDir) {
        const briefPath = val('--brief') ?? path.join(recDir, 'edit-brief.json');
        const brief = JSON.parse(readFileSync(briefPath, 'utf8'));
        const out = val('--out') ?? path.join(recDir, 'video.mp4');
        const r = video.exportVideo(recDir, brief, out);
        console.log(r.mode === 'mp4' ? `exported: ${r.path}` : `ffmpeg missing — HTML slideshow written instead: ${r.path}`);
        return;
      }
      if (sub === 'review' && recDir) {
        const briefPath = val('--brief') ?? path.join(recDir, 'edit-brief.json');
        const brief = JSON.parse(readFileSync(briefPath, 'utf8'));
        const sheet = video.reviewContactSheet(recDir, brief);
        console.log(sheet ? `contact sheet: ${sheet}` : 'contact sheet unavailable (needs ffmpeg)');
        return;
      }
      process.stderr.write('bh: usage: bh video init|export|review <recording-dir> [--brief path] [--out path]\n');
      process.exit(2);
      return;
    }
    case 'chrome': {
      const sub = process.argv[3];
      const ac = await import('./agentChrome.js');
      if (sub === 'start') {
        if (!(await ac.launchAgentChrome())) { process.stderr.write(`bh: agent Chrome failed to start on :${ac.agentPort()}\n`); process.exit(1); }
        const binName = ac.chromeBinary()?.split(/[\\/]/).pop() ?? 'browser';
        console.log(`agent chrome up on ${ac.agentCdpUrl()} (${binName})`);
      } else if (sub === 'stop') {
        if (!(await ac.stopAgentChrome())) { process.stderr.write('bh: agent Chrome did not stop cleanly\n'); process.exit(1); }
        console.log('agent chrome stopped');
      } else if (sub === 'status') {
        const up = await ac.isAgentChromeRunning();
        const headless = await ac.agentChromeHeadless();
        console.log(JSON.stringify({ running: up, headless, cdp: ac.agentCdpUrl(), binary: ac.chromeBinary() }));
      } else {
        process.stderr.write('bh: usage: bh chrome start|stop|status\n');
        process.exit(2);
      }
      process.exit(0);
      return;
    }
    case '--help':
    case '-h':
      usage();
      return;
    case undefined: {
      // The bash version blocked reading a TTY stdin forever; fail fast instead.
      if (process.stdin.isTTY) usage();
      await startRepl();
      await postEval(await readStdin());
      return;
    }
    case 'run': {
      const name = argv[1];
      if (!name) { process.stderr.write('bh: usage: bh run <name> [args...]\n'); process.exit(2); }
      await runPlugin(name, argv.slice(2));
      return;
    }
    default: {
      // Unknown command = plugin routing (Python contract); fall back to JS eval.
      if (arg && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(arg)) {
        const { pluginPath } = await import('./plugins.js');
        if (pluginPath(arg)) {
          await runPlugin(arg, argv.slice(1));
          return;
        }
      }
      await startRepl();
      await postEval(arg!);
      return;
    }
  }
}

await main();
