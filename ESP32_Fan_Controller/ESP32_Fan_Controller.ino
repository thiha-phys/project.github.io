/*
  Automatic Fan Speed Controller — ESP32

  Adapted from the 2020 Arduino/Nokia 5110 sketch for:
    - ESP32 Arduino core
    - LM35 temperature sensor
    - 16x2 I2C LCD
    - NPN transistor fan driver (no MOSFET)
    - ESP32 Wi-Fi hotspot and local control page

  Before uploading:
    1. Install the "LiquidCrystal I2C" library by Frank de Brabander.
    2. Select your ESP32 board (usually "ESP32 Dev Module") in Arduino IDE.
    3. Change the Wi-Fi password below if desired (8 characters minimum).
    4. Confirm the pin assignments for your exact ESP32 board.

  Safety: GPIO25 is a 3.3 V logic signal for a transistor base resistor only.
  Do not connect the fan directly to an ESP32 GPIO. Fan supply ground and
  ESP32 ground must be common. Verify fan current and transistor ratings before
  powering the fan; many C828/2SC828 parts are rated for only 50 mA continuous.
*/

#include <WiFi.h>
#include <WebServer.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>

// ---------- User-adjustable hardware settings ----------
constexpr uint8_t LM35_PIN = 34;       // ADC1 input-only pin on common ESP32 DevKit
constexpr uint8_t FAN_PWM_PIN = 25;     // Through a base resistor to NPN transistor
constexpr uint8_t I2C_SDA_PIN = 21;
constexpr uint8_t I2C_SCL_PIN = 22;
constexpr uint8_t LCD_I2C_ADDRESS = 0x27; // Common alternatives: 0x3F
constexpr uint8_t LCD_COLUMNS = 16;
constexpr uint8_t LCD_ROWS = 2;

const char *AP_SSID = "FanController";
const char *AP_PASSWORD = "FanGroup2"; // At least 8 characters

constexpr float MIN_TEMP_C = 20.0f;
constexpr float MAX_TEMP_C = 35.0f;
constexpr uint32_t PWM_FREQUENCY_HZ = 1000; // Near the original Arduino Nano PWM range
constexpr uint8_t PWM_RESOLUTION_BITS = 8; // analogWrite range: 0..255
constexpr uint32_t SENSOR_SAMPLE_MS = 1000;
constexpr uint32_t LCD_REFRESH_MS = 1000;
constexpr uint32_t CONTROL_LEASE_MS = 20000;

LiquidCrystal_I2C lcd(LCD_I2C_ADDRESS, LCD_COLUMNS, LCD_ROWS);
WebServer server(80);

float temperatureC = NAN;
int fanSpeedPercent = 0;
int manualSpeedPercent = 0;
bool manualFanOff = false;
bool manualMode = false;
bool controllerOccupied = false;
String controlToken;
String controlClientId;
uint32_t lastHeartbeatMs = 0;
uint32_t lastSensorSampleMs = 0;
uint32_t lastLcdRefreshMs = 0;

