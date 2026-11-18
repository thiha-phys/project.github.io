/*
  Automatic Fan Speed Controller — ESP32-C3 Super Mini

  Temperature measurement and automatic fan control run locally. A paired
  MacBook Chrome bridge uses BLE only for live telemetry and remote commands;
  neither the fan nor its automatic mode depends on Wi-Fi or the Internet.
*/

#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLESecurity.h>
#include <BLE2902.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <esp_random.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>

constexpr uint8_t LM35_PIN = 3;
constexpr uint8_t FAN_PWM_PIN = 10;
constexpr uint8_t I2C_SDA_PIN = 0;
constexpr uint8_t I2C_SCL_PIN = 1;
constexpr uint8_t LCD_COLUMNS = 16;
constexpr uint8_t LCD_ROWS = 2;
constexpr bool ENABLE_LCD = true;

constexpr float MIN_TEMP_C = 20.0f;
constexpr float MAX_TEMP_C = 45.0f;
constexpr uint32_t PWM_FREQUENCY_HZ = 1000;
constexpr uint8_t PWM_RESOLUTION_BITS = 8;
constexpr uint32_t SENSOR_SAMPLE_MS = 1000;
constexpr uint32_t LCD_REFRESH_MS = 1000;
constexpr uint32_t BRIDGE_HEARTBEAT_TIMEOUT_MS = 15000;

constexpr char BLE_DEVICE_NAME[] = "Group2-Fan-Controller";
constexpr char BLE_SERVICE_UUID[] = "7c4a0001-6f4a-4f3d-9a2c-2d7b6e4a1000";
constexpr char BLE_TELEMETRY_UUID[] = "7c4a0002-6f4a-4f3d-9a2c-2d7b6e4a1000";
constexpr char BLE_COMMAND_UUID[] = "7c4a0003-6f4a-4f3d-9a2c-2d7b6e4a1000";

enum ControlOpcode : uint8_t {
  SET_AUTO = 0x01,
  SET_MANUAL = 0x02,
  SET_SPEED = 0x03,
  SET_FAN_OFF = 0x04,
  BRIDGE_HEARTBEAT = 0x05,
  END_CONTROL_LEASE = 0x06
};

struct BleCommand {
  uint8_t opcode;
  uint8_t value;
};

LiquidCrystal_I2C *lcd = nullptr;
BLECharacteristic *telemetryCharacteristic = nullptr;
QueueHandle_t commandQueue = nullptr;
portMUX_TYPE bridgeStateMux = portMUX_INITIALIZER_UNLOCKED;

float temperatureC = NAN;
int fanSpeedPercent = 0;
int manualSpeedPercent = 0;
bool manualFanOff = false;
bool manualMode = false;
bool bridgeLeaseActive = false;
uint32_t lastBridgeHeartbeatMs = 0;
uint32_t lastSensorSampleMs = 0;
uint32_t lastLcdRefreshMs = 0;

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
  analogWrite(FAN_PWM_PIN, map(fanSpeedPercent, 0, 100, 0, 255));
}

void sampleTemperature() {
  uint32_t sumMillivolts = 0;
  constexpr uint8_t samples = 16;
  for (uint8_t i = 0; i < samples; ++i) {
    sumMillivolts += analogReadMilliVolts(LM35_PIN);
    delay(2);
  }
  temperatureC = (sumMillivolts / (float)samples) / 10.0f;
  applyFanOutput();
}

void publishTelemetry() {
  if (!telemetryCharacteristic || isnan(temperatureC)) return;
  const uint16_t temperatureTenths = (uint16_t)constrain(lroundf(temperatureC * 10.0f), 0, 65535);
  const uint8_t payload[] = {
    (uint8_t)(temperatureTenths & 0xff),
    (uint8_t)(temperatureTenths >> 8),
    (uint8_t)constrain(fanSpeedPercent, 0, 100),
    (uint8_t)(manualMode ? 1 : 0),
    (uint8_t)(fanSpeedPercent == 0 ? 1 : 0)
  };
  telemetryCharacteristic->setValue(payload, sizeof(payload));
  telemetryCharacteristic->notify();
}

