# Presenter MacBook BLE bridge

The bridge runs in the presenter's Chrome tab at `/bridge.html`; it is not a Python process and it does not connect to an ESP32 Wi-Fi hotspot. The ESP32 advertises an encrypted BLE service, and Chrome relays its live readings and Cloudflare-authorized commands through the presenter's authenticated WebSocket session.

Keep the tab open and the MacBook awake for the seminar. If the tab, BLE link, or Internet connection drops, the ESP32's local lease watchdog returns the fan to automatic temperature-based control. Reconnect from the page to resume telemetry and remote commands.

The bridge requires HTTPS (or localhost during development), current Chrome on macOS, a presenter account configured with `PRESENTER_USER_ID`, and Bluetooth access. Pairing requires the temporary six-digit PIN printed by the ESP32 at boot.
