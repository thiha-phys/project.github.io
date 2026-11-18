const SERVICE_UUID = '7c4a0001-6f4a-4f3d-9a2c-2d7b6e4a1000';
const TELEMETRY_UUID = '7c4a0002-6f4a-4f3d-9a2c-2d7b6e4a1000';
const COMMAND_UUID = '7c4a0003-6f4a-4f3d-9a2c-2d7b6e4a1000';
const OP = { auto: 1, manual: 2, speed: 3, off: 4, heartbeat: 5, endLease: 6 };

const connectButton = document.getElementById('bridgeConnect');
const disconnectButton = document.getElementById('bridgeDisconnect');
const statusMessage = document.querySelector('#bridgeStatus span');
const statusElement = document.getElementById('bridgeStatus');
let device;
let gattServer;
let telemetryCharacteristic;
let commandCharacteristic;
let socket;
let leaseActive = false;
let leaseHeartbeatTimer;
let bridgePingTimer;
let cloudWatchdogTimer;
let lastCloudPongAt = 0;

function setStatus(message, state) {
  statusMessage.textContent = message;
  statusElement.dataset.state = state;
}

function sendSocketMessage(data) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data));
}

async function writeBleCommand(opcode, value) {
  if (!commandCharacteristic) throw new Error('ESP32 command characteristic is unavailable.');
  const bytes = value === undefined ? new Uint8Array([opcode]) : new Uint8Array([opcode, value]);
  await commandCharacteristic.writeValueWithResponse(bytes);
}

function telemetryReceived(event) {
  const bytes = event.target.value;
  if (bytes.byteLength < 5) return;
  sendSocketMessage({
    type: 'telemetry',
    data: {
      temperatureC: bytes.getUint16(0, true) / 10,
      fanSpeed: bytes.getUint8(2),
      mode: bytes.getUint8(3) === 1 ? 'manual' : 'auto',
      fanOff: bytes.getUint8(4) === 1,
    },
  });
}

async function commandFromCloud(data) {
  try {
    const command = data.command || {};
    if (command.off === true) await writeBleCommand(OP.off);
    else if (command.speed !== undefined) await writeBleCommand(OP.speed, Number(command.speed));
    else if (command.mode === 'manual') await writeBleCommand(OP.manual);
    else if (command.mode === 'auto') await writeBleCommand(OP.auto);
    else throw new Error('Unsupported fan command.');
    sendSocketMessage({ type: 'command-result', id: data.id, ok: true, result: { ok: true } });
  } catch (error) {
    sendSocketMessage({ type: 'command-result', id: data.id, ok: false, error: error.message });
  }
}

function stopLeaseHeartbeat() {
  leaseActive = false;
  clearInterval(leaseHeartbeatTimer);
  leaseHeartbeatTimer = undefined;
}

function sendLeaseHeartbeat() {
  if (!leaseActive) return;
  writeBleCommand(OP.heartbeat).catch((error) => {
    stopLeaseHeartbeat();
    setStatus(`BLE control lease heartbeat failed: ${error.message}`, 'error');
  });
}

function beginLeaseHeartbeat() {
  if (!leaseActive) {
    leaseActive = true;
    leaseHeartbeatTimer = setInterval(sendLeaseHeartbeat, 5000);
  }
  sendLeaseHeartbeat();
}

function closeSocket() {
  stopLeaseHeartbeat();
  clearInterval(bridgePingTimer);
  clearInterval(cloudWatchdogTimer);
  bridgePingTimer = undefined;
  cloudWatchdogTimer = undefined;
  if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
  socket = undefined;
}

function endLocalLease() {
  stopLeaseHeartbeat();
  writeBleCommand(OP.endLease).catch((error) => {
    setStatus(`BLE link lost; the ESP32 will return to Auto when its lease expires: ${error.message}`, 'error');
  });
}

function deviceDisconnected() {
  commandCharacteristic = undefined;
  telemetryCharacteristic = undefined;
  gattServer = undefined;
  closeSocket();
  connectButton.disabled = false;
  disconnectButton.disabled = true;
  setStatus('ESP32 Bluetooth disconnected. Reconnect to restore the bridge.', 'error');
}

