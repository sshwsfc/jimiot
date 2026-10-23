/*
 * 极米投影仪 BLE 唤醒网关 · xgimi-wake.ino
 * ------------------------------------------------------------------
 * 投影仪待机时 Wi-Fi 会关闭，UDP 遥控发不进去；本固件用 ESP32
 * 伪造原装遥控器的 BLE 广播，把待机中的投影仪唤醒。
 *
 * 广播内容（31 字节，与原装遥控器一致）：
 *   02 01 06                  Flags
 *   03 03 12 18               HID Service UUID 0x1812
 *   03 19 C1 03               Appearance 0x03C1
 *   13 FF 46 00 <16B token>   Manufacturer: company 0x0046 + token
 * Scan Response：
 *   11 09 "Bluetooth 4.0 RC"
 *
 * HTTP：
 *   GET  /status   设备状态
 *   POST /wake     发一次唤醒广播（约 4 秒）
 *   POST /token    更新 token，body 直接放 32 位十六进制
 *
 * 依赖：arduino-esp32 2.x / 3.x（BLE 只用 ESP-IDF 原生接口，零第三方库）
 * ------------------------------------------------------------------
 */

#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <ESPmDNS.h>
#include <Preferences.h>

#include "config.h"

extern "C" {
#include "esp_bt.h"
#include "esp_bt_main.h"
#include "esp_gap_ble_api.h"
}

/* ------------------------------------------------------------------ */
/* 全局状态                                                            */
/* ------------------------------------------------------------------ */

static WebServer http(80);
static Preferences prefs;

static uint8_t tokenBytes[16];
static uint8_t advRaw[31];
static uint8_t rspRaw[18];

static volatile bool advDataReady = false;
static volatile bool advertising = false;

enum WakeState { IDLE, WAIT_DATA, BURST_ON, BURST_OFF };
static WakeState wakeState = IDLE;
static unsigned long stateAt = 0;
static int burstsLeft = 0;
static bool pendingWake = false;

static bool mdnsStarted = false;
static unsigned long lastWifiTry = 0;

static esp_ble_adv_params_t advParams;

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

