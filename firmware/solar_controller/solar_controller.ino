#include <WiFi.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <PubSubClient.h>
#include <EEPROM.h>
#include <ArduinoJson.h>

// Конфігурація
#define RELAY_PIN 32
#define LED_PIN 2
#define EEPROM_SIZE 512
#define AP_SSID "SolarController_"
#define CONFIRMATION_CODE_LENGTH 6
#define DNS_PORT 53

// MQTT налаштування (змініть на свої)
const char* mqtt_server = "192.168.68.111"; // IP вашого ПК з Backend
const int mqtt_port = 1883;
const char* mqtt_user = "";
const char* mqtt_password = "";

// Глобальні змінні
WebServer server(80);
DNSServer dnsServer;
WiFiClient espClient;
PubSubClient client(espClient);

String deviceId;
String confirmationCode;
String savedSSID = "";
String savedPassword = "";
bool wifiConnected = false;
bool mqttConnected = false;
bool relayState = false;

// Структура для збереження даних в EEPROM
struct Config {
  char ssid[32];
  char password[64];
  char deviceId[32];
};

void setup() {
  Serial.begin(115200);
  EEPROM.begin(EEPROM_SIZE);
  
  pinMode(RELAY_PIN, OUTPUT);
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, LOW);
  digitalWrite(LED_PIN, LOW);
  
  // Генеруємо унікальний ID пристрою
  deviceId = "ESP32_" + String(ESP.getEfuseMac(), HEX);
  
  // Генеруємо код підтвердження
  generateConfirmationCode();
  
  // Завантажуємо збережені налаштування
  loadConfig();
  
  // Спробуємо підключитися до збереженої мережі
  if (savedSSID.length() > 0) {
    connectToWiFi();
  }
  
  // Завжди запускаємо точку доступу
  setupAP();
  
  // Запускаємо DNS сервер для Captive Portal
  dnsServer.start(DNS_PORT, "*", WiFi.softAPIP());
  
  // Налаштовуємо веб-сервер
  setupWebServer();
  
  // Налаштовуємо MQTT
  client.setServer(mqtt_server, mqtt_port);
  client.setCallback(mqttCallback);
}

void loop() {
  // Обробляємо DNS запити для Captive Portal
  dnsServer.processNextRequest();
  
  // Обробляємо веб-сервер
  server.handleClient();
  
  if (wifiConnected && !client.connected()) {
    reconnectMQTT();
  }
  
  if (client.connected()) {
    client.loop();
    
    // Відправляємо статус кожні 10 секунд
    static unsigned long lastStatusUpdate = 0;
    if (millis() - lastStatusUpdate > 10000) {
      sendStatus();
      lastStatusUpdate = millis();
    }
  }
  
  // Блимаємо LED для індикації статусу
  static unsigned long lastBlink = 0;
  if (millis() - lastBlink > 1000) {
    digitalWrite(LED_PIN, !digitalRead(LED_PIN));
    lastBlink = millis();
  }
}

void generateConfirmationCode() {
  confirmationCode = "";
  for (int i = 0; i < CONFIRMATION_CODE_LENGTH; i++) {
    confirmationCode += String(random(0, 10));
  }
  Serial.println("Confirmation code: " + confirmationCode);
}

void setupAP() {
  String apName = AP_SSID + deviceId.substring(deviceId.length() - 4);
  WiFi.softAP(apName.c_str());
  
  IPAddress IP = WiFi.softAPIP();
  Serial.print("AP IP address: ");
  Serial.println(IP);
}

void connectToWiFi() {
  Serial.println("Connecting to WiFi: " + savedSSID);
  WiFi.begin(savedSSID.c_str(), savedPassword.c_str());
  
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 20) {
    delay(500);
    Serial.print(".");
    attempts++;
  }
  
  if (WiFi.status() == WL_CONNECTED) {
    wifiConnected = true;
    Serial.println("\nWiFi connected!");
    Serial.println("IP address: " + WiFi.localIP().toString());
  } else {
    Serial.println("\nFailed to connect to WiFi");
    wifiConnected = false;
  }
}

