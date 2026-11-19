import { json, sessionForRequest } from '../../_lib/auth.js';
import { coordinatorStub } from '../../_lib/coordinator.js';

export async function onRequestGet({ request, env }) {
  const user = await sessionForRequest(request, env);
  if (!user) return json({ error: 'Please log in again.' }, 401);
  if (request.headers.get('Origin') !== new URL(request.url).origin) return json({ error: 'Request origin could not be verified.' }, 403);
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'WebSocket upgrade required.' }, 426);
  if (!env.COORDINATOR_INTERNAL_TOKEN) return json({ error: 'Control service is not configured.' }, 503);

  const url = new URL(request.url);
  url.pathname = '/live';

  const forwardedRequest = new Request(url, request);
  forwardedRequest.headers.set('x-coordinator-token', env.COORDINATOR_INTERNAL_TOKEN);

  return coordinatorStub(env).fetch(forwardedRequest);
}
