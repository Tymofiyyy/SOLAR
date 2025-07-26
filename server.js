// server.js
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const mqtt = require('mqtt');
const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// PostgreSQL підключення
const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'solar_controller',
  password: process.env.DB_PASSWORD || 'password',
  port: process.env.DB_PORT || 5432,
});

// MQTT підключення
const mqttClient = mqtt.connect({
  host: process.env.MQTT_HOST || 'localhost',
  port: process.env.MQTT_PORT || 1883,
  username: process.env.MQTT_USER || 'solar_user',
  password: process.env.MQTT_PASSWORD || 'solar_pass',
});

// Telegram Bot (опціонально для повідомлень)
const bot = process.env.TELEGRAM_BOT_TOKEN ? 
  new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false }) : null;

// Зберігаємо статуси пристроїв в пам'яті для швидкого доступу
const deviceStatuses = new Map();

// MQTT обробники
mqttClient.on('connect', () => {
  console.log('Connected to MQTT broker');
  mqttClient.subscribe('solar/+/status');
  mqttClient.subscribe('solar/+/online');
});

mqttClient.on('message', async (topic, message) => {
  const topicParts = topic.split('/');
  const deviceId = topicParts[1];
  const messageType = topicParts[2];
  
  try {
    if (messageType === 'status') {
      const status = JSON.parse(message.toString());
      deviceStatuses.set(deviceId, {
        ...status,
        lastSeen: new Date(),
        online: true
      });
      
      // Зберігаємо в базу даних
      await saveDeviceStatus(deviceId, status);
    } else if (messageType === 'online') {
      const isOnline = message.toString() === 'true';
      const currentStatus = deviceStatuses.get(deviceId) || {};
      deviceStatuses.set(deviceId, {
        ...currentStatus,
        online: isOnline,
        lastSeen: new Date()
      });
    }
  } catch (error) {
    console.error(`Error processing MQTT (${topic}):`, error);
  }
});

// API Routes

