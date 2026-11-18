export function coordinatorStub(env) {
  if (!env.FAN_COORDINATOR) throw new Error('FAN_COORDINATOR binding is missing.');
  return env.FAN_COORDINATOR.get(env.FAN_COORDINATOR.idFromName('mu-physics-fan-control'));
}

export async function callCoordinator(env, path, payload = {}, headers = {}) {
  const response = await coordinatorStub(env).fetch(`https://fan-coordinator.internal${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return { response, data };
  return { response, data };
}
