# Stock Tracker

A little stock ticker for an ESP32-S3 + 1.5" SH1107 OLED, with a desktop
companion app for configuration, a portfolio tracker, and historical charts.

## For end users — installing the app

Go to the [Releases page](../../releases) and download the installer for
your OS:

- **Windows** — `Stock-Tracker-Setup-x.x.x.exe`
- **macOS** — `Stock-Tracker-x.x.x.dmg`
- **Linux** — `Stock-Tracker-x.x.x.AppImage`

Double-click to install, no terminal needed. The app checks for updates
automatically and will prompt you to restart when a new version is ready.

## Flashing the ESP32

**Brand new board?** Go to `https://jslriot.github.io/Esp32_Stocks-Tracker/`
and click the install button — flashes directly from Chrome or Edge over
USB, no software install at all. (One-time setup for you as the repo owner:
after your first release, go to Settings > Pages and set the source to the
`gh-pages` branch, root folder — CI creates and updates that branch
automatically on every release after that.)

**Prefer Arduino IDE, or want to modify the code first?**

1. Open `firmware/stock_tracker/stock_tracker.ino` in Arduino IDE.
2. Install these libraries via Library Manager: Adafruit GFX Library,
   Adafruit SH110X, ArduinoJson.
3. Board: ESP32S3 Dev Module. **Tools > Partition Scheme**: pick one with
   OTA support (e.g. "Default 4MB with spiffs") so wireless updates work
   later.
4. Flash once over USB. After that, updates can be pushed wirelessly from
   the app's Firmware tab — either a local `.bin` you exported yourself, or
   automatically from this repo's own GitHub Releases (see below).

## Hardware

- ESP32-S3 dev board
- 1.5" SH1107 128x128 OLED, I2C (SDA → GPIO8, SCL → GPIO9 by default)
- Finnhub.io API key (free tier) for stock quotes

## Firmware auto-update checks

In the app's Firmware tab, enter this repo as `owner/repo` (e.g.
`yourname/stock-tracker`) and click "Check for updates". It looks at this
repo's latest GitHub Release for a `.bin` file, and if it's newer than
what's on your device, offers a one-click install — no cable, no Arduino
IDE.

## Repo structure

```
firmware/stock_tracker/stock_tracker.ino   the ESP32 sketch
app/                                       the Electron desktop app
web-flash/                                 browser-flashing page (ESP Web
                                            Tools) — CI deploys this to
                                            GitHub Pages on every release
.github/workflows/release.yml              CI: builds installers + firmware
                                            on every version tag, publishes
                                            to GitHub Releases and Pages
```

## Maintainer notes — cutting a release

1. Bump the version in `app/package.json` and `FW_VERSION` in the firmware
   sketch to match (keeping them in sync isn't required, but makes the tag
   describe both meaningfully).
2. Before your first release, edit `app/package.json`: replace
   `jslriot` / `Esp32_Stocks-Tracker` in both the `repository` field
   and `build.publish` with your actual GitHub username and repo name — the
   app's auto-updater and CI publishing both depend on this being correct.
3. Commit, then tag and push:
   ```
   git add -A && git commit -m "Release v2.4.0"
   git tag v2.4.0
   git push origin main --tags
   ```
4. GitHub Actions picks up the tag, builds installers for all three
   platforms plus the firmware `.bin`/`.merged.bin`, attaches them all to a
   new Release automatically, and updates the browser-flashing page on
   GitHub Pages. Takes a few minutes — check the Actions tab.

### Developing locally

```
cd app
npm install
npm start
```

## License

MIT — see [LICENSE](LICENSE).