// Створити користувача якщо не існує
app.post('/api/users', async (req, res) => {
  try {
    const { telegramId, username } = req.body;
    
    // Спробуємо знайти існуючого користувача
    let result = await pool.query(
      'SELECT * FROM users WHERE telegram_id = $1',
      [telegramId]
    );
    
    if (result.rows.length === 0) {
      // Створюємо нового користувача
      result = await pool.query(
        'INSERT INTO users (telegram_id, username) VALUES ($1, $2) RETURNING *',
        [telegramId, username]
      );
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error creating user:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Отримати всі пристрої користувача
app.get('/api/devices/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    // Спочатку знаходимо користувача по telegram_id
    const userResult = await pool.query(
      'SELECT id FROM users WHERE telegram_id = $1',
      [userId]
    );
    
    if (userResult.rows.length === 0) {
      return res.json([]);
    }
    
    const result = await pool.query(
      'SELECT * FROM devices WHERE user_id = $1 ORDER BY created_at DESC',
      [userResult.rows[0].id]
    );
    
    // Додаємо статус з пам'яті
    const devices = result.rows.map(device => ({
      ...device,
      status: deviceStatuses.get(device.device_id) || { online: false }
    }));
    
    res.json(devices);
  } catch (error) {
    console.error('Error fetching devices:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Додати новий пристрій
app.post('/api/devices', async (req, res) => {
  try {
    const { userId, deviceId, confirmationCode, name } = req.body;
    
    // Перевіряємо чи пристрій вже додано
    const existingDevice = await pool.query(
      'SELECT * FROM devices WHERE device_id = $1',
      [deviceId]
    );
    
    if (existingDevice.rows.length > 0) {
      return res.status(400).json({ error: 'Device already exists' });
    }
    
    // TODO: В реальному застосуванні тут має бути перевірка коду через MQTT або HTTP
    // Поки що приймаємо будь-який код
    
    // Знаходимо user_id по telegram_id
    const userResult = await pool.query(
      'SELECT id FROM users WHERE telegram_id = $1',
      [userId]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const result = await pool.query(
      'INSERT INTO devices (user_id, device_id, name) VALUES ($1, $2, $3) RETURNING *',
      [userResult.rows[0].id, deviceId, name || `Solar Controller ${deviceId.slice(-4)}`]
    );
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error adding device:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Видалити пристрій
app.delete('/api/devices/:deviceId', async (req, res) => {
  try {
    const { deviceId } = req.params;
    
    await pool.query(
      'DELETE FROM devices WHERE device_id = $1',
      [deviceId]
    );
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting device:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Керування реле
app.post('/api/devices/:deviceId/control', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { command, state } = req.body;
    
    const topic = `solar/${deviceId}/command`;
    const payload = JSON.stringify({ command, state });
    
    mqttClient.publish(topic, payload);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error controlling device:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Отримати історію даних пристрою
app.get('/api/devices/:deviceId/history', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { period = '24h' } = req.query;
    
    let interval;
    switch (period) {
      case '1h': interval = '1 hour'; break;
      case '24h': interval = '24 hours'; break;
      case '7d': interval = '7 days'; break;
      case '30d': interval = '30 days'; break;
      default: interval = '24 hours';
    }
    
    const result = await pool.query(
      `SELECT * FROM device_history 
       WHERE device_id = $1 AND timestamp > NOW() - INTERVAL '${interval}'
       ORDER BY timestamp DESC
       LIMIT 100`,
      [deviceId]
    );
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching history:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Telegram Mini App валідація
app.post('/api/telegram/validate', async (req, res) => {
  try {
    const { initData } = req.body;
    // TODO: Додати справжню валідацію Telegram init data
    // https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
    res.json({ valid: true });
  } catch (error) {
    console.error('Error validating Telegram data:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Healthcheck endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    mqtt: mqttClient.connected,
    timestamp: new Date()
  });
});

// Допоміжні функції
async function saveDeviceStatus(deviceId, status) {
  try {
    // Спочатку перевіряємо чи існує пристрій в таблиці devices
    const deviceExists = await pool.query(
      'SELECT device_id FROM devices WHERE device_id = $1',
      [deviceId]
    );
    
    // Якщо пристрою немає в базі, пропускаємо збереження історії
    if (deviceExists.rows.length === 0) {
      console.log(`Device ${deviceId} not found in database, skipping history save`);
      return;
    }
    
    // Зберігаємо тільки якщо пристрій зареєстрований
    await pool.query(
      `INSERT INTO device_history (device_id, relay_state, wifi_rssi, uptime, free_heap)
       VALUES ($1, $2, $3, $4, $5)`,
      [deviceId, status.relayState, status.wifiRSSI, status.uptime, status.freeHeap]
    );
  } catch (error) {
    console.error('Error saving device status:', error);
  }
}

// Ініціалізація бази даних
async function initDatabase() {
  try {
    // Видаляємо старі таблиці для чистого старту
    await pool.query('DROP TABLE IF EXISTS device_history CASCADE');
    await pool.query('DROP TABLE IF EXISTS devices CASCADE');
    await pool.query('DROP TABLE IF EXISTS users CASCADE');
    
    // Таблиця користувачів
    await pool.query(`
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT UNIQUE NOT NULL,
        username VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Таблиця пристроїв
    await pool.query(`
      CREATE TABLE devices (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        device_id VARCHAR(255) UNIQUE NOT NULL,
        name VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Таблиця історії даних
    await pool.query(`
      CREATE TABLE device_history (
        id SERIAL PRIMARY KEY,
        device_id VARCHAR(255),
        relay_state BOOLEAN,
        wifi_rssi INTEGER,
        uptime INTEGER,
        free_heap INTEGER,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
      )
    `);
    
    // Індекси для оптимізації
    await pool.query(`
      CREATE INDEX idx_device_history_device_id_timestamp 
      ON device_history(device_id, timestamp DESC)
    `);
    
    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Error initializing database:', error);
    process.exit(1);
  }
}

// Запуск сервера
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await initDatabase();
});

// Очищення старих даних кожні 24 години
setInterval(async () => {
  try {
    await pool.query(
      'DELETE FROM device_history WHERE timestamp < NOW() - INTERVAL \'30 days\''
    );
    console.log('Old data cleaned');
  } catch (error) {
    console.error('Error cleaning old data:', error);
  }
}, 24 * 60 * 60 * 1000);

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  app.close(() => {
    console.log('HTTP server closed');
    mqttClient.end();
    pool.end();
  });
});
