const connectButton = document.getElementById('connectButton');
const connectionStatus = document.getElementById('connectionStatus');
const connectionMessage = document.getElementById('connectionMessage');
const dashboard = document.querySelector('.dashboard-card');
const temperatureValue = document.getElementById('temperatureValue');
const fanValue = document.getElementById('fanValue');
const fanMeter = document.getElementById('fanMeter');
const heroModeText = document.getElementById('heroModeText');
const heroConnectionText = document.getElementById('heroConnectionText');
const autoButton = document.getElementById('autoButton');
const manualButton = document.getElementById('manualButton');
const speedSlider = document.getElementById('speedSlider');
const speedLabel = document.getElementById('speedLabel');
const fanOffButton = document.getElementById('fanOffButton');
const presetButtons = [...document.querySelectorAll('.preset-button')];
const manualHint = document.getElementById('manualHint');
const requestStatusMessage = document.getElementById('requestStatusMessage');
const presenterPanel = document.getElementById('presenterPanel');
const requestList = document.getElementById('requestList');
let currentUser = null;
let connected = false;
let controlMode = 'auto';
let connectionState = 'checking';
let requestStatus = { status: 'none' };
let leaseToken = '';
let statusTimer;
let heartbeatTimer;
let liveSocket;
let liveReconnectTimer;
let livePingTimer;
let lastLivePongAt = 0;

