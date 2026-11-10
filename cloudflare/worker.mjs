// Cloudflare serves the static UI; the Node/SQLite API runs on a separate host.
// Never send credentials to an origin chosen by the incoming request.
function error(status, code, message) {
  return Response.json({ error: { code, message } }, {
    status, headers: { 'cache-control': 'no-store' }
  });
}

export default {
  async fetch(request, env) {
    const incoming = new URL(request.url);
    if (incoming.pathname !== '/api' && !incoming.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    let origin;
    try {
      origin = new URL(env.BACKEND_ORIGIN);
      if (origin.protocol !== 'https:' || origin.username || origin.password ||
          origin.pathname !== '/' || origin.search || origin.hash || origin.origin === incoming.origin) {
        throw new Error('Invalid origin');
      }
    } catch {
      return error(503, 'BACKEND_NOT_CONFIGURED', 'The parking API is not configured. Contact your administrator.');
    }

    const target = new URL(incoming.pathname + incoming.search, origin);
    try {
      // Do not follow redirects: authorization headers must not leave this origin.
      const response = await fetch(new Request(target, request), { redirect: 'manual' });
      if (response.status >= 300 && response.status < 400) {
        return error(502, 'BACKEND_REDIRECT', 'The parking API returned an unexpected redirect.');
      }
      return response;
    } catch {
      return error(502, 'BACKEND_UNAVAILABLE', 'The parking API is unavailable. Please try again later.');
    }
  }
};
