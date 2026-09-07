/**
 * super-ocr — scan the attached page, locate captcha images, OCR them.
 *
 * Usage:
 *   bh super-ocr [url片段] [--top N] [--save]   scan + locate + recognize
 *   bh super-ocr locate [url片段] [--top N]     locate only (no OCR)
 *   bh super-ocr setup                          install ppu-paddle-ocr into <BH_HOME>/ocr
 *   bh super-ocr ready                          engine + current-tab probe
 *
 * Tab policy: attach-first like page-detect — match an already-open tab
 * (optional url substring) or use the daemon's current tab. Never opens a
 * dedicated app tab; never fills the captcha input.
 *
 * Engine: ppu-paddle-ocr + onnxruntime-node, installed on demand into
 * <BH_HOME>/ocr (core package stays zero-runtime-dep). First recognize()
 * downloads PP-OCRv6 tiny models to ~/.cache/ppu-paddle-ocr.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const description = '扫描网页定位验证码图片并用 PaddleOCR 识别（不自动填写）。';

const VERSION = '1.0.0';
const USAGE = 'bh: usage: bh super-ocr [url片段] [--top N] [--save] | bh super-ocr locate [url片段] | bh super-ocr setup | bh super-ocr ready';
const SDK_FILE = fileURLToPath(new URL('../sdk/ocr.min.js', import.meta.url));

const bhHome = () => process.env.BH_HOME
  ?? process.env.BROWSER_HARNESS_HOME
  ?? (process.env.XDG_CONFIG_HOME
    ? path.join(process.env.XDG_CONFIG_HOME, 'browser-harness')
    : path.join(homedir(), '.config', 'browser-harness'));

const ocrDir = () => path.join(bhHome(), 'ocr');
const cacheDir = () => process.env.BH_BROWSER_WORKSPACE
  ? path.join(process.env.BH_BROWSER_WORKSPACE, 'cache', 'super-ocr')
  : path.join(bhHome(), 'browser-workspace', 'cache', 'super-ocr');

function nowIso() { return new Date().toISOString(); }
function emit(obj) { console.log(JSON.stringify(obj, null, 1)); }
function fail(msg, code = 1) { process.stderr.write(`bh: ${msg}\n`); return code; }
function failJson(error, code = 1) {
  emit({ _ok: false, _v: VERSION, _ts: nowIso(), error });
  process.stderr.write(`bh: ${error}\n`);
  return code;
}
function exitOf(error) {
  if (/^CAPTCHA\|WALL:/.test(error)) return 2;
  if (/^TIMEOUT:/.test(error)) return 4;
  if (/^NOT_FOUND:/.test(error)) return 1;
  return 1;
}

function check(r) {
  if (r === null || r === undefined) throw new Error('SDK returned null — session may be disconnected; retry the command');
  if (typeof r._ok !== 'boolean' || typeof r._v !== 'string' || typeof r._ts !== 'string') {
    throw new Error(`SDK contract violation (expected {_ok,_v,_ts}): ${JSON.stringify(r).slice(0, 200)}`);
  }
  if (!r._ok) throw new Error(r.error || 'unknown SDK error');
  return r;
}

function packageEntry(pkgRoot) {
  const pkgPath = path.join(pkgRoot, 'package.json');
  if (!existsSync(pkgPath)) return null;
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  let e = pkg.exports?.['.'];
  if (e && typeof e === 'object') e = e.import || e.node || e.default;
  if (typeof e === 'object' && e) e = e.import || e.default;
  const rel = typeof e === 'string' ? e : (pkg.module || pkg.main || 'index.js');
  return path.join(pkgRoot, String(rel).replace(/^\.\//, ''));
}

/** Invoke npm as `node npm-cli.js` so fnm/nvm shims and Windows .ps1 wrappers are skipped. */
function npmArgv(args) {
  const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (existsSync(cli)) return { cmd: process.execPath, argv: [cli, ...args] };
  return { cmd: process.platform === 'win32' ? 'npm.cmd' : 'npm', argv: args };
}

