/*
  ESP32-S3 Stock Tracker — v2.1: market hours + currency conversion
  --------------------------------------------------
  Display : 1.5" SH1107 128x128 OLED, I2C
  Data src: Finnhub.io free API (https://finnhub.io)

  WHAT'S NEW vs v2.0:
    - Market status: a small dot top-left on every stock screen (filled =
      open, hollow = closed), plus a dedicated "MARKET" slide at the end
      of each cycle showing OPEN/CLOSED, the current session, and — when
      closed — the estimated next open time ("Tomorrow 9:30 AM ET"). This
      covers the US market (NYSE/NASDAQ); it'll be approximate for other
      exchanges. Uses NTP (auto DST via a POSIX TZ string) + Finnhub's
      market-status endpoint, refreshed every 5 minutes.

    - Real currency conversion: pick a currency code (USD, EUR, GBP, JPY,
      INR, etc.) from the app, and displayed prices/changes are converted
      using a live USD exchange rate (Finnhub forex rates, refreshed every
      30 min). Quotes are still fetched and stored internally in USD —
      only the display and API output are converted — so switching
      currency doesn't cost extra API calls to Finnhub's quote endpoint.

  Carried over from v2.0:
    - OTA firmware updates, two ways:
        1) From the desktop app: Settings > Firmware lets you pick a
           compiled .bin and push it straight to the device over WiFi
           (POST to /update). No cable needed after the first flash.
        2) From Arduino IDE: with ArduinoOTA running, the board shows
           up under Tools > Port as a network port ("stocktracker at
           x.x.x.x") so you can upload sketches wirelessly too.
      IMPORTANT: in Arduino IDE, set Tools > Partition Scheme to one
      that includes OTA (e.g. "Default 4MB with spiffs (1.2MB APP/...)")
      or the /update endpoint won't have room to write the new firmware.
    - invertDisplay, rotation, apPassword, alertThreshold settings.
    - Firmware version exposed via /api/status and /api/config.

  Libraries required (Arduino IDE Library Manager):
    - Adafruit GFX Library
    - Adafruit SH110X
    - ArduinoJson (v7.x)
    (WiFi, WebServer, DNSServer, Preferences, ESPmDNS, ArduinoOTA,
    Update, time.h are built into the ESP32 core)

  Wiring (adjust to your board):
    OLED SDA -> GPIO8
    OLED SCL -> GPIO9
    OLED VCC -> 3V3
    OLED GND -> GND
*/

#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SH110X.h>
#include <WiFi.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <Preferences.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <ESPmDNS.h>
#include <ArduinoOTA.h>
#include <Update.h>
#include <time.h>

// ---------------- HARDWARE CONFIG ----------------
#define OLED_SDA  8
#define OLED_SCL  9
#define OLED_ADDR 0x3C
#define SCREEN_W 128
#define SCREEN_H 128
#define BOOT_BUTTON_PIN 0

#define MAX_SYMBOLS 8
#define HISTORY_LEN 40

#define AP_SSID "StockTracker-Setup"
#define MDNS_HOSTNAME "stocktracker"
#define FW_VERSION "2.3.1"

// US market hours reference (NYSE/NASDAQ). NTP + this POSIX TZ string handles
// EST/EDT daylight saving automatically. If you track non-US exchanges, the
// open/close estimate on the market-status slide won't be accurate for them.
#define NTP_SERVER "pool.ntp.org"
#define TZ_INFO "EST5EDT,M3.2.0,M11.1.0"
// --------------------------------------------------

Adafruit_SH1107 display(SCREEN_W, SCREEN_H, &Wire, -1);
Preferences prefs;
WebServer server(80);
DNSServer dnsServer;

// ---------------- RUNTIME CONFIG (loaded from flash) ----------------
String cfgSSID, cfgPASS, cfgApiKey, cfgApPassword, cfgCurrencyCode;
String symbolList[MAX_SYMBOLS];
int symbolCount = 0;
unsigned long fetchIntervalMs = 60000;
unsigned long cycleIntervalMs = 5000;
bool cfgInvert = false;
int cfgRotation = 0;         // 0 or 2 (Adafruit_GFX rotation steps, 2 = 180deg)
float cfgAlertThreshold = 0; // percent; 0 = disabled
bool cfgMarketAwareMode = false; // true: park on the MARKET slide while closed, jump to
                                  // stocks the moment it opens. false: keep cycling
                                  // through everything regardless of market status.
// ----------------------------------------------------------------------

bool apMode = false;
bool otaInProgress = false;

