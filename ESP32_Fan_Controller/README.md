# ESP32 Fan Controller

This folder contains one self-contained Arduino sketch. It replaces the old Nano/Nokia 5110 program with ESP32, LM35, a 16x2 I2C LCD, and a locally hosted Wi-Fi control page. No API key or internet service is used for fan control.

## Arduino IDE setup

1. In Arduino IDE, install the **esp32** platform from Boards Manager. Espressif's official setup guide is at <https://docs.espressif.com/projects/arduino-esp32/en/latest/installing.html>.
2. In Library Manager, install **LiquidCrystal I2C** by Frank de Brabander.
3. Open `ESP32_Fan_Controller.ino`.
4. Select **ESP32C3 Dev Module** (the board is an ESP32-C3 Super Mini, not a classic ESP32 DevKit). If shown, enable **USB CDC On Boot** so USB Serial Monitor works.
5. Use **Verify** to compile. Connect the board by USB and choose its port only when you are ready to upload.

## Phone connection after upload

1. Power the programmed ESP32. It creates Wi-Fi named `FanController`; password in this sketch: `mdyphysgp2`.
2. Join that Wi-Fi on the phone. The phone may warn that the Wi-Fi has no internet; choose to stay connected.
3. Open `http://192.168.4.1/` in the phone browser.
4. Press **Claim fan controls** on that page. Auto and Manual then become available. Manual mode has a speed slider and Fan Off button. One controller is allowed at a time; its lock expires after 20 seconds without a heartbeat.

This is separate from the GitHub Pages academic showcase. The live page is served by the ESP32 itself, so the phone remains on the ESP32 Wi-Fi while using the controls.

## Pin defaults

| Part | ESP32 connection |
|---|---|
| LM35 output | Board pin `3` / GPIO3 (ADC input) |
| I2C LCD SDA | Board pin `0` / GPIO0 |
| I2C LCD SCL | Board pin `1` / GPIO1 |
| Fan-driver base resistor input | Board pin `10` / GPIO10 |
| LCD address | `0x27` (change to `0x3F` if needed) |

The sketch uses the original 20–35 °C range: fan off at or below 20 °C, then ramps to full output at 35 °C. Change `MIN_TEMP_C` and `MAX_TEMP_C` in the sketch if the project needs different thresholds.

## Hardware cautions before powering the fan

- The ESP32-C3 GPIO is 3.3 V logic. GPIO10 must go through the base resistor to the transistor; never connect the fan to a GPIO.
- The LM35 output goes to GPIO3, not its 5 V supply pin. Join the sensor, ESP32, and fan-supply grounds.
- A common 2SC828/C828 datasheet lists 50 mA continuous collector current. Check the exact transistor and the fan's startup/current label first. If the fan needs more than the transistor's safe rating, this C828 circuit is not suitable; use a higher-current NPN driver while retaining the no-MOSFET design.
- Match the fan's rated voltage. A 10 V fan on a 9 V supply may fail to start. A small rectangular 9 V battery is generally not a suitable fan supply.
- Confirm the transistor's E/C/B pin order for the exact part before wiring; package pinouts can differ.
- Many I2C LCD backpacks pull SDA/SCL up to 5 V. Use a 3.3 V-compatible backpack or a bidirectional level shifter so the ESP32 pins do not receive 5 V.
- GPIO8 is connected to the onboard LED and GPIO9 is the BOOT pin on the pictured Super Mini layout; this sketch avoids both pins.
