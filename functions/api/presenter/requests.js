import { json, sessionForRequest } from '../../_lib/auth.js';
import { callCoordinator } from '../../_lib/coordinator.js';

export async function onRequestGet({ request, env }) {
  const user = await sessionForRequest(request, env);
  if (!user) return json({ error: 'Please log in again.' }, 401);
  if (!user.isPresenter) return json({ error: 'Presenter access is required.' }, 403);
  const result = await callCoordinator(env, '/internal/presenter/requests', {}, { 'x-presenter-user': user.id });
  return json(result.data, result.response.status);
}
