/**
 * detect — page diagnosis on the ATTACHED browser (D11 attach primitive).
 *
 * Answers "why can't I use/login this page" with event-stream evidence:
 *   challenge-stuck : Cloudflare challenge loaded but its calls timed out
 *                     (blank page) -> advice: reload once
 *   blocked         : 403/429 cluster or wall words          -> honest report
 *   login-wall      : sign-in form rendered                   -> stop, ask user
 *   ok              : interactive page
 *
 * Usage: bh detect [url-substring]   (no arg = the daemon's active tab)
 * Attach-first: matches an EXISTING open tab; never opens one. No match ->
 * lists open tabs so the caller can pick (原语一：如实报，不自作主张创建).
 */

const VERSION = '1.0.0';

export async function main(argv = [], ctx) {
  const { helpers: h } = ctx;
  const want = argv.find(a => !a.startsWith('-'));

  // 1. resolve the target tab among what's already open (attach primitive)
  let tab = null;
  if (want) {
    const tabs = await h.list_tabs();
    tab = tabs.find(t => t.url.includes(want));
    if (!tab) {
      process.stderr.write(`bh: no open tab matches ${JSON.stringify(want)} — open tabs: ${tabs.map(t => t.url.slice(0, 50)).join(' | ')}\n`);
      return 2;
    }
    await h.switch_tab(tab.targetId, false); // background attach
  }
  const cur = await h.current_tab();

  // 2. fresh evidence: drain the ring buffer, reload-free first pass
  const evs = await h.drain_events();
  const reqUrl = new Map();
  const fails = [];
  const statuses = [];
  let challengeSeen = false;
  for (const e of evs) {
    if (e.method === 'Network.requestWillBeSent') {
      const u = e.params.request.url;
      reqUrl.set(e.params.requestId, u);
      if (/cdn-cgi\/challenge-platform/.test(u)) challengeSeen = true;
    } else if (e.method === 'Network.loadingFailed') {
      fails.push({ url: (reqUrl.get(e.params.requestId) || '?').slice(0, 90), error: e.params.errorText });
    } else if (e.method === 'Network.responseReceived') {
      const s = e.params.response.status;
      if (s >= 400) statuses.push(`${s} ${(reqUrl.get(e.params.requestId) || e.params.response.url).slice(0, 80)}`);
      if (/cdn-cgi\/challenge-platform/.test(e.params.response.url)) challengeSeen = true;
    }
  }

  // 3. page truth
  const info = await h.page_info();
  const ready = await h.js('document.readyState').catch(() => '?');
  const bodyText = typeof info.dialog === 'object' ? '' : String(await h.js('document.body.innerText').catch(() => '') || '');
  const bodyLen = bodyText.length;
  const signIn = /sign in|log in|登录|登陆/i.test(bodyText.slice(0, 800)) && /password|email|continue|继续/i.test(bodyText.slice(0, 800));
  const wallWords = /captcha|verify you are human|access denied|rate limit|请求频率|人机验证/i.test(bodyText.slice(0, 1500));

  // 4. verdict (ordered: hard failure first)
  let verdict, advice;
  if (bodyLen === 0 && challengeSeen) {
    verdict = 'challenge-stuck';
    advice = 'anti-bot challenge loaded but its calls stalled — reload the page once to re-run it; repeated stalls = network path to the challenge endpoints';
  } else if (bodyLen === 0 && fails.some(f => /TIMED_OUT/.test(f.error))) {
    verdict = 'network-stalled';
    advice = 'core requests timing out with a blank page — check the network path / proxy for this site';
  } else if (wallWords || statuses.filter(s => s.startsWith('403') || s.startsWith('429')).length >= 3) {
    verdict = 'blocked';
    advice = 'wall/captcha/rate-limit detected — report honestly, do not force through';
  } else if (signIn) {
    verdict = 'login-wall';
    advice = 'sign-in form rendered — stop and let the user log in (credentials are out of bounds)';
  } else if (bodyLen === 0) {
    verdict = 'blank';
    advice = 'page renders no text and no failure signature — capture a screenshot and reload to compare';
  } else {
    // asset-domain starvation: the shell loads but the content engine's
    // CDN (chunks/fonts) is throttled/refused — page renders as a skeleton.
    const assetFails = [
      ...fails.map(f => ({ url: f.url, err: f.error })),
      ...statuses.map(s => ({ url: s.slice(4), err: s.slice(0, 3) })),
    ].filter(f => /cdn|glyph|static|assets/.test(f.url) && /(ERR_FAILED|429|403)/.test(String(f.err)));
    if (assetFails.length >= 3) {
      verdict = 'asset-throttled';
      advice = 'static/asset domains refused (429/ERR_FAILED cluster) while the main domain serves the shell — egress-IP rate limiting: switch exit node or wait out the window';
    } else {
      verdict = 'ok';
      advice = 'page interactive; diagnose interactively if something specific fails';
    }
  }

  const report = {
    _ok: true, _v: VERSION, _ts: new Date().toISOString(),
    url: cur.url, title: (cur.title || '').slice(0, 60),
    verdict, advice,
    page: { ready, bodyLen, dialog: info.dialog ?? null },
    evidence: {
      challengePlatform: challengeSeen,
      failedRequests: fails.slice(-6),
      httpErrors: statuses.slice(-6),
    },
  };
  console.log(JSON.stringify(report, null, 1));
  return verdict === 'ok' ? 0 : 1;
}
