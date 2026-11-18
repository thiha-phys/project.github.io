import { json, requestIsSameOrigin, sessionForRequest } from '../../_lib/auth.js';
import { callCoordinator } from '../../_lib/coordinator.js';

export async function onRequestGet({ request, env }) {
  const user = await sessionForRequest(request, env);
  if (!user) return json({ error: 'Please log in again.' }, 401);
  try {
    const result = await callCoordinator(env, '/internal/request-status', { userId: user.id });
    return json(result.data, result.response.status);
  } catch { return json({ error: 'Control service is not available.' }, 503); }
}

export async function onRequestPost({ request, env }) {
  if (!requestIsSameOrigin(request)) return json({ error: 'Request origin could not be verified.' }, 403);
  const user = await sessionForRequest(request, env);
  if (!user) return json({ error: 'Please log in again.' }, 401);
  try {
    const result = await callCoordinator(env, '/internal/request', { userId: user.id, fullName: user.fullName, email: user.email });
    return json(result.data, result.response.status);
  } catch { return json({ error: 'Control service is not available.' }, 503); }
}