async function apiRequest(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || 'GET', credentials: 'same-origin', cache: 'no-store',
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function setConnectionState(state, message) {
  connectionState = state;
  connectionStatus.dataset.state = state;
  connectButton.dataset.state = state;
  dashboard.dataset.state = state;
  connectionMessage.textContent = message;
  heroConnectionText.textContent = state === 'connected' ? 'CONNECTED' : state === 'connecting' ? 'CONNECTING' : state === 'occupied' ? 'IN USE' : state === 'available' ? 'AVAILABLE' : state === 'error' ? 'ERROR' : 'CHECKING';
  if (connected) {
    connectButton.disabled = false;
    connectButton.innerHTML = 'Release control <span aria-hidden="true">↗</span>';
  } else if (state === 'connecting') {
    connectButton.disabled = true;
    connectButton.textContent = 'Please wait…';
  } else if (state === 'occupied') {
    connectButton.disabled = true;
    connectButton.textContent = 'Fan is in use';
  } else if (currentUser?.isPresenter) {
    connectButton.disabled = state === 'checking';
    connectButton.innerHTML = 'Take control <span aria-hidden="true">↗</span>';
  } else if (requestStatus.status === 'approved') {
    connectButton.disabled = true;
    connectButton.textContent = 'Activating your control…';
  } else if (requestStatus.status === 'pending') {
    connectButton.disabled = true;
    connectButton.textContent = 'Request pending approval';
  } else {
    connectButton.disabled = state === 'checking';
    connectButton.innerHTML = 'Request fan control <span aria-hidden="true">↗</span>';
  }
  updateControlAvailability();
}

function updateControlAvailability() {
  const isManual = controlMode === 'manual';
  autoButton.disabled = !connected;
  manualButton.disabled = !connected;
  speedSlider.disabled = !connected || !isManual;
  fanOffButton.disabled = !connected || !isManual;
  presetButtons.forEach((button) => { button.disabled = !connected || !isManual; });
  autoButton.setAttribute('aria-pressed', String(!isManual));
  manualButton.setAttribute('aria-pressed', String(isManual));
  manualHint.textContent = !connected
    ? requestStatus.status === 'pending' ? 'Your request is waiting for admin approval.' : currentUser?.isPresenter ? 'Take control to operate the fan.' : requestStatus.status === 'approved' ? 'Your request is approved. Your control lease is activating automatically.' : 'Request control and wait for admin approval.'
    : isManual ? 'Manual mode is active. Set a speed or turn the fan off.' : 'Switch to Manual to adjust speed or turn the fan off.';
  document.getElementById('lockIcon').textContent = connected ? (isManual ? '↔' : '⌁') : connectionState === 'occupied' ? '●' : '⌑';
}

function renderStatus(data) {
  if (!data.online) {
    temperatureValue.innerHTML = '--.-<sup>°C</sup>';
    fanValue.textContent = '--%';
    fanMeter.style.width = '0%';
    heroModeText.textContent = '—';
    dashboard.dataset.state = 'error';
    return;
  }
  const temperature = Number(data.temperatureC ?? data.temperature);
  const speed = Number(data.fanSpeed ?? data.speed ?? 0);
  if (Number.isFinite(temperature)) temperatureValue.innerHTML = `${temperature.toFixed(1)}<sup>°C</sup>`;
  if (Number.isFinite(speed)) {
    const boundedSpeed = Math.max(0, Math.min(100, Math.round(speed)));
    fanValue.textContent = data.fanOff || boundedSpeed === 0 ? 'OFF' : `${boundedSpeed}%`;
    fanMeter.style.width = `${boundedSpeed}%`;
    speedSlider.value = String(boundedSpeed);
    speedLabel.textContent = `${boundedSpeed}%`;
    presetButtons.forEach((button) => button.setAttribute('aria-pressed', String(controlMode === 'manual' && Number(button.dataset.speed) === boundedSpeed)));
  }
  controlMode = String(data.mode).toLowerCase() === 'manual' ? 'manual' : 'auto';
  heroModeText.textContent = controlMode.toUpperCase();
  dashboard.dataset.state = connected ? 'connected' : 'available';
  updateControlAvailability();
}

async function refreshRequestStatus() {
  try {
    requestStatus = await apiRequest('/api/control/request');
    const labels = { none: 'No control request yet.', pending: 'Your request is waiting for admin approval.', approved: 'Approval received. Activating your control lease…', rejected: 'The admin declined this request. You may submit a new request if needed.', revoked: 'Your temporary permission was revoked.', expired: 'Your temporary permission expired after the control connection ended.' };
    const hasActiveLease = requestStatus.status === 'approved'
      && typeof requestStatus.leaseToken === 'string'
      && requestStatus.leaseToken
      && Number.isFinite(requestStatus.leaseExpiresAt)
      && requestStatus.leaseExpiresAt > Date.now();
    if (hasActiveLease) {
      requestStatusMessage.textContent = 'You are in control.';
      activateLease(requestStatus.leaseToken);
      return;
    }

    requestStatusMessage.textContent = currentUser?.isPresenter ? 'Admin access is active. You can approve a request or take back control.' : (labels[requestStatus.status] || 'Control request status is ready.');
    if (connected && !currentUser?.isPresenter) {
      connected = false;
      leaseToken = '';
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
      setConnectionState('error', labels[requestStatus.status] || 'Your control lease is no longer active.');
      return;
    }
    if (requestStatus.status === 'approved' && !connected) {
      setConnectionState('connecting', labels.approved);
      return;
    }
    if (!connected && connectionState !== 'connecting' && connectionState !== 'occupied') setConnectionState(connectionState, connectionMessage.textContent);
  } catch (error) {
    if (error.status === 401) location.replace(`/account.html?next=${encodeURIComponent(location.pathname + location.search)}`);
  }
}

async function refreshLiveStatus() {
  try {
    const data = await apiRequest('/api/live/status');
    renderStatus(data);
    if (!data.online && !connected) setConnectionState('error', 'The live hardware bridge is offline. Ask the presenter to start the bridge.');
    else if (!connected && connectionState !== 'occupied') setConnectionState('available', 'Live ESP32 readings are available. Request control if needed.');
  } catch (error) {
    if (error.status === 401) location.replace(`/account.html?next=${encodeURIComponent(location.pathname + location.search)}`);
    else if (!connected) setConnectionState('error', error.message);
  }
}

function connectLiveSocket() {
  const liveUrl = new URL('/api/live/socket', location.href);
  liveUrl.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let socket;
  try {
    socket = new WebSocket(liveUrl);
  } catch (error) {
    setConnectionState('error', `Could not connect to the live update service: ${error.message}`);
    clearTimeout(liveReconnectTimer);
    liveReconnectTimer = setTimeout(connectLiveSocket, 3000);
    return;
  }
  liveSocket = socket;
  socket.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'audience-pong') {
      lastLivePongAt = Date.now();
      return;
    }
    if (message.type !== 'telemetry') return;
    if (message.online === false || !message.data) {
      renderStatus({ online: false });
      if (!connected) setConnectionState('error', 'The live hardware bridge is offline. Ask the presenter to start the bridge.');
      return;
    }
    renderStatus({ online: true, ...message.data });
    if (!connected && connectionState !== 'occupied') setConnectionState('available', 'Live ESP32 readings are available. Request control if needed.');
  });
  socket.addEventListener('close', () => {
    if (liveSocket !== socket) return;
    liveSocket = undefined;
    clearInterval(livePingTimer);
    renderStatus({ online: false });
    if (!connected) setConnectionState('error', 'Live update connection lost. Reconnecting…');
    clearTimeout(liveReconnectTimer);
    liveReconnectTimer = setTimeout(connectLiveSocket, 3000);
  });
  socket.addEventListener('open', () => {
    lastLivePongAt = Date.now();
    livePingTimer = setInterval(() => {
      if (Date.now() - lastLivePongAt > 40000) {
        socket.close();
        return;
      }
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'audience-ping' }));
    }, 15000);
  });
  socket.addEventListener('error', () => socket.close());
}

