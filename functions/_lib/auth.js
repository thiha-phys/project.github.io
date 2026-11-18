const COOKIE_NAME = '__Host-group2_session';
const SESSION_DAYS = 30;
const PBKDF2_ITERATIONS = 310_000;

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export function parseCookies(header = '') {
  return Object.fromEntries((header || '').split(';').map((part) => {
    const index = part.indexOf('=');
    if (index < 0) return ['', ''];
    return [part.slice(0, index).trim(), part.slice(index + 1).trim()];
  }).filter(([key]) => key));
}

export function requestIsSameOrigin(request) {
  const origin = request.headers.get('Origin');
  return origin === new URL(request.url).origin;
}

function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function fromBase64Url(value) {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

async function digestHex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS }, key, 256);
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(new Uint8Array(bits))}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, iterationText, saltText, expectedText] = String(stored).split('$');
  if (scheme !== 'pbkdf2-sha256' || !/^\d+$/.test(iterationText) || !saltText || !expectedText) return false;
  const iterations = Number(iterationText);
  if (iterations < 100_000 || iterations > 1_000_000) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromBase64Url(saltText), iterations }, key, 256));
  const expected = fromBase64Url(expectedText);
  if (bits.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < bits.length; index += 1) difference |= bits[index] ^ expected[index];
  return difference === 0;
}

export async function createSession(db, userId) {
  const rawToken = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash = await digestHex(rawToken);
  const now = new Date();
  await db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now.toISOString()).run();
  const expiresAt = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').bind(tokenHash, userId, expiresAt).run();
  return {
    token: rawToken,
    cookie: `${COOKIE_NAME}=${encodeURIComponent(rawToken)}; Path=/; Max-Age=${SESSION_DAYS * 86400}; Secure; HttpOnly; SameSite=Lax`,
  };
}

export async function sessionForRequest(request, env) {
  const rawToken = parseCookies(request.headers.get('Cookie'))[COOKIE_NAME];
  if (!rawToken) return null;
  if (!env.DB) throw new Error('The account database binding is missing.');
  const tokenHash = await digestHex(rawToken);
  const row = await env.DB.prepare(`SELECT u.id, u.full_name, u.email, u.status, s.expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?`).bind(tokenHash, new Date().toISOString()).first();
  if (!row || row.status !== 'active') return null;
  return { id: row.id, fullName: row.full_name, email: row.email, expiresAt: row.expires_at,
    isPresenter: Boolean(env.PRESENTER_USER_ID && row.id === env.PRESENTER_USER_ID), tokenHash };
}

export async function invalidateSession(request, env) {
  const rawToken = parseCookies(request.headers.get('Cookie'))[COOKIE_NAME];
  if (rawToken && !env.DB) throw new Error('The account database binding is missing.');
  if (rawToken) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await digestHex(rawToken)).run();
  }
  return clearSessionCookie();
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=Lax`;
}

export function safeNext(value) {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/index.html';
  return value;
}