void setupWebServer() {
  // Головна сторінка - відповідаємо на всі запити
  server.onNotFound([]() {
    String html = "<!DOCTYPE html><html><head>";
    html += "<meta charset='UTF-8'>";
    html += "<meta name='viewport' content='width=device-width, initial-scale=1.0'>";
    html += "<title>Solar Controller Setup</title>";
    html += "<style>";
    html += "body { font-family: Arial, sans-serif; margin: 20px; background: #f0f0f0; }";
    html += ".container { max-width: 400px; margin: 0 auto; background: white; padding: 20px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }";
    html += "h1 { color: #333; text-align: center; }";
    html += ".code { font-size: 36px; font-weight: bold; text-align: center; color: #2196F3; padding: 20px; background: #f5f5f5; border-radius: 5px; margin: 20px 0; letter-spacing: 5px; }";
    html += "input, select { width: 100%; padding: 10px; margin: 10px 0; border: 1px solid #ddd; border-radius: 5px; box-sizing: border-box; }";
    html += "button { width: 100%; padding: 10px; background: #2196F3; color: white; border: none; border-radius: 5px; cursor: pointer; font-size: 16px; }";
    html += "button:hover { background: #1976D2; }";
    html += ".status { padding: 10px; margin: 10px 0; border-radius: 5px; text-align: center; }";
    html += ".connected { background: #4CAF50; color: white; }";
    html += ".disconnected { background: #f44336; color: white; }";
    html += ".info { background: #FFC107; color: #333; padding: 10px; border-radius: 5px; margin: 10px 0; text-align: center; }";
    html += "</style></head><body>";
    html += "<div class='container'>";
    html += "<h1>☀️ Solar Controller</h1>";
    html += "<div class='info'>⚡ Запишіть цей код!</div>";
    html += "<div class='code'>" + confirmationCode + "</div>";
    html += "<div class='status " + String(wifiConnected ? "connected" : "disconnected") + "'>";
    html += wifiConnected ? "✅ WiFi підключено" : "❌ WiFi не підключено";
    html += "</div>";
    html += "<form action='/connect' method='POST'>";
    html += "<select name='ssid' id='ssid' required>";
    html += "<option value=''>Виберіть WiFi мережу...</option>";
    
    // Сканування WiFi мереж
    int n = WiFi.scanNetworks();
    for (int i = 0; i < n; i++) {
      String security = (WiFi.encryptionType(i) == WIFI_AUTH_OPEN) ? " 🔓" : " 🔒";
      html += "<option value='" + WiFi.SSID(i) + "'>" + WiFi.SSID(i) + security + " (" + String(WiFi.RSSI(i)) + " dBm)</option>";
    }
    
    html += "</select>";
    html += "<input type='password' name='password' placeholder='Пароль WiFi' required>";
    html += "<button type='submit'>Підключити</button>";
    html += "</form>";
    html += "<p style='text-align: center; color: #666; margin-top: 20px; font-size: 12px;'>Device ID: " + deviceId + "</p>";
    html += "</div></body></html>";
    
    server.send(200, "text/html", html);
  });
  
  // Обробка підключення до WiFi
  server.on("/connect", HTTP_POST, []() {
    String ssid = server.arg("ssid");
    String password = server.arg("password");
    
    if (ssid.length() > 0) {
      savedSSID = ssid;
      savedPassword = password;
      saveConfig();
      
      String html = "<!DOCTYPE html><html><head>";
      html += "<meta charset='UTF-8'>";
      html += "<meta name='viewport' content='width=device-width, initial-scale=1.0'>";
      html += "<title>Підключення...</title>";
      html += "<style>";
      html += "body { font-family: Arial, sans-serif; margin: 20px; background: #f0f0f0; text-align: center; }";
      html += ".container { max-width: 400px; margin: 50px auto; background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }";
      html += ".spinner { border: 4px solid #f3f3f3; border-top: 4px solid #2196F3; border-radius: 50%; width: 50px; height: 50px; animation: spin 1s linear infinite; margin: 20px auto; }";
      html += "@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }";
      html += "</style></head><body>";
      html += "<div class='container'>";
      html += "<h1>Підключення до WiFi...</h1>";
      html += "<div class='spinner'></div>";
      html += "<p>Будь ласка, зачекайте</p>";
      html += "<p style='color: #666; font-size: 14px;'>Сторінка оновиться автоматично</p>";
      html += "</div>";
      html += "<script>setTimeout(function(){window.location.href='/';}, 5000);</script>";
      html += "</body></html>";
      
      server.send(200, "text/html", html);
      
      delay(1000);
      connectToWiFi();
    } else {
      server.send(400, "text/plain", "Помилка: не вибрано мережу");
    }
  });
  
  // API endpoints
  server.on("/api/status", HTTP_GET, []() {
    StaticJsonDocument<200> doc;
    doc["deviceId"] = deviceId;
    doc["wifiConnected"] = wifiConnected;
    doc["mqttConnected"] = mqttConnected;
    doc["relayState"] = relayState;
    doc["confirmationCode"] = confirmationCode;
    
    String response;
    serializeJson(doc, response);
    server.send(200, "application/json", response);
  });
  
  // Captive Portal endpoints для різних систем
  server.on("/generate_204", HTTP_GET, []() {
    server.sendHeader("Location", "http://192.168.4.1/");
    server.send(302, "text/plain", "");
  });
  
  server.on("/fwlink", HTTP_GET, []() {
    server.sendHeader("Location", "http://192.168.4.1/");
    server.send(302, "text/plain", "");
  });
  
  server.on("/hotspot-detect.html", HTTP_GET, []() {
    server.sendHeader("Location", "http://192.168.4.1/");
    server.send(302, "text/plain", "");
  });
  
  server.on("/canonical.html", HTTP_GET, []() {
    server.sendHeader("Location", "http://192.168.4.1/");
    server.send(302, "text/plain", "");
  });
  
  server.on("/success.txt", HTTP_GET, []() {
    server.send(200, "text/plain", "success");
  });
  
  server.on("/ncsi.txt", HTTP_GET, []() {
    server.send(200, "text/plain", "Microsoft NCSI");
  });
  
  server.begin();
  Serial.println("Web server started");
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  String message = "";
  for (int i = 0; i < length; i++) {
    message += (char)payload[i];
  }
  
  Serial.println("MQTT message received: " + String(topic) + " - " + message);
  
  // Обробка команд
  String deviceTopic = "solar/" + deviceId + "/command";
  if (String(topic) == deviceTopic) {
    StaticJsonDocument<200> doc;
    DeserializationError error = deserializeJson(doc, message);
    
    if (!error) {
      String command = doc["command"];
      
      if (command == "relay") {
        bool state = doc["state"];
        digitalWrite(RELAY_PIN, state ? HIGH : LOW);
        relayState = state;
        sendStatus();
      } else if (command == "getStatus") {
        sendStatus();
      } else if (command == "restart") {
        ESP.restart();
      }
    }
  }
}

