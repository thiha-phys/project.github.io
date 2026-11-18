import { json, requestIsSameOrigin, sessionForRequest } from '../../_lib/auth.js';
import { callCoordinator } from '../../_lib/coordinator.js';

export async function onRequestPost({ request, env }) {
  if (!requestIsSameOrigin(request)) return json({ error: 'Request origin could not be verified.' }, 403);
  const user = await sessionForRequest(request, env);
  if (!user) return json({ error: 'Please log in again.' }, 401);
  const result = await callCoordinator(env, '/internal/claim', { userId: user.id, fullName: user.fullName, isPresenter: user.isPresenter });
  return json(result.data, result.response.status);
}
