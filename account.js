const registerTab = document.getElementById('registerTab');
const loginTab = document.getElementById('loginTab');
const registerForm = document.getElementById('registerForm');
const loginForm = document.getElementById('loginForm');
const message = document.getElementById('accountMessage');
const nextPath = new URLSearchParams(location.search).get('next');
const safeNext = nextPath && nextPath.startsWith('/') && !nextPath.startsWith('//') && !nextPath.includes('\\') ? nextPath : '/index.html';
const logoutResult = new URLSearchParams(location.search).get('logout');

function setView(view) {
  const registering = view === 'register';
  registerForm.hidden = !registering;
  loginForm.hidden = registering;
  registerTab.classList.toggle('active', registering);
  loginTab.classList.toggle('active', !registering);
  registerTab.setAttribute('aria-selected', String(registering));
  loginTab.setAttribute('aria-selected', String(!registering));
  message.textContent = '';
  message.className = 'account-message';
}

async function checkExistingSession() {
  try {
    const response = await fetch('/api/auth/session', { cache: 'no-store', credentials: 'same-origin' });
    if (response.ok) location.replace(safeNext);
  } catch { /* Keep the account form visible; submit will show service errors. */ }
}

async function submitForm(form, endpoint) {
  message.textContent = '';
  const submit = form.querySelector('button[type="submit"]');
  if (!form.reportValidity()) return;
  const fields = Object.fromEntries(new FormData(form));
  submit.disabled = true;
  submit.textContent = 'Please wait…';
  try {
    const response = await fetch(endpoint, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Could not complete this request. Please try again.');
    message.className = 'account-message success';
    message.textContent = 'Signed in. Opening the project…';
    location.replace(safeNext);
  } catch (error) {
    message.className = 'account-message';
    message.textContent = error.message || 'Account service is unavailable. Check your connection and try again.';
  } finally {
    submit.disabled = false;
    submit.textContent = endpoint.endsWith('/register') ? 'Create account' : 'Log in';
  }
}

registerTab.addEventListener('click', () => setView('register'));
loginTab.addEventListener('click', () => setView('login'));
registerForm.addEventListener('submit', (event) => { event.preventDefault(); submitForm(registerForm, '/api/auth/register'); });
loginForm.addEventListener('submit', (event) => { event.preventDefault(); submitForm(loginForm, '/api/auth/login'); });
if (logoutResult === 'success') {
  setView('login');
  message.className = 'account-message success';
  message.textContent = 'You are signed out. Log in again to continue.';
} else if (logoutResult === 'warning') {
  setView('login');
  message.textContent = 'You are signed out, but control cleanup could not be confirmed. The hardware lease will expire automatically.';
} else {
  checkExistingSession();
}