void writeLcdLine(uint8_t row, const char *text) {
  char line[LCD_COLUMNS];
  memset(line, ' ', sizeof(line));
  const size_t length = min(strlen(text), sizeof(line));
  memcpy(line, text, length);
  lcd->setCursor(0, row);
  for (uint8_t column = 0; column < LCD_COLUMNS; ++column) {
    lcd->write((uint8_t)line[column]);
  }
}

void refreshLcd() {
  if (!lcd) return;
  char line[24];
  if (isnan(temperatureC)) snprintf(line, sizeof(line), "Temp: --.- C");
  else snprintf(line, sizeof(line), "Temp:%5.1f C", temperatureC);
  writeLcdLine(0, line);
  if (fanSpeedPercent == 0) snprintf(line, sizeof(line), "%s Fan: OFF", manualMode ? "Manual" : "Auto");
  else snprintf(line, sizeof(line), "%s Fan:%3d%%", manualMode ? "Manual" : "Auto", fanSpeedPercent);
  writeLcdLine(1, line);
}

class FanServerCallbacks final : public BLEServerCallbacks {
  void onDisconnect(BLEServer *) override {
    BLEDevice::startAdvertising();
  }
};

class FanCommandCallbacks final : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *characteristic) override {
    const String value = characteristic->getValue();
    if (value.length() < 1) return;
    const uint8_t opcode = (uint8_t)value[0];
    if (opcode == BRIDGE_HEARTBEAT) {
      portENTER_CRITICAL(&bridgeStateMux);
      bridgeLeaseActive = true;
      lastBridgeHeartbeatMs = millis();
      portEXIT_CRITICAL(&bridgeStateMux);
      return;
    }

    if (opcode == END_CONTROL_LEASE) {
      portENTER_CRITICAL(&bridgeStateMux);
      bridgeLeaseActive = false;
      portEXIT_CRITICAL(&bridgeStateMux);
      const BleCommand command = { SET_AUTO, 0 };
      if (commandQueue) xQueueSend(commandQueue, &command, 0);
      return;
    }

    if (opcode < SET_AUTO || opcode > SET_FAN_OFF) return;
    const BleCommand command = {
      opcode,
      value.length() > 1 ? (uint8_t)value[1] : 0
    };
    if (commandQueue) xQueueSend(commandQueue, &command, 0);
  }
};

void applyBleCommand(const BleCommand &command) {
  switch (command.opcode) {
    case SET_AUTO:
      manualMode = false;
      manualFanOff = false;
      break;
    case SET_MANUAL:
      manualMode = true;
      manualFanOff = false;
      break;
    case SET_SPEED:
      manualMode = true;
      manualFanOff = false;
      manualSpeedPercent = constrain(command.value, 0, 100);
      break;
    case SET_FAN_OFF:
      manualMode = true;
      manualFanOff = true;
      break;
    default:
      return;
  }
  applyFanOutput();
}

void startBleService() {
  const uint32_t pairingPin = 100000 + (esp_random() % 900000);
  BLEDevice::init(BLE_DEVICE_NAME);
  BLEDevice::setEncryptionLevel(ESP_BLE_SEC_ENCRYPT);
  BLESecurity::setAuthenticationMode(ESP_LE_AUTH_REQ_SC_MITM_BOND);
  BLESecurity::setCapability(ESP_IO_CAP_OUT);
  BLESecurity::setPassKey(true, pairingPin);

  BLEServer *server = BLEDevice::createServer();
  server->setCallbacks(new FanServerCallbacks());
  BLEService *service = server->createService(BLE_SERVICE_UUID);

  telemetryCharacteristic = service->createCharacteristic(
    BLE_TELEMETRY_UUID,
    BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY
  );
  telemetryCharacteristic->setAccessPermissions(ESP_GATT_PERM_READ_ENCRYPTED);
  telemetryCharacteristic->addDescriptor(new BLE2902());
  const uint8_t initialTelemetry[] = { 0, 0, 0, 0, 1 };
  telemetryCharacteristic->setValue(initialTelemetry, sizeof(initialTelemetry));

  BLECharacteristic *commandCharacteristic = service->createCharacteristic(
    BLE_COMMAND_UUID,
    BLECharacteristic::PROPERTY_WRITE
  );
  commandCharacteristic->setAccessPermissions(ESP_GATT_PERM_WRITE_ENCRYPTED);
  commandCharacteristic->setCallbacks(new FanCommandCallbacks());

  service->start();
  BLEAdvertising *advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(BLE_SERVICE_UUID);
  advertising->setScanResponse(true);
  BLEDevice::startAdvertising();

  Serial.printf("BLE device: %s\n", BLE_DEVICE_NAME);
  Serial.printf("BLE pairing PIN (enter on Mac when prompted): %06lu\n", (unsigned long)pairingPin);
}

