const addressInput = document.getElementById('deviceAddress');
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

let connected = false;
let controlMode = 'auto';
let pollTimer = null;

function getDeviceBase() {
  let value = addressInput.value.trim();
  if (!value) value = window.location.origin;
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
  return value.replace(/\/$/, '');
}

function setConnectionState(state, message) {
  connectionStatus.dataset.state = state;
  connectionMessage.textContent = message;
  dashboard.dataset.state = state;
  heroConnectionText.textContent = state === 'connected' ? 'CONNECTED' : state === 'connecting' ? 'CONNECTING' : state === 'error' ? 'ERROR' : 'OFFLINE';
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
    ? 'Connect to the ESP32 to enable controls.'
    : isManual
      ? 'Manual mode is active. Set a speed or turn the fan off.'
      : 'Switch to Manual to adjust speed or turn the fan off.';
  document.getElementById('lockIcon').textContent = connected ? (isManual ? '↔' : '⌁') : '⌑';
}

function renderStatus(data) {
  const temperature = data.temperatureC ?? data.temperature;
  const speed = Number(data.fanSpeed ?? data.speed ?? 0);
  const reportedMode = String(data.mode ?? 'auto').toLowerCase();
  controlMode = reportedMode === 'manual' ? 'manual' : 'auto';

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
  heroModeText.textContent = controlMode === 'manual' ? 'MANUAL' : 'AUTO';
  updateControlAvailability();
}

async function apiRequest(path, timeout = 4000) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(`${getDeviceBase()}${path}`, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) throw new Error(`ESP32 returned HTTP ${response.status}.`);
    return await response.json();
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function refreshStatus() {
  const data = await apiRequest('/api/status');
  renderStatus(data);
  return data;
}

function showConnectionError(error) {
  connected = false;
  window.clearInterval(pollTimer);
  pollTimer = null;
  connectButton.disabled = false;
  connectButton.innerHTML = 'Connect to ESP32 <span>↗</span>';
  const detail = error?.name === 'AbortError'
    ? 'Request timed out. Check the ESP32 address and Wi-Fi connection.'
    : 'Could not reach the ESP32 API. Check the address, same Wi-Fi network, and browser access settings.';
  setConnectionState('error', detail);
  updateControlAvailability();
}

connectButton.addEventListener('click', async () => {
  if (connected) {
    connected = false;
    window.clearInterval(pollTimer);
    pollTimer = null;
    connectButton.disabled = false;
    connectButton.innerHTML = 'Connect to ESP32 <span>↗</span>';
    setConnectionState('disconnected', 'Disconnected');
    heroModeText.textContent = '—';
    temperatureValue.innerHTML = '--.-<sup>°C</sup>';
    fanValue.textContent = '--%';
    fanMeter.style.width = '0%';
    updateControlAvailability();
    return;
  }

  connectButton.disabled = true;
  connectButton.textContent = 'Connecting…';
  setConnectionState('connecting', 'Connecting to ESP32…');
  try {
    await refreshStatus();
    connected = true;
    setConnectionState('connected', 'Connected to ESP32');
    connectButton.disabled = false;
    connectButton.textContent = 'Disconnect';
    updateControlAvailability();
    pollTimer = window.setInterval(async () => {
      try {
        await refreshStatus();
      } catch (error) {
        showConnectionError(error);
      }
    }, 2500);
  } catch (error) {
    showConnectionError(error);
  }
});

async function setMode(mode) {
  if (!connected) return;
  autoButton.disabled = true;
  manualButton.disabled = true;
  try {
    await apiRequest(`/api/control?mode=${mode}`);
    controlMode = mode;
    heroModeText.textContent = mode.toUpperCase();
    updateControlAvailability();
  } catch (error) {
    showConnectionError(error);
  }
}

autoButton.addEventListener('click', () => setMode('auto'));
manualButton.addEventListener('click', () => setMode('manual'));

speedSlider.addEventListener('input', () => {
  speedLabel.textContent = `${speedSlider.value}%`;
});

speedSlider.addEventListener('change', async () => {
  if (!connected || controlMode !== 'manual') return;
  try {
    await apiRequest(`/api/control?speed=${encodeURIComponent(speedSlider.value)}`);
    await refreshStatus();
  } catch (error) {
    showConnectionError(error);
  }
});

fanOffButton.addEventListener('click', async () => {
  if (!connected || controlMode !== 'manual') return;
  try {
    await apiRequest('/api/control?off=1');
    await refreshStatus();
  } catch (error) {
    showConnectionError(error);
  }
});

updateControlAvailability();