function engineCandidates() {
  const out = [];
  out.push(path.join(ocrDir(), 'node_modules', 'ppu-paddle-ocr'));
  try {
    const req = createRequire(path.join(ocrDir(), 'package.json'));
    out.unshift(path.dirname(req.resolve('ppu-paddle-ocr/package.json')));
  } catch { /* not installed in BH_HOME/ocr yet */ }
  try {
    const npm = npmArgv(['root', '-g']);
    const r = spawnSync(npm.cmd, npm.argv, { encoding: 'utf8' });
    if (r.status === 0) out.push(path.join(String(r.stdout || '').trim(), 'ppu-paddle-ocr'));
  } catch { /* no global npm */ }
  return out;
}

function findEngineRoot() {
  for (const p of engineCandidates()) {
    if (p && existsSync(path.join(p, 'package.json'))) return p;
  }
  return null;
}

async function loadEngine() {
  const root = findEngineRoot();
  if (!root) {
    throw new Error('NOT_FOUND: ppu-paddle-ocr 未安装 — 先跑 `bh super-ocr setup`（装到 <BH_HOME>/ocr，核心包保持零 runtime 依赖）');
  }
  const entry = packageEntry(root);
  if (!entry || !existsSync(entry)) {
    throw new Error(`NOT_FOUND: ppu-paddle-ocr entry missing at ${root}`);
  }
  return import(pathToFileURL(entry).href);
}

let _svc = null;
async function getService() {
  if (_svc) return _svc;
  const mod = await loadEngine();
  const Service = mod.PaddleOcrService;
  if (typeof Service !== 'function') throw new Error('NOT_FOUND: ppu-paddle-ocr has no PaddleOcrService export');
  _svc = new Service({
    debugging: { debug: false, verbose: false },
    processing: { engine: 'canvas-native' },
    recognition: { strategy: 'per-box', minimumConfidence: 0.3 },
  });
  await _svc.initialize();
  return _svc;
}

function normalizeText(s) {
  return String(s || '').replace(/\s+/g, '');
}

function pickOcr(r) {
  const raw = String(r?.text ?? '');
  const text = normalizeText(raw);
  const lines = r?.lines ?? r?.items ?? [];
  const cs = Array.isArray(lines)
    ? lines.map(l => l?.confidence ?? l?.score).filter(n => typeof n === 'number')
    : [];
  const confidence = cs.length ? cs.reduce((a, b) => a + b, 0) / cs.length : (typeof r?.confidence === 'number' ? r.confidence : null);
  return { text, raw: raw.trim(), confidence };
}

async function setup() {
  const dir = ocrDir();
  mkdirSync(dir, { recursive: true });
  const pkg = path.join(dir, 'package.json');
  if (!existsSync(pkg)) {
    writeFileSync(pkg, JSON.stringify({ name: 'bh-ocr-engine', private: true }, null, 2));
  }
  process.stderr.write(`bh: installing ppu-paddle-ocr + onnxruntime-node into ${dir}\n`);
  const npm = npmArgv(['install', '--no-fund', '--no-audit', 'ppu-paddle-ocr', 'onnxruntime-node']);
  const r = spawnSync(npm.cmd, npm.argv, { cwd: dir, stdio: 'inherit', env: process.env });
  if (r.error || r.status !== 0) {
    const why = r.error ? r.error.message : `exit ${r.status}`;
    return failJson(`NETWORK: npm install failed in ${dir} (${why})`, 1);
  }
  const root = findEngineRoot();
  emit({
    _ok: true, _v: VERSION, _ts: nowIso(),
    engine: !!root, dir, packages: ['ppu-paddle-ocr', 'onnxruntime-node'],
    note: '首次识别会下载 PP-OCRv6 tiny 模型到 ~/.cache/ppu-paddle-ocr',
  });
  return 0;
}