// ---------------- Currency conversion ----------------
// Quotes always come back from Finnhub in the exchange's native currency
// (USD for US-listed stocks). We keep raw USD internally and only convert
// for display/API output, using a rate refreshed periodically.
float cfgExchangeRate = 1.0;
unsigned long lastFxCheck = 0;
const unsigned long FX_CHECK_INTERVAL_MS = 30UL * 60UL * 1000UL; // 30 min

// ---------------- Market status ----------------
bool marketOpen = false;
String marketSession = "";   // "regular", "pre-market", "post-market", or ""
String marketHoliday = "";   // holiday name if closed for one today, else ""
unsigned long lastMarketCheck = 0;
const unsigned long MARKET_CHECK_INTERVAL_MS = 5UL * 60UL * 1000UL; // 5 min
bool prevMarketOpenState = false;

struct StockData {
  float price = 0, change = 0, percent = 0;
  bool valid = false;
  float history[HISTORY_LEN] = {0};
  int historyCount = 0;
};
StockData stocks[MAX_SYMBOLS];
unsigned long lastFetch[MAX_SYMBOLS] = {0};
int currentIndex = 0;
unsigned long lastCycle = 0;

// ======================= CONFIG STORAGE =======================

struct FullConfig {
  String ssid, pass, apikey, apPassword, currencyCode, symbolsCSV;
  unsigned int fetchSec, cycleSec;
  bool invert;
  int rotation;
  float alertThreshold;
  bool marketAwareMode;
};

void loadConfig() {
  prefs.begin("stocktracker", true);
  cfgSSID        = prefs.getString("ssid", "");
  cfgPASS        = prefs.getString("pass", "");
  cfgApiKey      = prefs.getString("apikey", "");
  cfgApPassword  = prefs.getString("appass", "");
  cfgCurrencyCode = prefs.getString("currcode", "USD");
  String symbolsCSV = prefs.getString("symbols", "AAPL,TSLA,MSFT,GOOGL");
  fetchIntervalMs   = (unsigned long)prefs.getUInt("fetchsec", 60) * 1000UL;
  cycleIntervalMs   = (unsigned long)prefs.getUInt("cyclesec", 5) * 1000UL;
  cfgInvert         = prefs.getBool("invert", false);
  cfgRotation       = prefs.getInt("rotation", 0);
  cfgAlertThreshold = prefs.getFloat("alertpct", 0.0);
  cfgMarketAwareMode = prefs.getBool("mktmode", false);
  prefs.end();

  symbolCount = 0;
  int start = 0;
  while (start < (int)symbolsCSV.length() && symbolCount < MAX_SYMBOLS) {
    int comma = symbolsCSV.indexOf(',', start);
    String tok = (comma == -1) ? symbolsCSV.substring(start) : symbolsCSV.substring(start, comma);
    tok.trim();
    tok.toUpperCase();
    if (tok.length() > 0) symbolList[symbolCount++] = tok;
    if (comma == -1) break;
    start = comma + 1;
  }
  if (symbolCount == 0) {
    symbolList[0] = "AAPL";
    symbolCount = 1;
  }
}

void saveFullConfig(const FullConfig &c) {
  prefs.begin("stocktracker", false);
  prefs.putString("ssid", c.ssid);
  prefs.putString("pass", c.pass);
  prefs.putString("apikey", c.apikey);
  prefs.putString("appass", c.apPassword);
  prefs.putString("currcode", c.currencyCode);
  prefs.putString("symbols", c.symbolsCSV);
  prefs.putUInt("fetchsec", c.fetchSec);
  prefs.putUInt("cyclesec", c.cycleSec);
  prefs.putBool("invert", c.invert);
  prefs.putInt("rotation", c.rotation);
  prefs.putFloat("alertpct", c.alertThreshold);
  prefs.putBool("mktmode", c.marketAwareMode);
  prefs.end();
}

void clearWiFiCreds() {
  prefs.begin("stocktracker", false);
  prefs.remove("ssid");
  prefs.remove("pass");
  prefs.end();
}

void resetStockBuffers() {
  for (int i = 0; i < MAX_SYMBOLS; i++) {
    stocks[i] = StockData();
    lastFetch[i] = 0;
  }
  currentIndex = 0;
}

void applyDisplaySettings() {
  display.setRotation(cfgRotation == 2 ? 2 : 0);
  display.invertDisplay(cfgInvert);
}

// ======================= WEB CONFIG PAGE (HTML) =======================

String buildSymbolsCSV() {
  String out;
  for (int i = 0; i < symbolCount; i++) {
    out += symbolList[i];
    if (i < symbolCount - 1) out += ",";
  }
  return out;
}

