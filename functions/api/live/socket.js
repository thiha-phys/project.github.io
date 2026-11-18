import { json, sessionForRequest } from '../../_lib/auth.js';
import { coordinatorStub } from '../../_lib/coordinator.js';

export async function onRequestGet({ request, env }) {
  const user = await sessionForRequest(request, env);
  if (!user) return json({ error: 'Please log in again.' }, 401);
  if (request.headers.get('Origin') !== new URL(request.url).origin) return json({ error: 'Request origin could not be verified.' }, 403);
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'WebSocket upgrade required.' }, 426);
  const url = new URL(request.url);
  url.pathname = '/live';
  return coordinatorStub(env).fetch(new Request(url, request));
}