function isDash(url) {
  try { return /^https?:\/\/127\.0\.0\.1:9870(?:\/|$)/i.test(String(url || '')); }
  catch { return false; }
}

async function attachTab(h, want) {
  if (want) {
    const tabs = await h.list_tabs(false);
    const tab = tabs.find(t => !isDash(t.url) && String(t.url).includes(want));
    if (!tab) {
      const listed = tabs.map(t => String(t.url).slice(0, 50)).join(' | ') || '(none)';
      throw new Error(`NOT_FOUND: no open tab matches ${JSON.stringify(want)} — open tabs: ${listed}`);
    }
    await h.switch_tab(tab.targetId, false);
  }
  const cur = await h.current_tab();
  if (isDash(cur.url)) throw new Error('AUTHORIZATION: 看板页不是工作 tab，换到目标站点再跑 super-ocr');
  return cur;
}

async function injectSdk(h, sdk) {
  let fp = 0;
  for (let i = 0; i < sdk.length; i++) fp = (fp * 33 + sdk.charCodeAt(i)) >>> 0;
  const marker = `(globalThis.__bh_sdk ??= {}).ocr = ${JSON.stringify(String(fp))};`;
  let probe = false;
  try { probe = await h.js(`globalThis.__bh_sdk?.ocr === ${JSON.stringify(String(fp))}`); } catch { /* mid-nav */ }
  if (probe !== true) {
    await h.cdp('Page.addScriptToEvaluateOnNewDocument', { source: `${sdk};${marker}` });
    await h.js(`${sdk};${marker}`);
  }
  const t0 = Date.now();
  while (Date.now() - t0 < 8_000) {
    let r = null;
    try { r = await h.js('__ocr && __ocr.ready()'); } catch { /* transient */ }
    if (r && typeof r._ok === 'boolean') return check(r);
    await new Promise(res => setTimeout(res, 250));
  }
  throw new Error('TIMEOUT: __ocr SDK did not become ready within 8s');
}

async function clipPng(h, box, outPath) {
  const pad = 2;
  const x = Math.max(0, (box?.x ?? 0) - pad);
  const y = Math.max(0, (box?.y ?? 0) - pad);
  const width = Math.max(1, (box?.width ?? 0) + pad * 2);
  const height = Math.max(1, (box?.height ?? 0) + pad * 2);
  const scale = Math.min(4, Math.max(2, 120 / Math.min(width, height)));
  const r = await h.cdp('Page.captureScreenshot', {
    format: 'png',
    clip: { x, y, width, height, scale },
  });
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, Buffer.from(r.data, 'base64'));
  return outPath;
}

async function cropCandidate(h, c, save) {
  const tmp = path.join(bhHome(), 'tmp', `ocr-${c.id}.png`);
  const dest = save ? path.join(cacheDir(), `${c.id}-${Date.now()}.png`) : tmp;
  let via = 'clip';
  let exp = null;
  try { exp = await h.js(`__ocr.export(${JSON.stringify(c.id)})`); } catch { /* fall through */ }
  if (exp && exp._ok && exp.data) {
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, Buffer.from(exp.data, 'base64'));
    via = exp.via || 'export';
    return { path: dest, via, box: exp.box || c.box };
  }
  const box = (exp && exp.box) || c.box;
  await clipPng(h, box, dest);
  return { path: dest, via, box };
}