void handleRoot() {
  String html = "<!DOCTYPE html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'>";
  html += "<title>Stock Tracker Setup</title><style>";
  html += "body{font-family:sans-serif;max-width:420px;margin:20px auto;padding:0 12px;}";
  html += "h2{color:#222;} label{display:block;margin-top:12px;font-weight:bold;}";
  html += "input{width:100%;padding:8px;box-sizing:border-box;margin-top:4px;}";
  html += "button{margin-top:18px;padding:10px 16px;width:100%;background:#2266dd;color:#fff;border:none;border-radius:4px;font-size:16px;}";
  html += ".note{color:#666;font-size:13px;margin-top:4px;}";
  html += "</style></head><body>";
  html += "<h2>Stock Tracker Setup</h2>";
  html += "<p class='note'>Firmware v" + String(FW_VERSION) + "</p>";
  html += apMode ? "<p>Connect this device to your WiFi to get started.</p>" : "<p>Update your settings below.</p>";
  html += "<form action='/save' method='POST'>";
  html += "<label>WiFi SSID</label><input name='ssid' value='" + cfgSSID + "' required>";
  html += "<label>WiFi Password</label><input name='pass' type='password' value=''>";
  html += "<div class='note'>Leave blank to keep the current WiFi password.</div>";
  html += "<label>Finnhub API Key</label><input name='apikey' value='" + cfgApiKey + "'>";
  html += "<label>Stock Symbols (comma-separated)</label><input name='symbols' value='" + buildSymbolsCSV() + "'>";
  html += "<label>Fetch Interval (seconds)</label><input name='fetchsec' type='number' min='15' value='" + String(fetchIntervalMs / 1000) + "'>";
  html += "<label>Cycle Interval (seconds)</label><input name='cyclesec' type='number' min='2' value='" + String(cycleIntervalMs / 1000) + "'>";
  html += "<label>Setup WiFi Password (optional)</label><input name='appass' value='" + cfgApPassword + "'>";
  html += "<div class='note'>Secures the \"StockTracker-Setup\" hotspot used for future reconfiguration. Leave blank for an open network.</div>";
  html += "<button type='submit'>Save & Reboot</button>";
  html += "</form><p class='note'>Also reachable at <b>http://" + String(MDNS_HOSTNAME) + ".local</b>. Full settings (currency, display, alerts) and firmware updates are managed from the desktop app.</p>";
  html += "</body></html>";
  server.send(200, "text/html", html);
}

void handleSave() {
  FullConfig c;
  c.ssid    = server.arg("ssid");
  c.pass    = server.arg("pass").length() ? server.arg("pass") : cfgPASS;
  c.apikey  = server.arg("apikey");
  c.symbolsCSV = server.arg("symbols");
  c.fetchSec = server.arg("fetchsec").toInt();
  c.cycleSec = server.arg("cyclesec").toInt();
  if (c.fetchSec < 15) c.fetchSec = 15;
  if (c.cycleSec < 2) c.cycleSec = 2;
  c.apPassword = server.arg("appass");
  c.currencyCode = cfgCurrencyCode;
  c.invert = cfgInvert;
  c.rotation = cfgRotation;
  c.alertThreshold = cfgAlertThreshold;
  c.marketAwareMode = cfgMarketAwareMode;

  saveFullConfig(c);
  server.send(200, "text/html", "<html><body><h3>Saved. Rebooting...</h3></body></html>");
  delay(800);
  ESP.restart();
}

void handleNotFound() {
  handleRoot();
}

// ======================= JSON API =======================

void setCORS() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
}

void handleApiOptions() {
  setCORS();
  server.send(204);
}

void handleApiStatus() {
  setCORS();
  JsonDocument doc;
  doc["ip"] = WiFi.localIP().toString();
  doc["hostname"] = String(MDNS_HOSTNAME) + ".local";
  doc["connected"] = (WiFi.status() == WL_CONNECTED);
  doc["firmware"] = FW_VERSION;
  doc["currency"] = cfgCurrencyCode;
  doc["marketOpen"] = marketOpen;
  doc["marketSession"] = marketSession;
  doc["marketHoliday"] = marketHoliday;
  JsonArray arr = doc["stocks"].to<JsonArray>();
  for (int i = 0; i < symbolCount; i++) {
    JsonObject o = arr.add<JsonObject>();
    o["symbol"]  = symbolList[i];
    o["price"]   = stocks[i].price * cfgExchangeRate;
    o["change"]  = stocks[i].change * cfgExchangeRate;
    o["percent"] = stocks[i].percent;
    o["valid"]   = stocks[i].valid;
    o["alert"]   = (cfgAlertThreshold > 0 && stocks[i].valid && fabs(stocks[i].percent) >= cfgAlertThreshold);
    JsonArray hist = o["history"].to<JsonArray>();
    for (int j = 0; j < stocks[i].historyCount; j++) {
      hist.add(stocks[i].history[j]);
    }
  }
  String out;
  serializeJson(doc, out);
  server.send(200, "application/json", out);
}

