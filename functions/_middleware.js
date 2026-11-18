import { sessionForRequest } from './_lib/auth.js';

const OPEN_HTML = new Set(['/account.html']);

export async function onRequest(context) {
  const url = new URL(context.request.url);
  if (url.pathname.startsWith('/api/') || !(/\.html?$/.test(url.pathname) || url.pathname === '/')) return context.next();
  if (OPEN_HTML.has(url.pathname)) return context.next();
  if (await sessionForRequest(context.request, context.env)) return context.next();
  const accountUrl = new URL('/account.html', url.origin);
  accountUrl.searchParams.set('next', `${url.pathname}${url.search}`);
  return new Response(null, {
    status: 302,
    headers: { location: accountUrl.toString(), 'cache-control': 'no-store' },
  });
}