function toArrayBuffer(file) {
  const buf = readFileSync(file);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

async function recognizeOne(svc, file) {
  // M015: ppu-paddle-ocr only treats strings starting with `/` or `http` as
  // paths; a Windows `D:\...` string is taken as a Canvas and throws
  // `image.getContext is not a function`. Always pass an ArrayBuffer.
  const r = await svc.recognize(toArrayBuffer(file), { flatten: true, strategy: 'per-box' });
  return pickOcr(r);
}

async function readyCmd(ctx) {
  let engine = false;
  let engine_dir = findEngineRoot();
  let engine_error = null;
  if (engine_dir) {
    try { await getService(); engine = true; }
    catch (e) { engine_error = String(e?.message ?? e); }
  }
  let page = null;
  try {
    const h = ctx.helpers;
    if (!existsSync(SDK_FILE)) throw new Error('NOT_FOUND: sdk/ocr.min.js missing — run npm run build:sdk');
    const sdk = readFileSync(SDK_FILE, 'utf8');
    const cur = await attachTab(h, '');
    const r = await injectSdk(h, sdk);
    page = { url: r.url || cur.url, title: r.title || cur.title, ready: r.ready, interactive: r.interactive || null };
  } catch (e) {
    page = { error: String(e?.message ?? e) };
  }
  emit({
    _ok: true, _v: VERSION, _ts: nowIso(),
    engine, engine_dir, engine_error,
    page,
    note: engine ? undefined : 'ppu-paddle-ocr 未就绪 — `bh super-ocr setup`',
  });
  return 0;
}

async function scan(ctx, argv, locateOnly) {
  const pos = argv.filter(a => !a.startsWith('-'));
  const want = pos.find(p => p !== 'locate') || '';
  const top = Number(argv.find((a, i) => argv[i - 1] === '--top') ?? 5) || 5;
  const save = argv.includes('--save');
  const h = ctx.helpers;
  if (!existsSync(SDK_FILE)) return failJson('NOT_FOUND: sdk/ocr.min.js missing — run npm run build:sdk then `bh skill sync`', 1);

  const sdk = readFileSync(SDK_FILE, 'utf8');
  const cur = await attachTab(h, want);
  await h.wait_for_load(8).catch(() => {});
  await injectSdk(h, sdk);
  const loc = check(await h.js(`__ocr.locate(${top})`));
  const candidates = loc.candidates || [];
  const interactive = loc.interactive || null;

  if (locateOnly) {
    emit({
      _ok: true, _v: VERSION, _ts: nowIso(),
      url: loc.url || cur.url, title: loc.title || cur.title,
      interactive, count: candidates.length, items: candidates,
    });
    return 0;
  }

  if (!candidates.length && interactive) {
    return failJson(
      `CAPTCHA|WALL: interactive puzzle (${interactive.kind}) — 图形验证码 OCR 无法解；请在窗口完成。${interactive.reason}`,
      2,
    );
  }

  let svc = null;
  if (candidates.length) {
    try { svc = await getService(); }
    catch (e) { return failJson(String(e?.message ?? e), exitOf(String(e?.message ?? e))); }
  }

  const items = [];
  for (const c of candidates) {
    const row = { ...c, text: '', raw: '', confidence: null, via: null, crop: null, error: null };
    try {
      const crop = await cropCandidate(h, c, save);
      row.via = crop.via;
      row.box = crop.box || c.box;
      if (save) row.crop = crop.path;
      const ocr = await recognizeOne(svc, crop.path);
      row.text = ocr.text;
      row.raw = ocr.raw;
      row.confidence = ocr.confidence;
      if (!save) { try { rmSync(crop.path); } catch { /* tmp */ } }
    } catch (e) {
      row.error = String(e?.message ?? e);
    }
    items.push(row);
  }

  emit({
    _ok: true, _v: VERSION, _ts: nowIso(),
    url: loc.url || cur.url, title: loc.title || cur.title,
    interactive, count: items.length, items,
  });
  return 0;
}

export async function main(argv = [], ctx) {
  const pos = argv.filter(a => !a.startsWith('-'));
  const cmd = pos[0];
  try {
    if (cmd === 'setup') return await setup();
    if (cmd === 'ready') return await readyCmd(ctx);
    if (cmd === 'locate') return await scan(ctx, argv, true);
    if (cmd === 'help' || cmd === '-h' || cmd === '--help') return fail(USAGE, 2);
    return await scan(ctx, argv, false);
  } catch (e) {
    const msg = String(e?.message ?? e);
    return failJson(msg, exitOf(msg));
  }
}