void handleApiConfigGet() {
  setCORS();
  JsonDocument doc;
  doc["symbols"] = buildSymbolsCSV();
  doc["fetchIntervalSec"] = fetchIntervalMs / 1000;
  doc["cycleIntervalSec"] = cycleIntervalMs / 1000;
  doc["hasApiKey"] = (cfgApiKey.length() > 0);
  doc["ssid"] = cfgSSID;
  doc["apPassword"] = cfgApPassword;
  doc["currencyCode"] = cfgCurrencyCode;
  doc["invertDisplay"] = cfgInvert;
  doc["rotation"] = cfgRotation;
  doc["alertThreshold"] = cfgAlertThreshold;
  doc["marketAwareMode"] = cfgMarketAwareMode;
  doc["firmware"] = FW_VERSION;
  String out;
  serializeJson(doc, out);
  server.send(200, "application/json", out);
}

void handleApiConfigPost() {
  setCORS();
  if (!server.hasArg("plain")) {
    server.send(400, "application/json", "{\"error\":\"missing body\"}");
    return;
  }
  JsonDocument doc;
  if (deserializeJson(doc, server.arg("plain"))) {
    server.send(400, "application/json", "{\"error\":\"bad json\"}");
    return;
  }

  FullConfig c;
  c.ssid = cfgSSID;
  c.pass = cfgPASS;
  c.apikey = doc["apikey"] | cfgApiKey;
  c.symbolsCSV = doc["symbols"] | buildSymbolsCSV();
  unsigned int fetchSec = doc["fetchIntervalSec"] | (unsigned int)(fetchIntervalMs / 1000);
  unsigned int cycleSec = doc["cycleIntervalSec"] | (unsigned int)(cycleIntervalMs / 1000);
  c.fetchSec = fetchSec < 15 ? 15 : fetchSec;
  c.cycleSec = cycleSec < 2 ? 2 : cycleSec;
  c.apPassword = doc["apPassword"] | cfgApPassword;
  c.currencyCode = doc["currencyCode"] | cfgCurrencyCode;
  c.invert = doc["invertDisplay"] | cfgInvert;
  c.rotation = doc["rotation"] | cfgRotation;
  c.alertThreshold = doc["alertThreshold"] | cfgAlertThreshold;
  c.marketAwareMode = doc["marketAwareMode"] | cfgMarketAwareMode;

  bool currencyChanged = (c.currencyCode != cfgCurrencyCode);

  saveFullConfig(c);
  loadConfig();
  resetStockBuffers();
  applyDisplaySettings();
  if (currencyChanged) fetchExchangeRate();

  server.send(200, "application/json", "{\"ok\":true}");
}

// ---- OTA firmware upload (POST a compiled .bin to /update) ----
void handleUpdateResult() {
  setCORS();
  server.sendHeader("Connection", "close");
  bool ok = !Update.hasError();
  server.send(200, "application/json", ok ? "{\"ok\":true}" : "{\"ok\":false}");
  if (ok) {
    delay(500);
    ESP.restart();
  }
}

void handleUpdateUpload() {
  HTTPUpload &upload = server.upload();
  if (upload.status == UPLOAD_FILE_START) {
    otaInProgress = true;
    showMessageFwd("Updating firmware", "Do not power off...");
    if (!Update.begin(UPDATE_SIZE_UNKNOWN)) {
      Update.printError(Serial);
    }
  } else if (upload.status == UPLOAD_FILE_WRITE) {
    if (Update.write(upload.buf, upload.currentSize) != upload.currentSize) {
      Update.printError(Serial);
    }
  } else if (upload.status == UPLOAD_FILE_END) {
    if (Update.end(true)) {
      Serial.printf("Update success: %u bytes\n", upload.totalSize);
    } else {
      Update.printError(Serial);
    }
    otaInProgress = false;
  }
}

