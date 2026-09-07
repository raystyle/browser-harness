// S001 PoC: attach to the user's own Chrome Dev via DevToolsActivePort.
// Steps: read discovery file -> WS connect -> list tabs -> background tab (focus watch) -> cleanup.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ud = join(process.env.LOCALAPPDATA, 'Google', 'Chrome Dev', 'User Data');
const raw = readFileSync(join(ud, 'DevToolsActivePort'), 'utf8').trim().split('\n');
const port = raw[0], wsPath = raw[1];
const wsUrl = `ws://127.0.0.1:${port}${wsPath}`;
console.log('[1] DevToolsActivePort ->', wsUrl);

const ws = await connectWithRetry(wsUrl, 30_000);

function connectOnce(url) {
  return new Promise((resolve, reject) => {
    const w = new WebSocket(url);
    const t = setTimeout(() => { try { w.close(); } catch {} reject(new Error('handshake timeout')); }, 4000);
    w.onopen = () => { clearTimeout(t); resolve(w); };
    w.onerror = () => { /* details arrive via onclose */ };
    w.onclose = (ev) => {
      clearTimeout(t);
      reject(new Error(`closed code=${ev.code} reason=${ev.reason || '(none)'} clean=${ev.wasClean}`));
    };
  });
}
async function connectWithRetry(url, budgetMs) {
  const deadline = Date.now() + budgetMs;
  let last = '';
  for (let i = 1; Date.now() < deadline; i++) {
    try {
      const w = await connectOnce(url);
      console.log(`[2] WS connected on attempt ${i}`);
      return w;
    } catch (e) {
      last = e.message;
      process.stdout.write(`    attempt ${i}: ${last}\r`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  throw new Error(`could not connect within ${Math.round(budgetMs / 1000)}s, last: ${last}`);
}
let nextId = 1;
const pending = new Map();
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timed out`));
    }, 8000);
  });
}
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
};
ws.onclose = (ev) => { console.error(`\n[ws closed] code=${ev.code} reason=${ev.reason || '(none)'}`); process.exit(1); };

// The socket is already open (connectWithRetry resolved) -- run the flow directly.
try {
    const { targetInfos } = await call('Target.getTargets');
    const pages = targetInfos.filter(t => t.type === 'page');
    console.log(`[3] ${pages.length} open tabs:`);
    for (const p of pages) console.log('    ', p.targetId.slice(0, 8), (p.title || '').slice(0, 50), '|', p.url.slice(0, 80));
    console.log('[4] creating BACKGROUND tab in 3s -- WATCH YOUR BROWSER NOW');
    for (const s of [3, 2, 1]) { console.log(`     ... ${s}`); await new Promise(r => setTimeout(r, 1000)); }
    const { targetId } = await call('Target.createTarget', { url: 'about:blank', background: true });
    console.log('     created', targetId, '-- holding 6s, keep watching');
    await new Promise(r => setTimeout(r, 6000));
    await call('Target.closeTarget', { targetId });
    console.log('[5] tab closed. PoC complete.');
    ws.close();
    process.exit(0);
} catch (e) {
    console.error('[fail]', e.message);
    process.exit(1);
}