static int hexNibble(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

static String tokenHex() {
  static const char* digits = "0123456789abcdef";
  String out;
  out.reserve(32);
  for (size_t i = 0; i < sizeof(tokenBytes); i++) {
    out += digits[tokenBytes[i] >> 4];
    out += digits[tokenBytes[i] & 0x0F];
  }
  return out;
}

static String maskToken() {
  String t = tokenHex();
  return t.substring(0, 6) + "…" + t.substring(26);
}

static bool parseToken(const String& input) {
  String s = input;
  s.trim();
  s.replace(":", "");
  s.replace(" ", "");
  s.replace("-", "");
  if (s.length() != 32) return false;

  uint8_t tmp[16];
  for (size_t i = 0; i < 16; i++) {
    int hi = hexNibble(s[i * 2]);
    int lo = hexNibble(s[i * 2 + 1]);
    if (hi < 0 || lo < 0) return false;
    tmp[i] = (uint8_t)((hi << 4) | lo);
  }
  memcpy(tokenBytes, tmp, sizeof(tmp));
  return true;
}

static String loadStoredToken() {
  prefs.begin("xgimi", true);
  String t = prefs.getString("token", "");
  prefs.end();
  return t;
}

static void storeToken(const String& hex) {
  prefs.begin("xgimi", false);
  prefs.putString("token", hex);
  prefs.end();
}

/* ------------------------------------------------------------------ */
/* 广播数据                                                            */
/* ------------------------------------------------------------------ */

static void buildAdvData() {
  size_t i = 0;
  advRaw[i++] = 0x02; advRaw[i++] = 0x01; advRaw[i++] = 0x06;
  advRaw[i++] = 0x03; advRaw[i++] = 0x03; advRaw[i++] = 0x12; advRaw[i++] = 0x18;
  advRaw[i++] = 0x03; advRaw[i++] = 0x19; advRaw[i++] = 0xC1; advRaw[i++] = 0x03;
  advRaw[i++] = 0x13; advRaw[i++] = 0xFF; advRaw[i++] = 0x46; advRaw[i++] = 0x00;
  for (size_t k = 0; k < sizeof(tokenBytes); k++) advRaw[i++] = tokenBytes[k];
  // 此时 i == 31，正好是 legacy 广播的上限

  static const char* kName = "Bluetooth 4.0 RC";  // 16 字节
  rspRaw[0] = 0x11;  // length = 1(type) + 16(name)
  rspRaw[1] = 0x09;  // Complete Local Name
  memcpy(rspRaw + 2, kName, 16);

  advDataReady = false;
}

static void startAdv() {
  esp_err_t err = esp_ble_gap_start_advertising(&advParams);
  if (err != ESP_OK) {
    Serial.printf("[ble] start advertising failed: %s\n", esp_err_to_name(err));
  }
}

static void stopAdv() {
  esp_err_t err = esp_ble_gap_stop_advertising();
  if (err != ESP_OK) {
    Serial.printf("[ble] stop advertising failed: %s\n", esp_err_to_name(err));
  }
}

static void gapCallback(esp_gap_ble_cb_event_t event, esp_ble_gap_cb_param_t* param) {
  switch (event) {
    case ESP_GAP_BLE_ADV_DATA_RAW_SET_COMPLETE_EVT:
      esp_ble_gap_config_scan_rsp_data_raw(rspRaw, sizeof(rspRaw));
      break;
    case ESP_GAP_BLE_SCAN_RSP_DATA_RAW_SET_COMPLETE_EVT:
      advDataReady = true;
      break;
    case ESP_GAP_BLE_ADV_START_COMPLETE_EVT:
      advertising = (param->adv_start_cmpl.status == ESP_BT_STATUS_SUCCESS);
      break;
    case ESP_GAP_BLE_ADV_STOP_COMPLETE_EVT:
      advertising = false;
      break;
    default:
      break;
  }
}

static void configureRawAdv() {
  esp_err_t err = esp_ble_gap_config_adv_data_raw(advRaw, sizeof(advRaw));
  if (err != ESP_OK) {
    Serial.printf("[ble] config adv failed: %s\n", esp_err_to_name(err));
  }
}

/* ------------------------------------------------------------------ */
/* 唤醒状态机（非阻塞，HTTP 能随时响应）                                */
/* ------------------------------------------------------------------ */

static bool beginWake() {
  if (wakeState != IDLE) {
    pendingWake = true;
    return false;
  }
  burstsLeft = BURST_COUNT;
  stateAt = millis();

  if (!advDataReady) {
    configureRawAdv();
    wakeState = WAIT_DATA;
  } else {
    startAdv();
    wakeState = BURST_ON;
  }
  Serial.printf("[wake] start, token=%s\n", maskToken().c_str());
  return true;
}

static void tickWake() {
  unsigned long now = millis();
  switch (wakeState) {
    case WAIT_DATA:
      if (advDataReady) {
        startAdv();
        wakeState = BURST_ON;
        stateAt = now;
      } else if (now - stateAt > 2000) {
        Serial.println("[wake] adv data timeout");
        wakeState = IDLE;
      }
      break;

    case BURST_ON:
      if (now - stateAt >= BURST_ON_MS) {
        stopAdv();
        wakeState = BURST_OFF;
        stateAt = now;
      }
      break;

    case BURST_OFF:
      if (now - stateAt >= BURST_OFF_MS) {
        burstsLeft--;
        stateAt = now;
        if (burstsLeft > 0) {
          startAdv();
          wakeState = BURST_ON;
        } else {
          wakeState = IDLE;
          Serial.println("[wake] done");
          if (pendingWake) {
            pendingWake = false;
            beginWake();
          }
        }
      }
      break;

    default:
      break;
  }
}

/* ------------------------------------------------------------------ */
/* Wi-Fi / mDNS                                                        */
/* ------------------------------------------------------------------ */

static void ensureWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  unsigned long now = millis();
  if (now - lastWifiTry < 5000) return;
  lastWifiTry = now;
  Serial.println("[wifi] connecting…");
  WiFi.begin(WIFI_SSID, WIFI_PASS);
}

static void ensureMdns() {
  if (mdnsStarted || WiFi.status() != WL_CONNECTED) return;
  if (!MDNS.begin(DEVICE_NAME)) {
    Serial.println("[mdns] begin failed");
    return;
  }
  MDNS.addService("http", "tcp", 80);
  mdnsStarted = true;
  Serial.printf("[wifi] http://%s.local  (%s)\n", DEVICE_NAME, WiFi.localIP().toString().c_str());
}

/* ------------------------------------------------------------------ */
/* HTTP 接口                                                           */
/* ------------------------------------------------------------------ */

static void sendJson(int code, const String& body) {
  http.send(code, "application/json; charset=utf-8", body);
}