void startWebServer() {
  server.on("/", handleRoot);
  server.on("/save", HTTP_POST, handleSave);

  server.on("/api/status", HTTP_GET, handleApiStatus);
  server.on("/api/config", HTTP_GET, handleApiConfigGet);
  server.on("/api/config", HTTP_POST, handleApiConfigPost);
  server.on("/api/config", HTTP_OPTIONS, handleApiOptions);
  server.on("/api/status", HTTP_OPTIONS, handleApiOptions);

  server.on("/update", HTTP_POST, handleUpdateResult, handleUpdateUpload);
  server.on("/update", HTTP_OPTIONS, handleApiOptions);

  server.onNotFound(handleNotFound);
  server.begin();
}

// ======================= DISPLAY HELPERS (setup-phase messages) =======================

void showMessage(const String &line1, const String &line2 = "", const String &line3 = "") {
  display.clearDisplay();
  display.setTextColor(SH110X_WHITE);
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.println(line1);
  display.println(line2);
  display.println(line3);
  display.display();
}
// forward-name used inside upload handler above (defined after display setup runs, safe since it's only
// called once WiFi + display are already initialized)
void showMessageFwd(const String &line1, const String &line2) { showMessage(line1, line2); }

// ======================= WIFI SETUP MODE =======================

void startAPMode() {
  apMode = true;
  WiFi.mode(WIFI_AP);
  if (cfgApPassword.length() >= 8) {
    WiFi.softAP(AP_SSID, cfgApPassword.c_str());
  } else {
    WiFi.softAP(AP_SSID);
  }
  IPAddress apIP = WiFi.softAPIP();

  dnsServer.start(53, "*", apIP);
  startWebServer();

  showMessage("Setup mode", "Connect WiFi to:", String(AP_SSID));
  delay(2000);
  showMessage("Then open:", apIP.toString(), "in a browser");

  while (true) {
    dnsServer.processNextRequest();
    server.handleClient();
  }
}

bool connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(cfgSSID.c_str(), cfgPASS.c_str());
  showMessage("Connecting to:", cfgSSID);

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
    delay(300);
  }
  return WiFi.status() == WL_CONNECTED;
}

// ======================= STOCK DATA =======================

void pushHistory(StockData &d, float price) {
  if (d.historyCount < HISTORY_LEN) {
    d.history[d.historyCount++] = price;
  } else {
    for (int i = 1; i < HISTORY_LEN; i++) d.history[i - 1] = d.history[i];
    d.history[HISTORY_LEN - 1] = price;
  }
}

bool fetchQuote(const String &symbol, StockData &out) {
  if (WiFi.status() != WL_CONNECTED || cfgApiKey.length() == 0) return false;

  HTTPClient http;
  String url = "https://finnhub.io/api/v1/quote?symbol=" + symbol + "&token=" + cfgApiKey;
  http.begin(url);
  int code = http.GET();
  if (code != 200) {
    http.end();
    return false;
  }
  String payload = http.getString();
  http.end();

  JsonDocument doc;
  if (deserializeJson(doc, payload)) return false;

  out.price   = doc["c"]  | 0.0;
  out.change  = doc["d"]  | 0.0;
  out.percent = doc["dp"] | 0.0;
  out.valid   = (out.price != 0);
  if (out.valid) pushHistory(out, out.price);
  return out.valid;
}

// Refreshes cfgExchangeRate (USD -> cfgCurrencyCode). USD is always 1:1.
bool fetchExchangeRate() {
  if (cfgCurrencyCode == "USD") {
    cfgExchangeRate = 1.0;
    return true;
  }
  if (WiFi.status() != WL_CONNECTED || cfgApiKey.length() == 0) return false;

  HTTPClient http;
  String url = "https://finnhub.io/api/v1/forex/rates?base=USD&token=" + cfgApiKey;
  http.begin(url);
  int code = http.GET();
  if (code != 200) {
    http.end();
    return false;
  }
  String payload = http.getString();
  http.end();

  JsonDocument doc;
  if (deserializeJson(doc, payload)) return false;
  float rate = doc["quote"][cfgCurrencyCode] | 0.0f;
  if (rate <= 0) return false;
  cfgExchangeRate = rate;
  return true;
}

// Refreshes marketOpen/marketSession/marketHoliday from Finnhub. Only covers
// the US market (NYSE/NASDAQ) — fine for most US tickers, approximate for
// anything else.
bool checkMarketStatus() {
  if (WiFi.status() != WL_CONNECTED || cfgApiKey.length() == 0) return false;

  HTTPClient http;
  String url = "https://finnhub.io/api/v1/stock/market-status?exchange=US&token=" + cfgApiKey;
  http.begin(url);
  int code = http.GET();
  if (code != 200) {
    http.end();
    return false;
  }
  String payload = http.getString();
  http.end();

  JsonDocument doc;
  if (deserializeJson(doc, payload)) return false;
  marketOpen    = doc["isOpen"] | false;
  marketSession = String((const char*)(doc["session"] | ""));
  marketHoliday = String((const char*)(doc["holiday"] | ""));
  return true;
}

