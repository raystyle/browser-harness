/**
 * __bh_extract — page-content extraction SDK (Defuddle, D33).
 *
 * Browser-resident one-shot: evaluates on the RENDERED document (the browser
 * path of web-fetch), returns clean content + metadata. Defuddle itself is a
 * BUILD-TIME devDependency — esbuild bundles it into this self-contained
 * IIFE, so the zero-runtime-dependency rule is untouched (G002).
 *
 * Fixed-shape contract: { _ok, _v, _ts, ... } — numbers/strings only.
 */

import Defuddle from 'defuddle';

const CONTRACT_VERSION = '1.0.0';

declare global {
  // eslint-disable-next-line no-var
  var __bh_extract: undefined | (() => Record<string, unknown>);
}

(globalThis as { __bh_extract?: unknown }).__bh_extract = (): Record<string, unknown> => {
  try {
    const r = new Defuddle(document).parse();
    return {
      _ok: true,
      _v: CONTRACT_VERSION,
      _ts: new Date().toISOString(),
      content_html: r.content ?? '',
      markdown: r.contentMarkdown ?? '',
      title: r.title ?? '',
      author: r.author ?? '',
      description: r.description ?? '',
      published: r.published ?? '',
      site: r.site ?? '',
      domain: r.domain ?? '',
      word_count: r.wordCount ?? 0,
      extractor: r.extractorType ?? 'generic',
    };
  } catch (e) {
    return {
      _ok: false,
      _v: CONTRACT_VERSION,
      _ts: new Date().toISOString(),
      error: `EXTRACT: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
};