static void handleStatus() {
  const char* stateName = "idle";
  if (wakeState == WAIT_DATA) stateName = "configuring";
  else if (wakeState == BURST_ON || wakeState == BURST_OFF) stateName = "waking";

  String json = "{";
  json += "\"ok\":true";
  json += ",\"device\":\"" + String(DEVICE_NAME) + "\"";
  json += ",\"ip\":\"" + WiFi.localIP().toString() + "\"";
  json += ",\"rssi\":" + String(WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0);
  json += ",\"token\":\"" + maskToken() + "\"";
  json += ",\"tokenSet\":" + String(advDataReady || true ? "true" : "false");
  json += ",\"state\":\"" + String(stateName) + "\"";
  json += ",\"uptime\":" + String(millis() / 1000);
  json += "}";
  sendJson(200, json);
}

static void handleWake() {
  bool started = beginWake();
  sendJson(202, String("{\"ok\":true,\"started\":") + (started ? "true" : "false") +
                    ",\"bursts\":" + String(BURST_COUNT) + "}");
}

static void handleToken() {
  String body = http.arg("plain");
  if (body.startsWith("token=")) body = body.substring(6);
  String hex = body;
  hex.trim();

  if (!parseToken(hex)) {
    sendJson(400, "{\"ok\":false,\"error\":\"token 必须是 32 位十六进制\"}");
    return;
  }
  if (advertising) stopAdv();
  storeToken(tokenHex());
  buildAdvData();
  configureRawAdv();
  sendJson(200, "{\"ok\":true,\"token\":\"" + tokenHex() + "\"}");
}

static void handleRoot() {
  http.send(200, "text/plain; charset=utf-8",
            "XGIMI BLE wake gateway\n"
            "GET  /status   device status\n"
            "POST /wake     advertise once (~4s)\n"
            "POST /token    body: 32 hex chars\n");
}

/* ------------------------------------------------------------------ */
/* setup / loop                                                        */
/* ------------------------------------------------------------------ */

static void setupBle() {
#if defined(CONFIG_IDF_TARGET_ESP32)
  esp_bt_controller_mem_release(ESP_BT_MODE_CLASSIC_BT);
#endif

  esp_bt_controller_config_t cfg = BT_CONTROLLER_INIT_CONFIG_DEFAULT();
  esp_bt_controller_init(&cfg);
  esp_bt_controller_enable(ESP_BT_MODE_BLE);
  esp_bluedroid_init();
  esp_bluedroid_enable();
  esp_ble_gap_register_callback(gapCallback);
  esp_ble_tx_power_set(ESP_BLE_PWR_TYPE_ADV, ESP_PWR_LVL_P9);
  esp_ble_gap_set_device_name("Bluetooth 4.0 RC");

  memset(&advParams, 0, sizeof(advParams));
  advParams.adv_int_min = 0x20;   // 20ms
  advParams.adv_int_max = 0x40;   // 40ms
  advParams.adv_type = ADV_TYPE_IND;
  advParams.own_addr_type = BLE_ADDR_TYPE_PUBLIC;
  advParams.channel_map = ADV_CHNL_ALL;
  advParams.adv_filter_policy = ADV_FILTER_ALLOW_SCAN_ANY_CON_ANY;
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println();
  Serial.println("XGIMI BLE wake gateway");

  String stored = loadStoredToken();
  bool ok = parseToken(stored);
  if (!ok) ok = parseToken(XGIMI_TOKEN);
  if (!ok) {
    Serial.println("[config] token 无效，请在 config.h 里填 32 位十六进制");
  }
  buildAdvData();

  WiFi.mode(WIFI_STA);
  WiFi.setHostname(DEVICE_NAME);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  setupBle();

  http.on("/", HTTP_GET, handleRoot);
  http.on("/status", HTTP_GET, handleStatus);
  http.on("/wake", HTTP_ANY, handleWake);
  http.on("/token", HTTP_POST, handleToken);
  http.onNotFound([]() { sendJson(404, "{\"ok\":false,\"error\":\"not found\"}"); });
  http.begin();

  Serial.printf("[config] token=%s\n", maskToken().c_str());
}

void loop() {
  ensureWifi();
  ensureMdns();
  http.handleClient();
  tickWake();

#ifdef LED_BUILTIN
  static unsigned long lastBlink = 0;
  if (wakeState == BURST_ON && millis() - lastBlink > 100) {
    lastBlink = millis();
    digitalWrite(LED_BUILTIN, !digitalRead(LED_BUILTIN));
  }
#endif

  delay(2);
}
