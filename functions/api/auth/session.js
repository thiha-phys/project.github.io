import { json, sessionForRequest } from '../../_lib/auth.js';

export async function onRequestGet({ request, env }) {
  const user = await sessionForRequest(request, env);
  if (!user) return json({ authenticated: false }, 401);
  return json({ authenticated: true, user: { id: user.id, fullName: user.fullName, email: user.email, isPresenter: user.isPresenter }, expiresAt: user.expiresAt });
}
