async function installAccountWidget() {
  const header = document.querySelector('.app-header, .site-header');
  if (!header) return;
  const slot = document.createElement('div');
  slot.className = 'account-session-widget';
  slot.hidden = true;
  slot.innerHTML = '<span class="session-name"></span><span class="session-badge" hidden>Presenter</span><span class="logout-status" role="status" aria-live="polite"></span><button type="button">Log out</button>';
  header.append(slot);
  try {
    const response = await fetch('/api/auth/session', { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) { location.replace(`/account.html?next=${encodeURIComponent(location.pathname + location.search)}`); return; }
    const { user } = await response.json();
    slot.querySelector('.session-name').textContent = user.fullName;
    slot.querySelector('.session-badge').hidden = !user.isPresenter;
    slot.hidden = false;
  } catch {
    slot.querySelector('.session-name').textContent = 'Session status unavailable';
    slot.hidden = false;
  }
  slot.querySelector('button').addEventListener('click', async () => {
    const button = slot.querySelector('button');
    const status = slot.querySelector('.logout-status');
    button.disabled = true;
    button.textContent = 'Signing out…';
    status.textContent = '';
    const confirmSignedOut = async () => {
      try {
        const response = await fetch('/api/auth/session', { cache: 'no-store', credentials: 'same-origin' });
        if (response.status === 401) return true;
        if (response.ok) return false;
      } catch { /* The server state could not be checked. */ }
      return null;
    };
    const redirectSignedOut = (warning) => {
      location.replace(`/account.html?logout=${warning ? 'warning' : 'success'}`);
    };
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
      const data = await response.json().catch(() => ({}));
      if (response.ok) {
        redirectSignedOut(false);
        return;
      }
      const signedOut = await confirmSignedOut();
      if (signedOut === true) {
        redirectSignedOut(true);
        return;
      }
      status.textContent = data.error || (signedOut === false
        ? 'Logout was not completed. Your session is still active; please try again.'
        : 'Logout could not be confirmed because the session service is unavailable. Please try again.');
    } catch {
      const signedOut = await confirmSignedOut();
      if (signedOut === true) {
        redirectSignedOut(true);
        return;
      }
      status.textContent = signedOut === false
        ? 'Logout request failed. Your session is still active; check your connection and try again.'
        : 'Logout could not be confirmed because the session service is unavailable. Please try again.';
    }
    button.disabled = false;
    button.textContent = 'Log out';
  });
}
installAccountWidget();