// Rough estimate of the next 9:30 AM ET open, ignoring holidays beyond today
// (Finnhub tells us if *today* is a holiday via marketHoliday, but not future
// ones). Good enough for an at-a-glance display, not for trading decisions.
String nextOpenString() {
  time_t now = time(nullptr);
  struct tm t;
  localtime_r(&now, &t);

  bool beforeOpenToday = (t.tm_wday >= 1 && t.tm_wday <= 5) &&
                         (t.tm_hour < 9 || (t.tm_hour == 9 && t.tm_min < 30));

  int daysAhead;
  if (beforeOpenToday) {
    daysAhead = 0;
  } else {
    daysAhead = 1;
    int futureWday = (t.tm_wday + 1) % 7;
    while (futureWday == 0 || futureWday == 6) {
      daysAhead++;
      futureWday = (futureWday + 1) % 7;
    }
  }

  static const char* dayNames[] = {"Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"};
  int targetWday = (t.tm_wday + daysAhead) % 7;
  String dayLabel = (daysAhead == 0) ? "Today" : (daysAhead == 1 ? "Tomorrow" : String(dayNames[targetWday]));
  return dayLabel + " 9:30 AM ET";
}

// ======================= DISPLAY =======================

void drawSparkline(StockData &d, int x, int y, int w, int h) {
  if (d.historyCount < 2) return;
  float minV = d.history[0], maxV = d.history[0];
  for (int i = 1; i < d.historyCount; i++) {
    if (d.history[i] < minV) minV = d.history[i];
    if (d.history[i] > maxV) maxV = d.history[i];
  }
  if (maxV - minV < 0.01) maxV = minV + 0.01;

  int prevX = -1, prevY = -1;
  for (int i = 0; i < d.historyCount; i++) {
    int px = x + (int)((float)i / (HISTORY_LEN - 1) * w);
    int py = y + h - (int)(((d.history[i] - minV) / (maxV - minV)) * h);
    if (prevX >= 0) display.drawLine(prevX, prevY, px, py, SH110X_WHITE);
    prevX = px; prevY = py;
  }
}

// Small 4-bar WiFi signal icon, bottom-right corner. rightX/bottomY are the
// icon's bottom-right anchor point.
void drawWifiIcon(int rightX, int bottomY) {
  int bars = 0;
  if (WiFi.status() == WL_CONNECTED) {
    long rssi = WiFi.RSSI();
    if (rssi >= -55) bars = 4;
    else if (rssi >= -65) bars = 3;
    else if (rssi >= -75) bars = 2;
    else if (rssi >= -85) bars = 1;
    else bars = 0;
  }
  const int barW = 3, gap = 1, maxH = 10;
  for (int i = 0; i < 4; i++) {
    int barH = (i + 1) * (maxH / 4);
    int x = rightX - (4 - i) * (barW + gap);
    int y = bottomY - barH;
    if (i < bars) display.fillRect(x, y, barW, barH, SH110X_WHITE);
    else display.drawRect(x, y, barW, barH, SH110X_WHITE);
  }
}

