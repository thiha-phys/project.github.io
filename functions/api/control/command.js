import { json, requestIsSameOrigin, sessionForRequest } from '../../_lib/auth.js';
import { callCoordinator } from '../../_lib/coordinator.js';

export async function onRequestPost({ request, env }) {
  if (!requestIsSameOrigin(request)) return json({ error: 'Request origin could not be verified.' }, 403);
  const user = await sessionForRequest(request, env);
  if (!user) return json({ error: 'Please log in again.' }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid command.' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Invalid command.' }, 400);
  const command = {};
  if (body.mode !== undefined) {
    if (!['auto', 'manual'].includes(body.mode)) return json({ error: 'Mode must be Auto or Manual.' }, 400);
    command.mode = body.mode;
  }
  if (body.speed !== undefined) {
    const speed = Number(body.speed);
    if (!Number.isInteger(speed) || speed < 0 || speed > 100) return json({ error: 'Fan speed must be from 0 to 100.' }, 400);
    command.speed = speed;
  }
  if (body.off !== undefined) {
    if (typeof body.off !== 'boolean') return json({ error: 'Fan off command must be true or false.' }, 400);
    command.off = body.off;
  }
  if (!Object.keys(command).length) return json({ error: 'No fan command was provided.' }, 400);
  const result = await callCoordinator(env, '/internal/command', {
    userId: user.id, isPresenter: user.isPresenter, leaseToken: body.leaseToken, command,
  });
  return json(result.data, result.response.status);
}
