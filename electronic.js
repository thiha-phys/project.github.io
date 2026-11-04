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
const manualHint = document.getElementById('manualHint');
const servedByEsp32 = window.location.hostname === '192.168.4.1';

const TOKEN_KEY = 'group2FanControlToken';
const CLIENT_KEY = 'group2FanClientId';
let connected = false;
let controlMode = 'auto';
let connectionState = 'disconnected';
let statusTimer = null;
let heartbeatTimer = null;
let availabilityTimer = null;
let controlToken = sessionStorage.getItem(TOKEN_KEY) || '';

function getDeviceBase() {
  return window.location.origin;
}

function setConnectionState(state, message) {
  const connectRow = document.querySelector('.connect-row');
  if (connectRow) connectRow.hidden = !servedByEsp32;
  connectButton.hidden = !servedByEsp32;
  connectionState = state;
  connectionStatus.dataset.state = state;
  connectionMessage.textContent = message;
  dashboard.dataset.state = state;
  heroConnectionText.textContent = state === 'connected' ? 'CONNECTED' : state === 'connecting' ? 'CONNECTING' : state === 'occupied' ? 'IN USE' : state === 'available' ? 'AVAILABLE' : state === 'error' ? 'ERROR' : 'OFFLINE';
  connectButton.disabled = state === 'checking' || state === 'connecting' || state === 'occupied' || (!servedByEsp32 && state !== 'connected');
  if (state === 'connected') {
    connectButton.disabled = false;
    connectButton.textContent = 'Release control';
  } else if (state === 'occupied') {
    connectButton.textContent = 'In use';
  } else if (state === 'checking') {
    connectButton.textContent = 'Checking…';
  } else if (state === 'connecting') {
    connectButton.textContent = 'Claiming controls…';
  } else {
    connectButton.textContent = servedByEsp32 ? 'Claim fan controls' : 'ESP32 setup required';
  }
}

function updateControlAvailability() {
  autoButton.disabled = !connected;
  manualButton.disabled = !connected;
  const isManual = controlMode === 'manual';
  speedSlider.disabled = !connected || !isManual;
  fanOffButton.disabled = !connected || !isManual;
  autoButton.setAttribute('aria-pressed', String(!isManual));
  manualButton.setAttribute('aria-pressed', String(isManual));
  manualHint.textContent = !connected
    ? connectionState === 'occupied'
      ? 'Another user currently has control.'
      : 'Connect to the ESP32 to enable controls.'
    : isManual
      ? 'Manual mode is active. Set a speed or turn the fan off.'
      : 'Switch to Manual to adjust speed or turn the fan off.';
  document.getElementById('lockIcon').textContent = connected ? (isManual ? '↔' : '⌁') : connectionState === 'occupied' ? '●' : '⌑';
}

function renderStatus(data) {
  const temperature = data.temperatureC ?? data.temperature;
  const speed = Number(data.fanSpeed ?? data.speed ?? 0);
  if (data.mode) controlMode = String(data.mode).toLowerCase() === 'manual' ? 'manual' : 'auto';

  if (Number.isFinite(Number(temperature))) {
    temperatureValue.innerHTML = `${Number(temperature).toFixed(1)}<sup>°C</sup>`;
  }
  if (Number.isFinite(speed)) {
    const boundedSpeed = Math.max(0, Math.min(100, Math.round(speed)));
    const fanIsOff = Boolean(data.fanOff) || boundedSpeed === 0;
    fanValue.textContent = fanIsOff ? 'OFF' : `${boundedSpeed}%`;
    fanMeter.style.width = `${boundedSpeed}%`;
    speedSlider.value = String(boundedSpeed);
    speedLabel.textContent = `${boundedSpeed}%`;
  }
  heroModeText.textContent = controlMode.toUpperCase();
  updateControlAvailability();
}

