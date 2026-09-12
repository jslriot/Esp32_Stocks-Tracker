# Stock Tracker

A little stock ticker for an ESP32-S3 + 1.5" SH1107 OLED, with a desktop
companion app for configuration, a portfolio tracker, and historical charts.

## 1. Flash the ESP32

Plug your ESP32-S3 into your computer via USB, then open this page in
**Chrome or Edge** (not Firefox/Safari — they don't support the browser
flashing feature this uses):

**[https://jslriot.github.io/Esp32_Stocks-Tracker/](https://jslriot.github.io/Esp32_Stocks-Tracker/)**

Click the install button, pick the right serial port when your browser
asks, and wait for it to finish. The device reboots into the new firmware
automatically. No software to install, no Arduino IDE, no terminal.

## 2. Install the desktop app

Go to the [Releases page](../../releases) and download the installer for
your OS:

- **Windows** — `Stock-Tracker-Setup-x.x.x.exe`
- **macOS** — `Stock-Tracker-x.x.x.dmg`
- **Linux** — `Stock-Tracker-x.x.x.AppImage`

Double-click to install. The app checks for updates automatically and will
prompt you to restart when a new version is ready.

## 3. Connect them

Open the app — it looks for your device on the local network automatically
(or you can type in its IP address). From there you can set your Finnhub
API key, pick which stocks to track, manage your portfolio, and push future
firmware updates wirelessly, all from the app.

## Hardware

- ESP32-S3 dev board
- 1.5" SH1107 128x128 OLED, I2C (SDA → GPIO8, SCL → GPIO9 by default)
- A free [Finnhub.io](https://finnhub.io) API key for stock quotes

## License

MIT — see [LICENSE](LICENSE).
