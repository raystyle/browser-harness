/**
 * Workspace browser_helpers override — your extension point.
 *
 * Any named function export here SHADOWS the packaged default of the same
 * name in the REPL and in plugin processes (merge, never replace). Delete a
 * function to fall back to the packaged version. A broken file never blocks
 * startup; the packaged defaults stay active and a warning goes to stderr.
 */

// Example — override extract_url_content with your own extraction:
// export async function extract_url_content(url, use_browser = false) {
//   const r = await http_get(url);
//   return { title: '', url, text: r, word_count: r.split(/\s+/).length, engine: 'mine' };
// }