async function refreshPresenterRequests() {
  if (!currentUser?.isPresenter) return;
  presenterPanel.hidden = false;
  try {
    const data = await apiRequest('/api/presenter/requests');
    if (!data.requests.length) { requestList.innerHTML = '<p class="empty-requests">There are no pending control requests.</p>'; return; }
    requestList.replaceChildren(...data.requests.map((item) => {
      const row = document.createElement('article'); row.className = 'control-request-item';
      const details = document.createElement('div');
      const name = document.createElement('strong'); name.textContent = item.fullName;
      const email = document.createElement('span'); email.textContent = item.email;
      const status = document.createElement('small'); status.textContent = `${item.status.toUpperCase()} · ${new Date(item.at).toLocaleString()}`;
      details.append(name, email, status);
      const actions = document.createElement('div'); actions.className = 'request-actions';
      const choices = item.status === 'pending' ? [['approve', 'Approve'], ['reject', 'Reject']] : [['revoke', 'Revoke']];
      for (const [action, label] of choices) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
        button.dataset.action = action; button.dataset.requestId = item.id; button.dataset.userId = item.userId; actions.append(button);
      }
      row.append(details, actions); return row;
    }));
  } catch (error) { requestList.textContent = error.message; }
}

async function startControl() {
  if (connected) {
    connectButton.disabled = true;
    let releaseError;
    try { await apiRequest('/api/control/release', { method: 'POST', body: {} }); }
    catch (error) { releaseError = error; }
    connected = false; leaseToken = ''; clearInterval(heartbeatTimer);
    setConnectionState(releaseError ? 'error' : 'available', releaseError
      ? `Release could not be confirmed. Control will expire automatically: ${releaseError.message}`
      : 'Control released.');
    return;
  }
  setConnectionState('connecting', currentUser?.isPresenter ? 'Taking admin control…' : 'Checking admin approval…');
  try {
    if (!currentUser?.isPresenter && requestStatus.status !== 'approved') {
      requestStatus = await apiRequest('/api/control/request', { method: 'POST', body: {} });
      await refreshRequestStatus();
      if (!connected) setConnectionState('available', 'Control request sent. Wait for the admin to approve it.');
      return;
    }
    if (!currentUser?.isPresenter) {
      if (requestStatus.leaseToken) activateLease(requestStatus.leaseToken);
      else setConnectionState('connecting', 'Approval received. Activating your control lease…');
      return;
    }
    const result = await apiRequest('/api/control/claim', { method: 'POST', body: {} });
    activateLease(result.leaseToken);
  } catch (error) { connected = false; leaseToken = ''; setConnectionState(error.status === 423 ? 'occupied' : 'error', error.message); }
}

