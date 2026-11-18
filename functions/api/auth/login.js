import { createSession, json, requestIsSameOrigin, verifyPassword } from '../../_lib/auth.js';

export async function onRequestPost({ request, env }) {
  if (!requestIsSameOrigin(request)) return json({ error: 'Request origin could not be verified.' }, 403);
  if (!env.DB) return json({ error: 'Account service is not configured yet.' }, 503);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Please enter your email and password.' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Please enter your email and password.' }, 400);
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (email.length > 254 || password.length > 128) return json({ error: 'Email or password is incorrect.' }, 401);
  const user = await env.DB.prepare('SELECT id, full_name, email, password_hash, status FROM users WHERE email = ? COLLATE NOCASE').bind(email).first();
  if (!user || user.status !== 'active' || !await verifyPassword(password, user.password_hash)) {
    return json({ error: 'Email or password is incorrect.' }, 401);
  }
  const session = await createSession(env.DB, user.id);
  return json({ user: { id: user.id, fullName: user.full_name, email: user.email } }, 200, { 'set-cookie': session.cookie });
}