async function apiRequest(path, options = {}) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), options.timeout || 4500);
  const headers = { Accept: 'application/json' };
  const request = { method: options.method || 'GET', cache: 'no-store', signal: controller.signal, headers };
  if (options.body) {
    headers['Content-Type'] = 'application/json';
    request.body = JSON.stringify(options.body);
  }
  try {
    const response = await fetch(`${getDeviceBase()}${path}`, request);
    let data = {};
    try { data = await response.json(); } catch (_) { /* The API contract expects JSON responses. */ }
    if (response.status === 423 || data.code === 'in_use') {
      const error = new Error('Another user currently has control.');
      error.code = 'in_use';
      throw error;
    }
    if (!response.ok) throw new Error(`ESP32 returned HTTP ${response.status}.`);
    return data;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function clearTimers() {
  window.clearInterval(statusTimer);
  window.clearInterval(heartbeatTimer);
  window.clearInterval(availabilityTimer);
  statusTimer = null;
  heartbeatTimer = null;
  availabilityTimer = null;
}

function markOccupied() {
  connected = false;
  controlToken = '';
  sessionStorage.removeItem(TOKEN_KEY);
  clearTimers();
  setConnectionState('occupied', 'Another user is connected. Control is unavailable until they disconnect.');
  updateControlAvailability();
  availabilityTimer = window.setInterval(checkAvailability, 4000);
}

function markError(error) {
  if (error?.code === 'in_use') {
    markOccupied();
    return;
  }
  connected = false;
  controlToken = '';
  sessionStorage.removeItem(TOKEN_KEY);
  clearTimers();
  setConnectionState('error', error?.name === 'AbortError'
    ? 'Request timed out. Check the ESP32 hotspot and firmware.'
    : 'The ESP32 page loaded, but its control API is not responding. Finish the ESP32 firmware setup.');
  updateControlAvailability();
}

async function getStatus(token = '') {
  return token
    ? apiRequest('/api/status', { method: 'POST', body: { token } })
    : apiRequest('/api/status');
}

async function beginControlledSession(token, firstStatus) {
  controlToken = token;
  sessionStorage.setItem(TOKEN_KEY, token);
  connected = true;
  renderStatus(firstStatus);
  setConnectionState('connected', 'Connected. You have control of this fan.');
  updateControlAvailability();
  window.clearInterval(availabilityTimer);
  statusTimer = window.setInterval(async () => {
    try {
      const data = await getStatus(controlToken);
      if (data.controlGranted === false && data.occupied) throw Object.assign(new Error('in_use'), { code: 'in_use' });
      renderStatus(data);
    } catch (error) { markError(error); }
  }, 2500);
  heartbeatTimer = window.setInterval(async () => {
    try {
      await apiRequest('/api/heartbeat', { method: 'POST', body: { token: controlToken } });
    } catch (error) { markError(error); }
  }, 6000);
}

async function checkAvailability() {
  if (connected || connectionState === 'connecting') return;
  if (!availabilityTimer) setConnectionState('checking', 'Checking ESP32 availability…');
  try {
    const data = await getStatus(controlToken);
    renderStatus(data);
    if (controlToken && data.controlGranted) {
      await beginControlledSession(controlToken, data);
    } else if (data.occupied) {
      markOccupied();
    } else {
      controlToken = '';
      sessionStorage.removeItem(TOKEN_KEY);
      setConnectionState('available', 'ESP32 is available. Connect to take control.');
      updateControlAvailability();
      if (!availabilityTimer) availabilityTimer = window.setInterval(checkAvailability, 5000);
    }
  } catch (error) {
    if (error?.code === 'in_use') markOccupied();
    else {
      setConnectionState('error', 'ESP32 not found. Join its hotspot and open this page at http://192.168.4.1/.');
      updateControlAvailability();
      if (!availabilityTimer) availabilityTimer = window.setInterval(checkAvailability, 6000);
    }
  }
}

async function connectToDevice() {
  if (!servedByEsp32) {
    setConnectionState('error', 'Preview only. Join FanController and open http://192.168.4.1/ after the ESP32 is programmed.');
    updateControlAvailability();
    return;
  }
  if (connected) {
    const token = controlToken;
    try { await apiRequest('/api/disconnect', { method: 'POST', body: { token } }); } catch (_) { /* The device lease will expire if it is already unreachable. */ }
    connected = false;
    controlToken = '';
    sessionStorage.removeItem(TOKEN_KEY);
    clearTimers();
    setConnectionState('disconnected', 'Disconnected. The control lock has been released.');
    heroModeText.textContent = '—';
    temperatureValue.innerHTML = '--.-<sup>°C</sup>';
    fanValue.textContent = '--%';
    fanMeter.style.width = '0%';
    updateControlAvailability();
    checkAvailability();
    return;
  }

  connectButton.disabled = true;
  setConnectionState('connecting', 'Requesting the single-user control lock…');
  try {
    let clientId = sessionStorage.getItem(CLIENT_KEY);
    if (!clientId) {
      clientId = window.crypto?.randomUUID ? window.crypto.randomUUID() : `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      sessionStorage.setItem(CLIENT_KEY, clientId);
    }
    const claim = await apiRequest('/api/connect', { method: 'POST', body: { clientId } });
    if (claim.code === 'in_use' || claim.occupied) {
      markOccupied();
      return;
    }
    if (!claim.token) throw new Error('The ESP32 did not return a control token.');
    controlToken = claim.token;
    const data = await getStatus(controlToken);
    await beginControlledSession(controlToken, data);
  } catch (error) { markError(error); }
}

async function setMode(mode) {
  if (!connected) return;
  autoButton.disabled = true;
  manualButton.disabled = true;
  try {
    await apiRequest('/api/control', { method: 'POST', body: { token: controlToken, mode } });
    controlMode = mode;
    heroModeText.textContent = mode.toUpperCase();
    updateControlAvailability();
  } catch (error) { markError(error); }
}

connectButton.addEventListener('click', connectToDevice);
autoButton.addEventListener('click', () => setMode('auto'));
manualButton.addEventListener('click', () => setMode('manual'));
speedSlider.addEventListener('input', () => { speedLabel.textContent = `${speedSlider.value}%`; });
speedSlider.addEventListener('change', async () => {
  if (!connected || controlMode !== 'manual') return;
  try {
    await apiRequest('/api/control', { method: 'POST', body: { token: controlToken, speed: Number(speedSlider.value) } });
    renderStatus(await getStatus(controlToken));
  } catch (error) { markError(error); }
});
fanOffButton.addEventListener('click', async () => {
  if (!connected || controlMode !== 'manual') return;
  try {
    await apiRequest('/api/control', { method: 'POST', body: { token: controlToken, off: true } });
    renderStatus(await getStatus(controlToken));
  } catch (error) { markError(error); }
});

window.addEventListener('pagehide', () => {
  if (!connected || !controlToken || !navigator.sendBeacon) return;
  const body = new Blob([JSON.stringify({ token: controlToken })], { type: 'application/json' });
  navigator.sendBeacon(`${getDeviceBase()}/api/disconnect`, body);
});

updateControlAvailability();
if (servedByEsp32) {
  checkAvailability();
} else {
  setConnectionState('error', 'Preview only. Join FanController Wi-Fi, then tap Open ESP32 control page above for live controls.');
  updateControlAvailability();
}