const char INDEX_HTML[] PROGMEM = R"HTML(
<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#10251e"><title>Fan Controller</title>
<style>
:root{color-scheme:light;--ink:#10251e;--muted:#728078;--line:#e1e5dc;--paper:#f5f6f0;--green:#193b2f;--gold:#a58a54}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.55 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:820px;margin:auto;padding:22px}.card{background:#fffefa;border:1px solid var(--line);border-radius:24px;padding:clamp(22px,5vw,42px);margin:14px 0;box-shadow:0 14px 40px #10251e0a}
.eyebrow{letter-spacing:.16em;font-size:.74rem;font-weight:800;color:var(--gold)}h1{font:clamp(2rem,7vw,3.1rem)/1.05 Georgia,serif;margin:.35rem 0 1rem}h2{font:clamp(1.5rem,5vw,2rem)/1.15 Georgia,serif;margin:.2rem 0 1rem}.muted{color:var(--muted)}
.readings{display:grid;grid-template-columns:1fr 1fr;gap:12px}.reading{background:#f2f4ed;border-radius:18px;padding:18px}.label{font-size:.78rem;font-weight:750;letter-spacing:.08em;color:var(--muted)}.big{display:block;font-size:clamp(2.1rem,9vw,3.5rem);font-weight:750;line-height:1.2;margin-top:5px}
.bar{height:12px;background:#edf0e8;border-radius:20px;overflow:hidden;margin-top:12px}.bar span{display:block;height:100%;width:0;background:linear-gradient(90deg,#9bba87,#193b2f);transition:width .25s}
.status{padding:13px 15px;background:#f2f4ed;border-radius:13px;color:#4c6255;margin:16px 0}.status.error{background:#fff0eb;color:#b33d29}.status.ok{background:#eaf4e9;color:#315b3e}
button{font:inherit;font-weight:750;border:0;border-radius:12px;padding:14px 18px;cursor:pointer;background:var(--green);color:white}button:disabled{opacity:.48;cursor:not-allowed}.wide{width:100%}.modes{display:grid;grid-template-columns:1fr 1fr;background:#eff1eb;border-radius:14px;padding:5px;margin:12px 0}.modes button{background:transparent;color:var(--muted)}.modes button.active{background:#75827b;color:#fff}.row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:16px 0 4px}.slider{width:100%;accent-color:var(--green)}.off{background:#fff2ed;border:1px solid #efcfc4;color:#a34432}.instructions{padding-left:1.3rem;color:var(--muted)}code{background:#f0f2eb;padding:3px 7px;border-radius:5px}
@media(max-width:480px){main{padding:12px}.card{border-radius:18px;padding:22px 18px}.readings{gap:8px}.reading{padding:13px}}
</style></head><body><main>
<section class="card"><p class="eyebrow">MANDALAY UNIVERSITY · DEPARTMENT OF PHYSICS</p><h1>Automatic Fan<br>Speed Controller</h1><p class="muted">ESP32 · LM35 · 9V DC fan</p>
<div class="readings"><div class="reading"><span class="label">ROOM TEMPERATURE</span><strong class="big" id="temp">--.-°C</strong></div><div class="reading"><span class="label">FAN OUTPUT</span><strong class="big" id="speed">--%</strong><div class="bar"><span id="bar"></span></div></div></div>
<p class="status" id="status">Device ready. Claim the controls to begin.</p><button class="wide" id="claim">Claim fan controls</button></section>
<section class="card"><p class="eyebrow">FAN SETTINGS</p><h2>Control Panel</h2><div class="modes"><button id="auto" class="active" disabled>Auto</button><button id="manual" disabled>Manual</button></div>
<div class="row"><label for="slider">Manual fan speed</label><strong id="speedLabel">0%</strong></div><input class="slider" id="slider" type="range" min="0" max="100" value="0" disabled><div class="row muted"><small>0% · STOP</small><small>100% · MAX</small></div><button class="off" id="off" disabled>■ &nbsp; Fan Off</button></section>
<section class="card"><p class="eyebrow">HOW TO CONNECT</p><ol class="instructions"><li>In phone Wi-Fi settings, join <b>FanController</b> (password: <b>FanGroup2</b>).</li><li>Stay on that Wi-Fi, open your browser and visit <code>http://192.168.4.1/</code>.</li><li>Press <b>Claim fan controls</b>. Use Auto or Manual on this same page.</li></ol><p class="muted">This page is hosted by the ESP32. No internet connection, GitHub page, or API key is required for local fan control.</p></section>
</main><script>
let token=sessionStorage.getItem('fanToken')||'',clientId=sessionStorage.getItem('fanClient')||('client-'+Math.random().toString(16).slice(2));sessionStorage.setItem('fanClient',clientId);let connected=false,mode='auto';
const $=id=>document.getElementById(id),status=(text,kind='')=>{$('status').textContent=text;$('status').className='status '+kind};
async function api(path,body){const r=await fetch(path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,cache:'no-store'});const d=await r.json();if(!r.ok)throw Object.assign(new Error(d.code==='in_use'?'Another user already has control.':'Device request failed.'),{code:d.code});return d}
function render(d){$('temp').textContent=Number(d.temperatureC).toFixed(1)+'°C';$('speed').textContent=d.fanOff?'OFF':d.fanSpeed+'%';$('bar').style.width=d.fanSpeed+'%';mode=d.mode;$('auto').classList.toggle('active',mode==='auto');$('manual').classList.toggle('active',mode==='manual');$('slider').value=d.fanSpeed;$('speedLabel').textContent=d.fanSpeed+'%';$('auto').disabled=!connected;$('manual').disabled=!connected;$('slider').disabled=!connected||mode!=='manual';$('off').disabled=!connected||mode!=='manual'}
async function refresh(){try{let d=await api('/api/status',token?{token}:null);render(d);if(!connected&&d.occupied){$('claim').disabled=true;status('Another user currently has control. Please wait until they release it.','error')}else if(!connected){$('claim').disabled=false;status('ESP32 is online. Claim the controls when ready.','ok')}}catch(e){status('ESP32 did not respond. Check that you are connected to its Wi-Fi.','error')}}
$('claim').onclick=async()=>{if(connected){try{await api('/api/disconnect',{token})}catch(e){}connected=false;token='';sessionStorage.removeItem('fanToken');$('claim').textContent='Claim fan controls';$('claim').disabled=false;status('Control released.');render({temperatureC:Number($('temp').textContent)||0,fanSpeed:0,mode:'auto',fanOff:true});return} $('claim').disabled=true;status('Connecting to ESP32…');try{const d=await api('/api/connect',{clientId});token=d.token;sessionStorage.setItem('fanToken',token);connected=true;$('claim').textContent='Release control';$('claim').disabled=false;status('Connected. You have control of this fan.','ok');render(await api('/api/status',{token}))}catch(e){status(e.code==='in_use'?'Another user already has control.':'Could not connect. Check the hotspot and reload this page.','error');$('claim').disabled=e.code==='in_use'}};
$('auto').onclick=async()=>{try{await api('/api/control',{token,mode:'auto'});render(await api('/api/status',{token}))}catch(e){status(e.message,'error')}};$('manual').onclick=async()=>{try{await api('/api/control',{token,mode:'manual'});render(await api('/api/status',{token}))}catch(e){status(e.message,'error')}};
$('slider').oninput=()=>$('speedLabel').textContent=$('slider').value+'%';$('slider').onchange=async()=>{try{await api('/api/control',{token,speed:Number($('slider').value)});render(await api('/api/status',{token}))}catch(e){status(e.message,'error')}};$('off').onclick=async()=>{try{await api('/api/control',{token,off:true});render(await api('/api/status',{token}))}catch(e){status(e.message,'error')}};
setInterval(async()=>{if(connected){try{await api('/api/heartbeat',{token});render(await api('/api/status',{token}))}catch(e){connected=false;token='';sessionStorage.removeItem('fanToken');$('claim').textContent='Claim fan controls';status('Control connection lost. Claim controls again.','error')}}else await refresh()},5000);refresh();
</script></body></html>
)HTML";

// Small helpers for the simple JSON messages sent by the control page.
String jsonString(const String &body, const char *key) {
  const String needle = String("\"") + key + "\"";
  int p = body.indexOf(needle);
  if (p < 0) return "";
  p = body.indexOf(':', p + needle.length());
  if (p < 0) return "";
  p = body.indexOf('"', p + 1);
  if (p < 0) return "";
  int end = body.indexOf('"', p + 1);
  return end < 0 ? "" : body.substring(p + 1, end);
}

bool hasTrue(const String &body, const char *key) {
  const String needle = String("\"") + key + "\"";
  int p = body.indexOf(needle);
  if (p < 0) return false;
  p = body.indexOf(':', p + needle.length());
  if (p < 0) return false;
  String value = body.substring(p + 1);
  value.trim();
  return value.startsWith("true");
}

int jsonInteger(const String &body, const char *key, int fallback) {
  const String needle = String("\"") + key + "\"";
  int p = body.indexOf(needle);
  if (p < 0) return fallback;
  p = body.indexOf(':', p + needle.length());
  if (p < 0) return fallback;
  return body.substring(p + 1).toInt();
}

void sendJson(int code, const String &json) {
  server.sendHeader("Cache-Control", "no-store");
  server.send(code, "application/json", json);
}

String statusJson(bool granted) {
  String temp = isnan(temperatureC) ? "null" : String(temperatureC, 1);
  String json = "{\"temperatureC\":" + temp +
    ",\"temperature\":" + temp +
    ",\"fanSpeed\":" + String(fanSpeedPercent) +
    ",\"speed\":" + String(fanSpeedPercent) +
    ",\"mode\":\"" + String(manualMode ? "manual" : "auto") + "\"" +
    ",\"fanOff\":" + String(fanSpeedPercent == 0 ? "true" : "false") +
    ",\"occupied\":" + String(controllerOccupied && !granted ? "true" : "false") +
    ",\"controlGranted\":" + String(granted ? "true" : "false") + "}";
  return json;
}

bool validController(const String &body) {
  const String token = jsonString(body, "token");
  return controllerOccupied && token.length() > 0 && token == controlToken;
}

void releaseController() {
  controllerOccupied = false;
  controlToken = "";
  controlClientId = "";
}

void applyFanOutput() {
  if (manualMode) {
    fanSpeedPercent = manualFanOff ? 0 : manualSpeedPercent;
  } else if (isnan(temperatureC) || temperatureC <= MIN_TEMP_C) {
    fanSpeedPercent = 0;
  } else if (temperatureC >= MAX_TEMP_C) {
    fanSpeedPercent = 100;
  } else {
    fanSpeedPercent = (int)lroundf((temperatureC - MIN_TEMP_C) * 100.0f /
                                   (MAX_TEMP_C - MIN_TEMP_C));
  }
  const int pwm = map(fanSpeedPercent, 0, 100, 0, 255);
  analogWrite(FAN_PWM_PIN, pwm);
}

void sampleTemperature() {
  // analogReadMilliVolts() uses the ESP32 ADC calibration when available.
  uint32_t sumMillivolts = 0;
  constexpr uint8_t samples = 16;
  for (uint8_t i = 0; i < samples; ++i) {
    sumMillivolts += analogReadMilliVolts(LM35_PIN);
    delay(2);
  }
  const float millivolts = sumMillivolts / (float)samples;
  temperatureC = millivolts / 10.0f; // LM35: 10 mV per degree Celsius
  applyFanOutput();
}

void refreshLcd() {
  lcd.setCursor(0, 0);
  lcd.print("Temp: ");
  if (isnan(temperatureC)) lcd.print("--.-");
  else {
    char tempText[8];
    snprintf(tempText, sizeof(tempText), "%4.1f", temperatureC);
    lcd.print(tempText);
  }
  lcd.print(" C   ");
  lcd.setCursor(0, 1);
  if (manualMode) lcd.print("Manual ");
  else lcd.print("Auto   ");
  if (fanSpeedPercent == 0) lcd.print("OFF     ");
  else {
    char speedText[8];
    snprintf(speedText, sizeof(speedText), "%3d%%       ", fanSpeedPercent);
    lcd.print(speedText);
  }
}

void handleRoot() {
  server.sendHeader("Cache-Control", "no-store");
  server.send_P(200, "text/html", INDEX_HTML);
}

void handleStatus() {
  bool granted = false;
  if (server.method() == HTTP_POST) {
    const String body = server.arg("plain");
    if (validController(body)) {
      lastHeartbeatMs = millis();
      granted = true;
    }
  }
  sendJson(200, statusJson(granted));
}

void handleConnect() {
  const String body = server.arg("plain");
  const String clientId = jsonString(body, "clientId");
  if (controllerOccupied && millis() - lastHeartbeatMs > CONTROL_LEASE_MS) {
    releaseController();
  }
  if (controllerOccupied && clientId != controlClientId) {
    sendJson(423, "{\"code\":\"in_use\",\"occupied\":true}");
    return;
  }
  if (!controllerOccupied) {
    controllerOccupied = true;
    controlClientId = clientId;
    char tokenBuffer[17];
    snprintf(tokenBuffer, sizeof(tokenBuffer), "%08lx%08lx",
             (unsigned long)esp_random(), (unsigned long)esp_random());
    controlToken = tokenBuffer;
  }
  lastHeartbeatMs = millis();
  sendJson(200, "{\"ok\":true,\"token\":\"" + controlToken + "\"}");
}

void handleHeartbeat() {
  const String body = server.arg("plain");
  if (!validController(body)) {
    sendJson(403, "{\"ok\":false,\"code\":\"invalid_token\"}");
    return;
  }
  lastHeartbeatMs = millis();
  sendJson(200, "{\"ok\":true}");
}

void handleDisconnect() {
  const String body = server.arg("plain");
  if (validController(body)) releaseController();
  sendJson(200, "{\"ok\":true}");
}

void handleControl() {
  const String body = server.arg("plain");
  if (!validController(body)) {
    sendJson(403, "{\"ok\":false,\"code\":\"invalid_token\"}");
    return;
  }
  lastHeartbeatMs = millis();
  const String requestedMode = jsonString(body, "mode");
  if (requestedMode == "auto") {
    manualMode = false;
    manualFanOff = false;
  } else if (requestedMode == "manual") {
    manualMode = true;
    manualFanOff = false;
  } else if (body.indexOf("\"speed\"") >= 0) {
    manualMode = true;
    manualFanOff = false;
    manualSpeedPercent = constrain(jsonInteger(body, "speed", 0), 0, 100);
  } else if (hasTrue(body, "off")) {
    manualMode = true;
    manualFanOff = true;
  }
  applyFanOutput();
  sendJson(200, "{\"ok\":true}");
}

void setup() {
  Serial.begin(115200);
  pinMode(FAN_PWM_PIN, OUTPUT);
  analogWriteResolution(FAN_PWM_PIN, PWM_RESOLUTION_BITS);
  analogWriteFrequency(FAN_PWM_PIN, PWM_FREQUENCY_HZ);
  analogWrite(FAN_PWM_PIN, 0); // Keep fan output off during startup.

  analogReadResolution(12);
  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
  lcd.init();
  lcd.backlight();
  lcd.setCursor(0, 0);
  lcd.print("Fan Controller");
  lcd.setCursor(0, 1);
  lcd.print("Starting Wi-Fi");

  WiFi.mode(WIFI_AP);
  WiFi.softAPConfig(IPAddress(192, 168, 4, 1), IPAddress(192, 168, 4, 1),
                    IPAddress(255, 255, 255, 0));
  const bool apStarted = WiFi.softAP(AP_SSID, AP_PASSWORD);

  server.on("/", HTTP_GET, handleRoot);
  server.on("/api/status", HTTP_GET, handleStatus);
  server.on("/api/status", HTTP_POST, handleStatus);
  server.on("/api/connect", HTTP_POST, handleConnect);
  server.on("/api/heartbeat", HTTP_POST, handleHeartbeat);
  server.on("/api/disconnect", HTTP_POST, handleDisconnect);
  server.on("/api/control", HTTP_POST, handleControl);
  server.onNotFound([]() { sendJson(404, "{\"error\":\"not_found\"}"); });
  server.begin();

  Serial.println();
  Serial.println("ESP32 Fan Controller ready");
  Serial.printf("Hotspot: %s\nPassword: %s\n", AP_SSID, AP_PASSWORD);
  Serial.printf("Web page: http://%s/\n", WiFi.softAPIP().toString().c_str());
  Serial.printf("Hotspot started: %s\n", apStarted ? "yes" : "no");
  sampleTemperature();
  refreshLcd();
}

void loop() {
  server.handleClient();
  const uint32_t now = millis();
  if (controllerOccupied && now - lastHeartbeatMs > CONTROL_LEASE_MS) {
    releaseController();
  }
  if (now - lastSensorSampleMs >= SENSOR_SAMPLE_MS) {
    lastSensorSampleMs = now;
    sampleTemperature();
  }
  if (now - lastLcdRefreshMs >= LCD_REFRESH_MS) {
    lastLcdRefreshMs = now;
    refreshLcd();
  }
}

