# ESP32-C3 BLE Fan Controller

The ESP32-C3 Super Mini reads the LM35 and controls the fan locally. Automatic temperature-based control does not depend on BLE, the MacBook, Wi-Fi, or the Internet. BLE is used only for the presenter's encrypted connection, live telemetry, and approved remote commands.

## Upload the firmware

1. In Arduino IDE, install Espressif's **esp32** platform using the [official setup guide](https://docs.espressif.com/projects/arduino-esp32/en/latest/installing.html).
2. Install **LiquidCrystal I2C** by Frank de Brabander from Library Manager. The BLE libraries are included with the ESP32 Arduino platform.
3. Open `ESP32_Fan_Controller.ino`, select **ESP32C3 Dev Module**, and enable **USB CDC On Boot** if the option is available.
4. Verify and upload the sketch. Open Serial Monitor at 115200 baud. Each boot prints a newly generated six-digit BLE pairing PIN; keep this PIN private and use it only in the macOS pairing prompt.
5. The device advertises as `Group2-Fan-Controller`. It does not create a Wi-Fi access point or HTTP server.

## Start the MacBook bridge

1. Keep the ESP32 powered and within Bluetooth range of the presenter's MacBook.
2. Connect the MacBook to the Internet normally. It does not join an ESP32 hotspot.
3. Sign in to the website with the configured presenter account in current Google Chrome on macOS.
4. Open **Electronics → Open MacBook BLE bridge** (or `/bridge.html`) and select the ESP32.
5. Allow Bluetooth access and enter the six-digit PIN shown in Serial Monitor when prompted. Keep that tab open and the Mac awake throughout the seminar.

The bridge page authenticates to Cloudflare using the presenter's Secure, HttpOnly website session. It forwards BLE notifications to the Cloudflare Durable Object over WebSocket and accepts commands only from that authenticated server connection. Audience phones, tablets, and computers use the website normally and do not need BLE.

If BLE or the Internet is lost, the ESP32 stops receiving the short-lived control-lease heartbeat and returns from manual to temperature-based Auto mode. A presenter can reconnect the bridge from Chrome. To pair after clearing bonds, restart the ESP32 and read its new PIN from Serial Monitor.

## Hardware connections

| Part | ESP32-C3 connection |
|---|---|
| LM35 output | GPIO3 (ADC input) |
| I2C LCD SDA | GPIO0 |
| I2C LCD SCL | GPIO1 |
| Fan-driver input | GPIO10 through the correctly sized base/gate driver |
| LCD address | Automatically detected in the common `0x20–0x27` and `0x38–0x3F` ranges |

The automatic curve uses 20–45 °C: fan off at or below 20 °C, then ramps to full output at 45 °C. Adjust `MIN_TEMP_C` and `MAX_TEMP_C` in the sketch for the project.

## Electrical safety

- GPIO10 is a 3.3 V control signal only. Never connect a fan directly to an ESP32 pin.
- Share ground between the ESP32, LM35, and fan supply. Match the fan's rated voltage.
- Verify the exact transistor pinout and fan current. The referenced H1061's 4 A rating is an absolute maximum; its 2 A saturation test uses 0.2 A base current, which a GPIO through 560 Ω cannot provide. Since the H1061 has become hot, disconnect the fan supply and verify an adequate driver stage before testing again.
- A small rectangular 9 V battery is generally unsuitable for powering a fan.
- Many I2C LCD backpacks pull SDA/SCL up to 5 V. Use a 3.3 V-compatible backpack or bidirectional level shifter.
- GPIO8 is connected to the onboard LED and GPIO9 is the BOOT pin on the pictured Super Mini; this sketch avoids both.