void drawStock(const String &symbol, StockData &d) {
  display.clearDisplay();
  display.setTextColor(SH110X_WHITE);

  display.setTextSize(2);
  display.setCursor(0, 0);
  display.println(symbol);
  display.drawFastHLine(0, 18, SCREEN_W, SH110X_WHITE);

  // alert icon (small triangle) top-right if this symbol crossed the threshold
  if (cfgAlertThreshold > 0 && d.valid && fabs(d.percent) >= cfgAlertThreshold) {
    display.fillTriangle(SCREEN_W - 14, 4, SCREEN_W - 2, 4, SCREEN_W - 8, 14, SH110X_WHITE);
  }

  // market open/closed dot, top-left: filled = open, hollow = closed
  if (marketOpen) display.fillCircle(4, 4, 3, SH110X_WHITE);
  else display.drawCircle(4, 4, 3, SH110X_WHITE);

  if (!d.valid) {
    display.setTextSize(1);
    display.setCursor(0, 30);
    display.println(cfgApiKey.length() == 0 ? "No API key set" : "No data");
  } else {
    float dispPrice = d.price * cfgExchangeRate;
    float dispChange = d.change * cfgExchangeRate;

    String priceStr = String(dispPrice, 2);
    display.setTextSize(2);
    display.setCursor(0, 26);
    display.print(priceStr);

    int16_t bx, by; uint16_t bw, bh;
    display.getTextBounds(priceStr, 0, 26, &bx, &by, &bw, &bh);
    display.setTextSize(1);
    display.setCursor(bx + bw + 4, 30);
    display.print(cfgCurrencyCode);

    display.setCursor(0, 46);
    if (dispChange >= 0) display.print("+");
    display.print(dispChange, 2);
    display.print("  (");
    if (d.percent >= 0) display.print("+");
    display.print(d.percent, 2);
    display.println("%)");

    display.drawRect(0, 60, SCREEN_W, 44, SH110X_WHITE);
    drawSparkline(d, 2, 62, SCREEN_W - 4, 40);
  }

  display.setCursor(0, SCREEN_H - 8);
  display.print(WiFi.localIP().toString());

  drawWifiIcon(SCREEN_W - 2, SCREEN_H - 2);

  int dotSpacing = 6;
  int totalWidth = (symbolCount - 1) * dotSpacing;
  int startX = SCREEN_W - totalWidth - 4;
  for (int i = 0; i < symbolCount; i++) {
    int cx = startX + i * dotSpacing;
    if (i == currentIndex) display.fillCircle(cx, 4, 2, SH110X_WHITE);
    else display.drawCircle(cx, 4, 2, SH110X_WHITE);
  }

  display.display();
}

// Dedicated slide shown once per cycle rotation (after the last symbol),
// with more room to explain market status than the small dot on stock screens.
void drawMarketStatus() {
  display.clearDisplay();
  display.setTextColor(SH110X_WHITE);

  display.setTextSize(2);
  display.setCursor(0, 0);
  display.println("MARKET");
  display.drawFastHLine(0, 18, SCREEN_W, SH110X_WHITE);

  display.setTextSize(2);
  display.setCursor(0, 28);
  display.println(marketOpen ? "OPEN" : "CLOSED");

  display.setTextSize(1);
  display.setCursor(0, 52);
  if (marketOpen) {
    if (marketSession.length()) {
      display.print("Session: ");
      display.println(marketSession);
    }
  } else {
    if (marketHoliday.length()) {
      display.print("Holiday: ");
      display.println(marketHoliday);
    }
    display.print("Opens: ");
    display.println(nextOpenString());
  }

  display.setCursor(0, SCREEN_H - 8);
  display.print(WiFi.localIP().toString());
  drawWifiIcon(SCREEN_W - 2, SCREEN_H - 2);

  display.display();
}

// ======================= SETUP / LOOP =======================

// ======================= BOOT ANIMATION =======================

// A quick rising-bar-chart animation, then a title card. Pure Adafruit_GFX
// primitives — no image assets or extra flash storage needed. Runs once at
// power-on, before WiFi/config even loads, so it stays snappy (~2 seconds).
void playBootAnimation() {
  const int barCount = 5;
  const int barMaxH[barCount] = {30, 55, 40, 65, 45};
  const int barW = 14, gap = 6;
  const int totalW = barCount * barW + (barCount - 1) * gap;
  const int startX = (SCREEN_W - totalW) / 2;
  const int baseY = 100;

  int barX[barCount];
  for (int i = 0; i < barCount; i++) barX[i] = startX + i * (barW + gap);

  for (int i = 0; i < barCount; i++) {
    for (int h = 0; h <= barMaxH[i]; h += 4) {
      display.clearDisplay();
      for (int j = 0; j < i; j++) {
        display.fillRect(barX[j], baseY - barMaxH[j], barW, barMaxH[j], SH110X_WHITE);
      }
      display.fillRect(barX[i], baseY - h, barW, h, SH110X_WHITE);
      display.display();
      delay(12);
    }
  }
  delay(150);

  display.clearDisplay();
  display.setTextColor(SH110X_WHITE);
  int16_t bx, by; uint16_t bw, bh;

  display.setTextSize(2);
  display.getTextBounds("STOCK", 0, 0, &bx, &by, &bw, &bh);
  display.setCursor((SCREEN_W - bw) / 2, 30);
  display.println("STOCK");

  display.getTextBounds("TRACKER", 0, 0, &bx, &by, &bw, &bh);
  display.setCursor((SCREEN_W - bw) / 2, 52);
  display.println("TRACKER");

  display.setTextSize(1);
  String verLine = "v" + String(FW_VERSION);
  display.getTextBounds(verLine, 0, 0, &bx, &by, &bw, &bh);
  display.setCursor((SCREEN_W - bw) / 2, 80);
  display.println(verLine);

  display.display();
  delay(900);
}