async function connectCloudSocket() {
  const wsUrl = new URL('/api/bridge/socket', location.href);
  wsUrl.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('Cloudflare WebSocket connection failed. Check your presenter login and Internet connection.')), { once: true });
  });
  socket.addEventListener('message', (event) => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    if (data.type === 'command') commandFromCloud(data);
    else if (data.type === 'lease-active') beginLeaseHeartbeat();
    else if (data.type === 'bridge-pong') lastCloudPongAt = Date.now();
    else if (data.type === 'lease-ended') {
      stopLeaseHeartbeat();
      writeBleCommand(OP.endLease).catch((error) => setStatus(`Could not return the fan to Auto: ${error.message}`, 'error'));
    }
  });
  socket.addEventListener('close', () => {
    endLocalLease();
    clearInterval(bridgePingTimer);
    clearInterval(cloudWatchdogTimer);
    if (socket) {
      socket = undefined;
      connectButton.disabled = false;
      disconnectButton.disabled = false;
      setStatus('Cloudflare WebSocket disconnected. Local automatic fan control remains active.', 'error');
    }
  });
  lastCloudPongAt = Date.now();
  bridgePingTimer = setInterval(() => sendSocketMessage({ type: 'bridge-ping' }), 10000);
  cloudWatchdogTimer = setInterval(() => {
    if (Date.now() - lastCloudPongAt > 30000) {
      endLocalLease();
      closeSocket();
      connectButton.disabled = false;
      setStatus('Cloudflare did not respond. Reconnect after checking the Internet connection.', 'error');
    }
  }, 5000);
  sendSocketMessage({ type: 'bridge-ping' });
}

async function connectBridge() {
  if (!('bluetooth' in navigator)) {
    setStatus('Web Bluetooth is unavailable. Open this page in Google Chrome on the presenter MacBook.', 'error');
    return;
  }
  connectButton.disabled = true;
  setStatus('Choose the ESP32 and complete Bluetooth pairing…', 'connecting');
  try {
    if (!device?.gatt?.connected) {
      device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [SERVICE_UUID] }],
        optionalServices: [SERVICE_UUID],
      });
      device.addEventListener('gattserverdisconnected', deviceDisconnected);
      gattServer = await device.gatt.connect();
    } else {
      gattServer = device.gatt;
    }
    const service = await gattServer.getPrimaryService(SERVICE_UUID);
    const telemetry = await service.getCharacteristic(TELEMETRY_UUID);
    commandCharacteristic = await service.getCharacteristic(COMMAND_UUID);
    if (telemetryCharacteristic) telemetryCharacteristic.removeEventListener('characteristicvaluechanged', telemetryReceived);
    telemetryCharacteristic = telemetry;
    telemetryCharacteristic.addEventListener('characteristicvaluechanged', telemetryReceived);
    await telemetryCharacteristic.startNotifications();
    await connectCloudSocket();
    connectButton.disabled = true;
    disconnectButton.disabled = false;
    setStatus(`Connected to ${device.name || 'ESP32'} over BLE and Cloudflare WebSocket.`, 'ok');
  } catch (error) {
    closeSocket();
    if (device?.gatt?.connected) device.gatt.disconnect();
    connectButton.disabled = false;
    disconnectButton.disabled = true;
    setStatus(error.message || 'Could not connect to the ESP32 bridge.', 'error');
  }
}

async function disconnectBridge() {
  let releaseWarning = '';
  if (leaseActive) {
    try { await writeBleCommand(OP.endLease); }
    catch (error) { releaseWarning = `BLE release failed; the device watchdog will return to Auto: ${error.message}`; }
  }
  closeSocket();
  if (device?.gatt?.connected) device.gatt.disconnect();
  device = undefined;
  commandCharacteristic = undefined;
  gattServer = undefined;
  connectButton.disabled = false;
  disconnectButton.disabled = true;
  setStatus(releaseWarning || 'Bridge disconnected. ESP32 automatic control continues locally.', releaseWarning ? 'error' : 'disconnected');
}

window.addEventListener('offline', () => {
  endLocalLease();
  closeSocket();
  connectButton.disabled = false;
  setStatus('Internet disconnected. The ESP32 is returning to local Auto control.', 'error');
});

async function initialize() {
  try {
    const response = await fetch('/api/auth/session', { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) throw new Error('Sign in before starting the bridge.');
    const { user } = await response.json();
    if (!user.isPresenter) {
      location.replace('/electronic.html');
      return;
    }
    connectButton.addEventListener('click', connectBridge);
    disconnectButton.addEventListener('click', disconnectBridge);
    setStatus('Presenter verified. Ready to pair with the ESP32.', 'available');
  } catch (error) {
    setStatus(error.message, 'error');
    connectButton.disabled = true;
  }
}

initialize();
