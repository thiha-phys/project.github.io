import { createSession, hashPassword, json, requestIsSameOrigin } from '../../_lib/auth.js';

export async function onRequestPost({ request, env }) {
  if (!requestIsSameOrigin(request)) return json({ error: 'Request origin could not be verified.' }, 403);
  if (!env.DB) return json({ error: 'Account service is not configured yet.' }, 503);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Please submit a valid registration form.' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Please submit a valid registration form.' }, 400);
  const fullName = typeof body.fullName === 'string' ? body.fullName.trim().replace(/\s+/g, ' ') : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const confirmPassword = typeof body.confirmPassword === 'string' ? body.confirmPassword : '';
  if (fullName.length < 2 || fullName.length > 120) return json({ error: 'Enter your full name (2–120 characters).' }, 400);
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'Enter a valid email address.' }, 400);
  if (password.length < 12 || password.length > 128) return json({ error: 'Use a password between 12 and 128 characters.' }, 400);
  if (password !== confirmPassword) return json({ error: 'The passwords do not match.' }, 400);
  const id = crypto.randomUUID();
  const passwordHash = await hashPassword(password);
  try {
    await env.DB.prepare('INSERT INTO users (id, full_name, email, password_hash) VALUES (?, ?, ?, ?)')
      .bind(id, fullName, email, passwordHash).run();
  } catch (error) {
    if (/unique|constraint/i.test(String(error))) return json({ error: 'This email is already registered. Please log in.' }, 409);
    return json({ error: 'Account could not be created. Please try again.' }, 500);
  }
  const session = await createSession(env.DB, id);
  return json({ user: { id, fullName, email } }, 201, { 'set-cookie': session.cookie });
}