void setup() {
  Serial.begin(115200);
  Wire.begin(OLED_SDA, OLED_SCL);

  if (!display.begin(OLED_ADDR, true)) {
    Serial.println("SH1107 not found - check wiring/address");
    while (true) delay(1000);
  }

  playBootAnimation();

  pinMode(BOOT_BUTTON_PIN, INPUT_PULLUP);
  if (digitalRead(BOOT_BUTTON_PIN) == LOW) {
    showMessage("BOOT held:", "clearing WiFi", "credentials...");
    clearWiFiCreds();
    delay(1000);
  }

  loadConfig();
  applyDisplaySettings();

  if (cfgSSID.length() == 0) {
    startAPMode();
  }

  if (!connectWiFi()) {
    showMessage("WiFi failed.", "Starting setup", "portal...");
    delay(1500);
    startAPMode();
  }

  if (MDNS.begin(MDNS_HOSTNAME)) {
    MDNS.addService("stocktracker", "tcp", 80);
  }

  ArduinoOTA.setHostname(MDNS_HOSTNAME);
  ArduinoOTA.begin();

  configTzTime(TZ_INFO, NTP_SERVER);  // background NTP sync, US Eastern w/ auto DST

  showMessage("Connected!", "IP address:", WiFi.localIP().toString());
  delay(2000);

  startWebServer();

  for (int i = 0; i < symbolCount; i++) {
    fetchQuote(symbolList[i], stocks[i]);
    lastFetch[i] = millis();
    delay(250);
  }

  fetchExchangeRate();
  lastFxCheck = millis();
  checkMarketStatus();
  lastMarketCheck = millis();
  prevMarketOpenState = marketOpen;

  if (cfgMarketAwareMode && !marketOpen) currentIndex = symbolCount;
  else currentIndex = 0;

  lastCycle = millis();
  if (currentIndex == symbolCount) drawMarketStatus();
  else drawStock(symbolList[currentIndex], stocks[currentIndex]);
}

void loop() {
  server.handleClient();
  ArduinoOTA.handle();

  if (otaInProgress) return;  // don't touch WiFi/API calls mid-flash

  unsigned long now = millis();

  if (WiFi.status() != WL_CONNECTED) {
    showMessage("WiFi lost.", "Reconnecting...");
    connectWiFi();
  }

  bool needsRedraw = false;
  for (int i = 0; i < symbolCount; i++) {
    if (now - lastFetch[i] >= fetchIntervalMs) {
      fetchQuote(symbolList[i], stocks[i]);
      lastFetch[i] = now;
      if (i == currentIndex) needsRedraw = true;
    }
  }

  if (now - lastFxCheck >= FX_CHECK_INTERVAL_MS) {
    fetchExchangeRate();
    lastFxCheck = now;
    needsRedraw = true;
  }

  if (now - lastMarketCheck >= MARKET_CHECK_INTERVAL_MS) {
    checkMarketStatus();
    lastMarketCheck = now;
    if (currentIndex == symbolCount) needsRedraw = true;

    // if we were parked on the closed-market slide and the market just
    // opened, jump straight into the stock rotation
    if (marketOpen && !prevMarketOpenState) {
      currentIndex = 0;
      lastCycle = now;
      needsRedraw = true;
    }
    prevMarketOpenState = marketOpen;
  }

  // the market-status slide only exists in the rotation while the market is
  // actually closed — while open, it's just your stocks, no interruptions
  int totalSlides = marketOpen ? symbolCount : symbolCount + 1;
  if (currentIndex >= totalSlides) {
    currentIndex = 0;
    needsRedraw = true;
  }

  if (cfgMarketAwareMode && !marketOpen) {
    // park on the market-status slide instead of cycling through stocks
    if (currentIndex != symbolCount) {
      currentIndex = symbolCount;
      needsRedraw = true;
    }
  } else if (now - lastCycle >= cycleIntervalMs) {
    // normal behavior: cycle through every symbol, plus the market slide
    // when closed
    currentIndex = (currentIndex + 1) % totalSlides;
    lastCycle = now;
    needsRedraw = true;
  }

  if (needsRedraw) {
    if (currentIndex == symbolCount) drawMarketStatus();
    else drawStock(symbolList[currentIndex], stocks[currentIndex]);
  }
}
