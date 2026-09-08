/**
 * CDP REPL — HTTP server holding one persistent CDP Session.
 *
 * Endpoints (bind 127.0.0.1:9876 by default; override with $CDP_REPL_PORT):
 *   POST /eval     body = raw JS to evaluate (NOT JSON-wrapped).
 *                  Top-level await supported. Single expression auto-returns.
 *                  ONE snippet at a time: while one is in flight (a timed-out
 *                  one included — it is not cancelled), new evals get 429.
 *                  Response: {"ok":true,"result":<json>} | {"ok":false,"error":..,"stack"?:..}
 *   GET  /health   {"ok":true,"uptime":<seconds>,"connected":<bool>,"sessionId":<string|null>}
 *   POST /quit     graceful shutdown. Returns {"ok":true} then exits.
 *
 * State: `session`, the active sessionId, event subscribers, and any
 * `globalThis.<name>` you set persist across requests for the lifetime of
 * the process.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { envNumber } from './env.js';
import { fileURLToPath } from 'node:url';
import { Session, listPageTargets, resolveWsUrl, detectBrowsers } from './session.js';
import * as Generated from './generated.js';
import { derivedPort, instanceName, writeInstanceRecord } from './paths.js';
import { Harness } from './harness.js';
import { createHelpers, installHelperGlobals } from './helpers.js';
import { createBrowserHelpers } from './browser_helpers.js';
import { installWorkspaceOverrides } from './plugins.js';

const session = new Session();
const harness = new Harness(session);
(globalThis as any).session = session;
(globalThis as any).__bh_meta = (op: string, payload: unknown) => harness.__bh_meta(op, payload);
// Legacy thin-SDK globals stay available (protocol-level surface).
(globalThis as any).listPageTargets = () => listPageTargets(session);
(globalThis as any).resolveWsUrl = resolveWsUrl;
(globalThis as any).detectBrowsers = detectBrowsers;
(globalThis as any).CDP = Generated;
// Semantic layer: bare snake_case globals so domain-skills examples run verbatim.
// Action-class helpers are traced into the recorder (one frame per action).
const { createRecorder, startRecording, stopRecording, recordingEnabled, activeRecordingDir, setRecordingPref } = await import('./recorder.js');
const recorder = createRecorder(
  async (framePath: string) => {
    const r = await harness.cdp('Page.captureScreenshot', { format: 'jpeg', quality: 80 }, { timeoutMs: 60_000 });
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    mkdirSync(dirname(framePath), { recursive: true });
    writeFileSync(framePath, Buffer.from(r.data, 'base64'));
  },
  async () => { try { return await (globalThis as any).page_info(); } catch { return {}; } },
);
const helpers = createHelpers(harness.host, { onAction: (name, args, ms, error) => { void recorder.observe(name, args, ms, error); } });
const browserHelpers = createBrowserHelpers(helpers as any);
installHelperGlobals(globalThis, helpers);
installHelperGlobals(globalThis, browserHelpers as any);
(globalThis as any).start_recording = startRecording;
(globalThis as any).stop_recording = stopRecording;
(globalThis as any).recording_dir = activeRecordingDir;
await installWorkspaceOverrides(globalThis);

// CDP_REPL_PORT (legacy env) wins, else BH_NAME-derived port.
const PORT = Number(process.env.CDP_REPL_PORT ?? derivedPort());
const INSTANCE = instanceName();
function pkgVersion(): string {
  try {
    return String(JSON.parse(readFileSync(path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'package.json'), 'utf8')).version);
  } catch {
    return 'unknown';
  }
}
const VERSION = pkgVersion();
const startedAt = Date.now();

// One snippet at a time. A timed-out eval is NOT cancelled — it keeps running
// on this daemon — so the slot stays held until the snippet settles; a retry
// gets 429 instead of interleaving a second eval on the same Session/globals.
let evalInFlight: Promise<unknown> | null = null;

function isExpression(code: string): boolean {
  const trimmed = code.trim();
  if (!trimmed) return false;
  if (/[;\n]/.test(trimmed)) return false;
  if (/^(let|const|var|if|for|while|do|switch|class|function|throw|try|return|import|export)\b/.test(trimmed)) return false;
  return true;
}

function serialize(v: unknown): unknown {
  if (v === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(v, (_k, val) => typeof val === 'bigint' ? val.toString() : val));
  } catch {
    return String(v);
  }
}

async function runSnippet(code: string): Promise<unknown> {
  const body = isExpression(code) ? `return (${code});` : code;
  const wrapped = `(async () => { ${body} })()`;
  return await (0, eval)(wrapped);
}

const TEXT = { 'content-type': 'text/plain; charset=utf-8' } as const;

/**
 * Render a value to the body of a successful /eval response.
 * - undefined / null / "" / {} / []  → empty (caller prints nothing)
 * - string → raw (no JSON quotes)
 * - everything else → JSON
 */
