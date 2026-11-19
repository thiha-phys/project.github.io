export function coordinatorStub(env) {
  if (!env.FAN_COORDINATOR) throw new Error('FAN_COORDINATOR binding is missing.');
  return env.FAN_COORDINATOR.get(env.FAN_COORDINATOR.idFromName('mu-physics-fan-control'));
}

export async function callCoordinator(env, path, payload = {}, headers = {}) {
  if (!env.COORDINATOR_INTERNAL_TOKEN) {
    throw new Error('Coordinator internal token is missing.');
  }

  const requestHeaders = new Headers(headers);
  requestHeaders.set('content-type', 'application/json');
  requestHeaders.set('x-coordinator-token', env.COORDINATOR_INTERNAL_TOKEN);

  const response = await coordinatorStub(env).fetch(`https://fan-coordinator.internal${path}`, {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({}));
  return { response, data };
}
