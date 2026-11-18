import { invalidateSession, json, requestIsSameOrigin, sessionForRequest } from '../../_lib/auth.js';
import { callCoordinator } from '../../_lib/coordinator.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!requestIsSameOrigin(request)) return json({ error: 'Request origin could not be verified.' }, 403);
  let user = null;
  let sessionLookupFailed = false;
  try {
    user = await sessionForRequest(request, env);
  } catch (error) {
    sessionLookupFailed = true;
    console.error('Could not look up the session during logout:', error);
  }

  let cookie;
  try {
    cookie = await invalidateSession(request, env);
  } catch (error) {
    console.error('Could not invalidate the session during logout:', error);
    return json(
      { error: 'Logout could not be completed because the session service is unavailable. Please try again.' },
      503,
    );
  }

  let controlCleanupFailed = false;
  if (user && env.FAN_COORDINATOR) {
    try {
      const result = await callCoordinator(env, '/internal/release-user', { userId: user.id });
      if (!result.response.ok) {
        controlCleanupFailed = true;
        console.error('Control release failed during logout:', result.response.status, result.data.error);
      }
    }
    catch (error) {
      controlCleanupFailed = true;
      console.error('Could not release control during logout:', error);
    }
    if (user.isPresenter) {
      try {
        const result = await callCoordinator(env, '/internal/bridge-release', { userId: user.id });
        if (!result.response.ok) {
          controlCleanupFailed = true;
          console.error('Presenter bridge release failed during logout:', result.response.status, result.data.error);
        }
      }
      catch (error) {
        controlCleanupFailed = true;
        console.error('Could not release the presenter bridge during logout:', error);
      }
    }
  }
  if (sessionLookupFailed || controlCleanupFailed) {
    const message = sessionLookupFailed
      ? 'Your browser is signed out, but the session status could not be confirmed. Please log in again.'
      : 'You are signed out, but control cleanup could not be confirmed. The hardware lease will expire automatically.';
    return json(
      { error: message },
      503,
      { 'set-cookie': cookie },
    );
  }
  return json({ ok: true }, 200, { 'set-cookie': cookie });
}