function activateLease(token) {
  if (!token) return;
  const alreadyActive = connected && leaseToken === token;
  connected = true;
  leaseToken = token;
  setConnectionState('connected', 'You are in control.');
  if (alreadyActive) return;
  void refreshLiveStatus();
  clearInterval(heartbeatTimer);
  const sendHeartbeat = async () => {
    try { await apiRequest('/api/control/heartbeat', { method: 'POST', body: { leaseToken } }); }
    catch (error) {
      connected = false;
      leaseToken = '';
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
      setConnectionState('error', error.message);
    }
  };
  heartbeatTimer = setInterval(sendHeartbeat, 8_000);
  void sendHeartbeat();
}

async function sendCommand(command) {
  if (!connected) return;
  try {
    await apiRequest('/api/control/command', { method: 'POST', body: { leaseToken, ...command } });
    await refreshLiveStatus();
  } catch (error) {
    if (error.status === 403) {
      connected = false;
      leaseToken = '';
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
    setConnectionState('error', error.message);
  }
}

connectButton.addEventListener('click', startControl);
autoButton.addEventListener('click', () => sendCommand({ mode: 'auto' }));
manualButton.addEventListener('click', () => sendCommand({ mode: 'manual' }));
speedSlider.addEventListener('input', () => { speedLabel.textContent = `${speedSlider.value}%`; });
speedSlider.addEventListener('change', () => { if (controlMode === 'manual') sendCommand({ speed: Number(speedSlider.value) }); });
fanOffButton.addEventListener('click', () => { if (controlMode === 'manual') sendCommand({ off: true }); });
presetButtons.forEach((button) => button.addEventListener('click', () => { if (controlMode === 'manual') sendCommand({ speed: Number(button.dataset.speed) }); }));

requestList.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]'); if (!button) return;
  button.disabled = true;
  try {
    await apiRequest('/api/presenter/decision', { method: 'POST', body: { action: button.dataset.action, requestId: button.dataset.requestId, userId: button.dataset.userId } });
    await refreshPresenterRequests(); await refreshRequestStatus();
  } catch (error) { button.disabled = false; alert(error.message); }
});

document.getElementById('takeBackControlButton').addEventListener('click', async () => {
  try {
    await apiRequest('/api/presenter/decision', { method: 'POST', body: { action: 'take-control' } });
    await refreshPresenterRequests(); setConnectionState('available', 'Any temporary controller has been revoked.');
  } catch (error) { alert(error.message); }
});

document.getElementById('resetSeminarButton').addEventListener('click', async () => {
  if (!confirm('Clear temporary control requests and permissions? User accounts will remain.')) return;
  try { await apiRequest('/api/presenter/reset', { method: 'POST', body: {} }); await refreshPresenterRequests(); await refreshRequestStatus(); }
  catch (error) { alert(error.message); }
});

async function initialize() {
  try { currentUser = (await apiRequest('/api/auth/session')).user; }
  catch (error) {
    if (error.status === 401) {
      location.replace(`/account.html?next=${encodeURIComponent(location.pathname + location.search)}`);
      return;
    }
    setConnectionState('error', `Could not verify your account session: ${error.message}`);
    connectButton.disabled = true;
    return;
  }
  await Promise.all([refreshRequestStatus(), refreshLiveStatus(), refreshPresenterRequests()]);
  connectLiveSocket();
  statusTimer = setInterval(async () => { await refreshRequestStatus(); await refreshPresenterRequests(); }, 3000);
}

window.addEventListener('pagehide', () => {
  clearInterval(statusTimer);
  clearInterval(heartbeatTimer);
  clearTimeout(liveReconnectTimer);
  clearInterval(livePingTimer);
  liveSocket?.close();
});
updateControlAvailability();
initialize();