uint8_t findLcdAddress() {
  for (uint8_t address = 0x20; address <= 0x27; ++address) {
    Wire.beginTransmission(address);
    if (Wire.endTransmission() == 0) return address;
  }
  for (uint8_t address = 0x38; address <= 0x3F; ++address) {
    Wire.beginTransmission(address);
    if (Wire.endTransmission() == 0) return address;
  }
  return 0;
}

void setup() {
  Serial.begin(115200);
  delay(800);
  Serial.println();
  Serial.println("Booting ESP32-C3 BLE Fan Controller...");

  pinMode(FAN_PWM_PIN, OUTPUT);
  analogWriteResolution(FAN_PWM_PIN, PWM_RESOLUTION_BITS);
  analogWriteFrequency(FAN_PWM_PIN, PWM_FREQUENCY_HZ);
  analogWrite(FAN_PWM_PIN, 0);
  analogReadResolution(12);

  if (ENABLE_LCD) {
    const bool pinsConfigured = Wire.setPins(I2C_SDA_PIN, I2C_SCL_PIN);
    const bool i2cStarted = pinsConfigured && Wire.begin();
    Wire.setClock(100000);
    if (!i2cStarted) {
      Serial.println("I2C setup failed; continuing without LCD.");
    } else {
      const uint8_t address = findLcdAddress();
      if (address == 0) {
        Serial.println("LCD not detected; continuing without LCD.");
      } else {
        lcd = new LiquidCrystal_I2C(address, LCD_COLUMNS, LCD_ROWS);
        if (lcd) {
          lcd->init();
          lcd->backlight();
          lcd->clear();
          lcd->setCursor(0, 0);
          lcd->print("Fan Controller");
          lcd->setCursor(0, 1);
          lcd->print("Starting BLE");
        }
      }
    }
  }

  commandQueue = xQueueCreate(8, sizeof(BleCommand));
  if (!commandQueue) {
    Serial.println("Could not create the BLE command queue.");
  }
  startBleService();
  sampleTemperature();
  publishTelemetry();
  refreshLcd();
}

void loop() {
  BleCommand command;
  while (commandQueue && xQueueReceive(commandQueue, &command, 0) == pdTRUE) {
    applyBleCommand(command);
  }

  const uint32_t now = millis();
  portENTER_CRITICAL(&bridgeStateMux);
  const bool leaseExpired = bridgeLeaseActive && now - lastBridgeHeartbeatMs > BRIDGE_HEARTBEAT_TIMEOUT_MS;
  if (leaseExpired) bridgeLeaseActive = false;
  portEXIT_CRITICAL(&bridgeStateMux);
  if (leaseExpired && manualMode) {
    manualMode = false;
    manualFanOff = false;
    applyFanOutput();
  }

  if (now - lastSensorSampleMs >= SENSOR_SAMPLE_MS) {
    lastSensorSampleMs = now;
    sampleTemperature();
    publishTelemetry();
  }
  if (now - lastLcdRefreshMs >= LCD_REFRESH_MS) {
    lastLcdRefreshMs = now;
    refreshLcd();
  }
  delay(2);
}
