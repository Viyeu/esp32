#include <WiFi.h>
#include <ArduinoJson.h>

const char* ssid       = "sangit";
const char* password   = "88888888";
const char* serverIP   = "160.250.180.121";
const int   serverPort = 5000;
const char* deviceId   = "sangit";

WiFiClient client;

// ================= CONFIG DYNAMIC ====================
#define MAX_RELAYS 51

int relayCount = 0;  
int relayPins[MAX_RELAYS];
String relayNames[MAX_RELAYS];
String relayTypes[MAX_RELAYS];

// =====================================================
unsigned long lastSend = 0;
const long interval = 15000;

// =====================================================
void sendStatus() {
  if (!client.connected()) return;

  StaticJsonDocument<2048> doc;
  doc["device"] = deviceId;

  for (int i = 0; i < relayCount; i++) {
    doc["relay" + String(i + 1)] = digitalRead(relayPins[i]);
  }

  String out;
  serializeJson(doc, out);
  client.println(out);
}

// =====================================================
void handleCommand(String cmd) {
  cmd.trim();
  if (cmd.length() == 0) return;

  // tất cả bật
  if (cmd == "all_on") {
    for (int i = 0; i < relayCount; i++) digitalWrite(relayPins[i], HIGH);
    sendStatus();
    return;
  }

  // tất cả tắt
  if (cmd == "all_off") {
    for (int i = 0; i < relayCount; i++) digitalWrite(relayPins[i], LOW);
    sendStatus();
    return;
  }

  // dạng relay12_on
  if (cmd.startsWith("relay") && cmd.indexOf('_') > 0) {
    int index = cmd.substring(5, cmd.indexOf('_')).toInt() - 1;

    if (index >= 0 && index < relayCount) {
      if (cmd.endsWith("_on"))  digitalWrite(relayPins[index], HIGH);
      if (cmd.endsWith("_off")) digitalWrite(relayPins[index], LOW);

      sendStatus();
    }
  }
}

// =====================================================
void handleConfig(const String& json) {
  DynamicJsonDocument doc(4096);

  if (deserializeJson(doc, json)) return;
  if (!doc.containsKey("config")) return;

  JsonObject cfg = doc["config"];

  relayCount = 0;

  for (JsonPair kv : cfg) {
    const char* key = kv.key().c_str();

    if (String(key).startsWith("relay")) {
      int index = atoi(key + 5) - 1;
      if (index < 0 || index >= MAX_RELAYS) continue;

      relayPins[index]  = kv.value()["gpio"];
      relayNames[index] = kv.value()["name"].as<String>();
      relayTypes[index] = kv.value()["type"].as<String>();

      pinMode(relayPins[index], OUTPUT);
      digitalWrite(relayPins[index], LOW);

      relayCount++;
    }
  }

  Serial.println("Đã nhận config mới. Số relay: " + String(relayCount));
  sendStatus();
}

// =====================================================
void reconnectServer() {
  while (!client.connected()) {
    Serial.println("Kết nối lại server...");
    if (client.connect(serverIP, serverPort)) {
      StaticJsonDocument<256> doc;
      doc["type"] = "register";
      doc["device"] = deviceId;

      String out;
      serializeJson(doc, out);
      client.println(out);

      Serial.println("Đã đăng ký thiết bị.");
      return;
    }
    delay(2000);
  }
}

// =====================================================
void setup() {
  Serial.begin(115200);
  delay(500);

  WiFi.begin(ssid, password);
  Serial.print("WiFi...");
  while (WiFi.status() != WL_CONNECTED) {
    delay(300);
    Serial.print(".");
  }
  Serial.println("\nWiFi OK");

  reconnectServer();
}

// =====================================================
void loop() {
  if (!client.connected()) {
    client.stop();
    reconnectServer();
  }

  // nhận dữ liệu
  if (client.available()) {
    String msg = client.readStringUntil('\n');
    msg.trim();
    if (msg.length() == 0) return;

    if (msg.startsWith("{")) {
      handleConfig(msg);
    } else {
      handleCommand(msg);
    }
  }

  // gửi trạng thái định kỳ
  if (millis() - lastSend > interval) {
    sendStatus();
    lastSend = millis();
  }
}
