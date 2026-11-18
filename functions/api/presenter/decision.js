import { json, requestIsSameOrigin, sessionForRequest } from '../../_lib/auth.js';
import { callCoordinator } from '../../_lib/coordinator.js';

export async function onRequestPost({ request, env }) {
  if (!requestIsSameOrigin(request)) return json({ error: 'Request origin could not be verified.' }, 403);
  const user = await sessionForRequest(request, env);
  if (!user) return json({ error: 'Please log in again.' }, 401);
  if (!user.isPresenter) return json({ error: 'Presenter access is required.' }, 403);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid decision.' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Invalid decision.' }, 400);
  if (!['approve', 'reject', 'revoke', 'take-control'].includes(body.action)) return json({ error: 'Unknown presenter action.' }, 400);
  const result = await callCoordinator(env, '/internal/presenter/decision', {
    presenterId: user.id, action: body.action, requestId: body.requestId, userId: body.userId,
  });
  return json(result.data, result.response.status);
}