void reconnectMQTT() {
  if (!wifiConnected) return;
  
  static unsigned long lastAttempt = 0;
  if (millis() - lastAttempt < 5000) return;
  lastAttempt = millis();
  
  Serial.print("Attempting MQTT connection...");
  
  if (client.connect(deviceId.c_str(), mqtt_user, mqtt_password)) {
    Serial.println("connected");
    mqttConnected = true;
    
    // Підписуємося на топіки
    String commandTopic = "solar/" + deviceId + "/command";
    client.subscribe(commandTopic.c_str());
    
    // Відправляємо повідомлення про підключення
    String onlineTopic = "solar/" + deviceId + "/online";
    client.publish(onlineTopic.c_str(), "true", true);
    
    // Відправляємо початковий статус
    sendStatus();
  } else {
    Serial.print("failed, rc=");
    Serial.print(client.state());
    Serial.println(" try again in 5 seconds");
    mqttConnected = false;
  }
}

void sendStatus() {
  if (!client.connected()) return;
  
  StaticJsonDocument<200> doc;
  doc["deviceId"] = deviceId;
  doc["relayState"] = relayState;
  doc["wifiRSSI"] = WiFi.RSSI();
  doc["uptime"] = millis() / 1000;
  doc["freeHeap"] = ESP.getFreeHeap();
  
  String statusTopic = "solar/" + deviceId + "/status";
  String message;
  serializeJson(doc, message);
  
  client.publish(statusTopic.c_str(), message.c_str());
}

void saveConfig() {
  Config config;
  strcpy(config.ssid, savedSSID.c_str());
  strcpy(config.password, savedPassword.c_str());
  strcpy(config.deviceId, deviceId.c_str());
  
  EEPROM.put(0, config);
  EEPROM.commit();
}

void loadConfig() {
  Config config;
  EEPROM.get(0, config);
  
  if (strlen(config.ssid) > 0 && strlen(config.ssid) < 32) {
    savedSSID = String(config.ssid);
    savedPassword = String(config.password);
    Serial.println("Loaded config - SSID: " + savedSSID);
  }
}