function renderResult(v: unknown): string {
  const s = serialize(v);
  if (s === undefined || s === null) return '';
  if (typeof s === 'string') return s;
  if (Array.isArray(s) && s.length === 0) return '';
  if (typeof s === 'object' && s !== null && Object.keys(s as object).length === 0) return '';
  return JSON.stringify(s);
}

function text(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, TEXT);
  res.end(body);
}

function json(res: ServerResponse, status: number, v: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(v));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  // An aborted client (Ctrl-C mid-eval) otherwise surfaces as an unhandled
  // 'error' on the stream and kills the server. Bun.serve absorbed these.
  req.on('error', () => {});
  res.on('error', () => {});
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, {
        ok: true,
        uptime: Math.floor((Date.now() - startedAt) / 1000),
        connected: session.isConnected(),
        sessionId: session.getActiveSession() ?? null,
        // Multi-instance identity: clients refuse a mismatched name (WSL2
        // mirrored networking can otherwise cross the stacks).
        name: INSTANCE,
        pid: process.pid,
        version: VERSION,
      });
    }

    if (req.method === 'POST' && url.pathname === '/eval') {
      harness.touch(); // idle watchdog
      const code = await readBody(req);
      if (!code.trim()) {
        return text(res, 400, 'empty body\n');
      }
      const timeoutS = Number(url.searchParams.get('timeout') ?? 0);
      if (evalInFlight) {
        return text(res, 429, 'eval busy: a previous snippet is still running on this daemon (a timed-out eval is not cancelled). Wait for it to settle or bh --restart\n');
      }
      try {
        const work = runSnippet(code);
        evalInFlight = work;
        // Release the slot when the snippet settles — including the hang case,
        // where only bh --restart can free it (by design: never two at once).
        work.then(
          () => { if (evalInFlight === work) evalInFlight = null; },
          () => { if (evalInFlight === work) evalInFlight = null; },
        );
        // Zombie reaping (D31): a snippet that outlives its client timeout
        // AND never settles used to latch the single-flight slot forever
        // (a resident watcher would go 429-dead until a manual restart).
        // Every eval gets a ceiling — callers that omit ?timeout= (remote
        // probes) inherit the CLI default instead of running ungoverned.
        // After a grace period past it, orphan the work: the slot frees for
        // new evals while the orphan's remaining CDP calls each carry their
        // own short timeout and drain on their own.
        const capS = timeoutS > 0 ? timeoutS : envNumber('BH_EVAL_TIMEOUT', 300);
        setTimeout(() => {
          if (evalInFlight === work) {
            evalInFlight = null;
            process.stderr.write(`bh: reaped a zombie eval (no settle ${capS}s past ceiling); single-flight slot freed\n`);
          }
        }, capS * 1000 + Math.max(30_000, capS * 500));
        const result = timeoutS > 0
          ? await Promise.race([
              work,
              new Promise((_, rej) => setTimeout(() => rej(Object.assign(
                new Error(`eval timed out after ${timeoutS}s (snippet may still be running on the daemon; new evals are refused until it settles; bh --restart to stop it)`),
                { httpStatus: 504 },
              )), timeoutS * 1000)),
            ])
          : await work;
        const body = renderResult(result);
        return text(res, 200, body);
      } catch (e: any) {
        const status = Number(e?.httpStatus) === 504 ? 504 : 500;
        const msg = (e?.stack ?? e?.message ?? String(e)) + '\n';
        return text(res, status, msg);
      }
    }

    // Read-only side channels (D34): the dashboard snapshots every second
    // and must never contend the single-flight eval lock with the resident
    // workers. /tabs and /peek are pure reads served straight from the
    // harness — they neither wait on nor hold the eval slot.
    if (req.method === 'GET' && url.pathname === '/tabs') {
      try {
        const tabs = await helpers.list_tabs();
        let current: string | null = null;
        try { current = (await helpers.current_tab())?.targetId ?? null; } catch { /* not attached — normal for lazy instances */ }
        return json(res, 200, { ok: true, tabs, current });
      } catch (e) {
        return json(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (req.method === 'GET' && url.pathname === '/peek') {
      const limit = Number(url.searchParams.get('limit') ?? 50);
      try {
        return json(res, 200, { ok: true, events: await harness.__bh_meta('peek', { limit }) });
      } catch (e) {
        return json(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }

    if (req.method === 'GET' && url.pathname === '/meta') {
      return json(res, 200, {
        ok: true,
        name: INSTANCE,
        pid: process.pid,
        version: VERSION,
        uptime: Math.floor((Date.now() - startedAt) / 1000),
        connected: session.isConnected(),
        sessionId: session.getActiveSession() ?? null,
        replacements: harness.replacementCount(),
        pendingDialog: await harness.host.pendingDialog(),
      });
    }

    if (req.method === 'POST' && url.pathname === '/quit') {
      // Delay shutdown so the response flushes over the wire first.
      setTimeout(() => { server.close(); session.close(); process.exit(0); }, 50);
      return json(res, 200, { ok: true });
    }

    return text(res, 404, 'not found');
  } catch (e: any) {
    // Bun.serve turned a handler throw into a 500; in node:http a sync throw
    // escapes as uncaughtException and kills the process — catch it here.
    try { text(res, 500, String(e?.stack ?? e)); } catch { /* response already gone */ }
  }
});

// EADDRINUSE etc. are async events in node:http (Bun.serve threw them).
server.on('error', (e: NodeJS.ErrnoException) => {
  console.error(JSON.stringify({ ok: false, error: String(e.code ?? e.message) }));
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  writeInstanceRecord(INSTANCE, PORT);
  console.log(JSON.stringify({
    ok: true,
    ready: true,
    port: PORT,
    name: INSTANCE,
    message: `CDP REPL listening on http://127.0.0.1:${PORT}`,
  }));
  harness.startWatchdog();
  // Connect + attach in the background. A failure does NOT exit, and retries
  // go through the harness backoff (30s doubling to 10min): every WS attempt
  // pops a fresh "Allow" prompt in Chrome, so hammering retries would
  // machine-gun the user with dialogs. Readiness is decided by ensureDaemon's
  // CDP probe, not by process liveness.
  const tryConnect = async () => {
    if (!harness.connectPermitted()) { setTimeout(tryConnect, 5_000); return; }
    try {
      await harness.connect();
      harness.noteConnectSuccess();
      console.log(JSON.stringify({ ok: true, connected: true, name: INSTANCE, port: PORT }));
    } catch (e: any) {
      harness.noteConnectFailure();
      console.error(`bh: connect failed (retrying with backoff): ${String(e?.message ?? e)}`);
      setTimeout(tryConnect, 5_000);
    }
  };
  void tryConnect();
});
