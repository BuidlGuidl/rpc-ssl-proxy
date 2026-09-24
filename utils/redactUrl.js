/**
 * Reduce a URL to scheme + host for logs, alerts and status pages.
 * Provider URLs carry the API key in the path (…/v2/<key>), so the path must never
 * be printed.
 */
function redactUrl(url) {
  try {
    if (!url || typeof url !== 'string' || url.trim() === '') return 'NOT SET';
    const u = new URL(url);
    return u.pathname && u.pathname !== '/' ? `${u.origin}/…` : u.origin;
  } catch {
    return '<unparseable url>';
  }
}

export { redactUrl };
