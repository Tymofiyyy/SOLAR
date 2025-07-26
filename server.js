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
// Зберігаємо коди підтвердження пристроїв
const deviceConfirmationCodes = new Map();

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
      
      // Зберігаємо код підтвердження якщо є
      if (status.confirmationCode) {
        deviceConfirmationCodes.set(deviceId, status.confirmationCode);
        console.log(`Received confirmation code for ${deviceId}: ${status.confirmationCode}`);
      }
      
      deviceStatuses.set(deviceId, {
        ...status,
        lastSeen: new Date(),
        online: true
      });
      
      // Зберігаємо в базу даних тільки якщо пристрій зареєстрований
      const deviceExists = await pool.query(
        'SELECT id FROM devices WHERE device_id = $1',
        [deviceId]
      );
      
      if (deviceExists.rows.length > 0) {
        await saveDeviceStatus(deviceId, status);
      }
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

// Отримати всі пристрої користувача (тільки його!)
app.get('/api/devices/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    // Знаходимо користувача по telegram_id
    const userResult = await pool.query(
      'SELECT id FROM users WHERE telegram_id = $1',
      [userId]
    );
    
    if (userResult.rows.length === 0) {
      return res.json([]);
    }
    
    // Отримуємо тільки пристрої цього користувача через таблицю зв'язків
    const result = await pool.query(
      `SELECT DISTINCT d.*, ud.is_owner, ud.added_at
       FROM devices d
       JOIN user_devices ud ON d.id = ud.device_id
       WHERE ud.user_id = $1
       ORDER BY ud.added_at DESC`,
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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const { userId, deviceId, confirmationCode, name } = req.body;
    
    // Перевіряємо код підтвердження
    const storedCode = deviceConfirmationCodes.get(deviceId);
    if (!storedCode || storedCode !== confirmationCode) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Невірний код підтвердження або пристрій не знайдено' });
    }
    
    // Знаходимо user_id по telegram_id
    const userResult = await client.query(
      'SELECT id FROM users WHERE telegram_id = $1',
      [userId]
    );
    
    if (userResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found' });
    }
    
    const userDbId = userResult.rows[0].id;
    
    // Перевіряємо чи пристрій вже існує
    let deviceResult = await client.query(
      'SELECT id FROM devices WHERE device_id = $1',
      [deviceId]
    );
    
    let deviceDbId;
    let isNewDevice = false;
    
    if (deviceResult.rows.length === 0) {
      // Створюємо новий пристрій
      deviceResult = await client.query(
        'INSERT INTO devices (device_id, name) VALUES ($1, $2) RETURNING id',
        [deviceId, name || `Solar Controller ${deviceId.slice(-4)}`]
      );
      deviceDbId = deviceResult.rows[0].id;
      isNewDevice = true;
    } else {
      deviceDbId = deviceResult.rows[0].id;
    }
    
    // Перевіряємо чи користувач вже має доступ до цього пристрою
    const accessCheck = await client.query(
      'SELECT * FROM user_devices WHERE user_id = $1 AND device_id = $2',
      [userDbId, deviceDbId]
    );
    
    if (accessCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Ви вже маєте доступ до цього пристрою' });
    }
    
    // Додаємо зв'язок користувач-пристрій
    await client.query(
      'INSERT INTO user_devices (user_id, device_id, is_owner) VALUES ($1, $2, $3)',
      [userDbId, deviceDbId, isNewDevice] // Якщо новий пристрій - користувач стає власником
    );
    
    await client.query('COMMIT');
    
    // Повертаємо повну інформацію про пристрій
    const fullDevice = await client.query(
      `SELECT d.*, ud.is_owner, ud.added_at
       FROM devices d
       JOIN user_devices ud ON d.id = ud.device_id
       WHERE d.id = $1 AND ud.user_id = $2`,
      [deviceDbId, userDbId]
    );
    
    res.json(fullDevice.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error adding device:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// Видалити пристрій (тільки видаляє зв'язок з користувачем)
app.delete('/api/devices/:deviceId', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const { deviceId } = req.params;
    const { userId } = req.body; // Потрібно передавати userId
    
    if (!userId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'userId is required' });
    }
    
    // Знаходимо user_id та device_id
    const userResult = await client.query(
      'SELECT id FROM users WHERE telegram_id = $1',
      [userId]
    );
    
    const deviceResult = await client.query(
      'SELECT id FROM devices WHERE device_id = $1',
      [deviceId]
    );
    
    if (userResult.rows.length === 0 || deviceResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User or device not found' });
    }
    
    const userDbId = userResult.rows[0].id;
    const deviceDbId = deviceResult.rows[0].id;
    
    // Видаляємо зв'язок
    await client.query(
      'DELETE FROM user_devices WHERE user_id = $1 AND device_id = $2',
      [userDbId, deviceDbId]
    );
    
    // Перевіряємо чи залишилися інші користувачі
    const remainingUsers = await client.query(
      'SELECT COUNT(*) FROM user_devices WHERE device_id = $1',
      [deviceDbId]
    );
    
    // Якщо це був останній користувач - видаляємо пристрій
    if (parseInt(remainingUsers.rows[0].count) === 0) {
      await client.query(
        'DELETE FROM devices WHERE id = $1',
        [deviceDbId]
      );
    }
    
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error deleting device:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
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

// Поділитися пристроєм з іншим користувачем
app.post('/api/devices/:deviceId/share', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const { deviceId } = req.params;
    const { ownerId, targetTelegramId } = req.body;
    
    // Перевіряємо чи власник має права
    const ownerResult = await client.query(
      `SELECT ud.is_owner 
       FROM user_devices ud
       JOIN users u ON u.id = ud.user_id
       JOIN devices d ON d.id = ud.device_id
       WHERE u.telegram_id = $1 AND d.device_id = $2`,
      [ownerId, deviceId]
    );
    
    if (ownerResult.rows.length === 0 || !ownerResult.rows[0].is_owner) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Тільки власник може ділитися пристроєм' });
    }
    
    // Знаходимо або створюємо цільового користувача
    let targetUser = await client.query(
      'SELECT id FROM users WHERE telegram_id = $1',
      [targetTelegramId]
    );
    
    if (targetUser.rows.length === 0) {
      targetUser = await client.query(
        'INSERT INTO users (telegram_id) VALUES ($1) RETURNING id',
        [targetTelegramId]
      );
    }
    
    const targetUserId = targetUser.rows[0].id;
    
    // Знаходимо device_id
    const deviceResult = await client.query(
      'SELECT id FROM devices WHERE device_id = $1',
      [deviceId]
    );
    
    if (deviceResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Device not found' });
    }
    
    const deviceDbId = deviceResult.rows[0].id;
    
    // Перевіряємо чи вже має доступ
    const existingAccess = await client.query(
      'SELECT * FROM user_devices WHERE user_id = $1 AND device_id = $2',
      [targetUserId, deviceDbId]
    );
    
    if (existingAccess.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Користувач вже має доступ до цього пристрою' });
    }
    
    // Додаємо доступ
    await client.query(
      'INSERT INTO user_devices (user_id, device_id, is_owner) VALUES ($1, $2, false)',
      [targetUserId, deviceDbId]
    );
    
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error sharing device:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
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
    console.log('Initializing database...');
    
    // Видаляємо старі таблиці для чистого старту
    console.log('Dropping old tables...');
    await pool.query('DROP TABLE IF EXISTS device_history CASCADE');
    await pool.query('DROP TABLE IF EXISTS user_devices CASCADE');
    await pool.query('DROP TABLE IF EXISTS devices CASCADE');
    await pool.query('DROP TABLE IF EXISTS users CASCADE');
    
    // Таблиця користувачів
    console.log('Creating users table...');
    await pool.query(`
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT UNIQUE NOT NULL,
        username VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Таблиця пристроїв
    console.log('Creating devices table...');
    await pool.query(`
      CREATE TABLE devices (
        id SERIAL PRIMARY KEY,
        device_id VARCHAR(255) UNIQUE NOT NULL,
        name VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Таблиця зв'язків користувач-пристрій (багато-до-багатьох)
    console.log('Creating user_devices table...');
    await pool.query(`
      CREATE TABLE user_devices (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        device_id INTEGER REFERENCES devices(id) ON DELETE CASCADE,
        is_owner BOOLEAN DEFAULT false,
        added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, device_id)
      )
    `);
    
    // Таблиця історії даних
    console.log('Creating device_history table...');
    await pool.query(`
      CREATE TABLE device_history (
        id SERIAL PRIMARY KEY,
        device_id VARCHAR(255),
        relay_state BOOLEAN,
        wifi_rssi INTEGER,
        uptime INTEGER,
        free_heap INTEGER,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Індекси для оптимізації
    console.log('Creating indexes...');
    await pool.query(`
      CREATE INDEX idx_device_history_device_id_timestamp 
      ON device_history(device_id, timestamp DESC)
    `);
    
    await pool.query(`
      CREATE INDEX idx_user_devices_user_id 
      ON user_devices(user_id)
    `);
    
    await pool.query(`
      CREATE INDEX idx_user_devices_device_id 
      ON user_devices(device_id)
    `);
    
    console.log('Database initialized successfully!');
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

// Періодично перевіряємо онлайн статус пристроїв
setInterval(() => {
  const now = new Date();
  deviceStatuses.forEach((status, deviceId) => {
    // Якщо не отримували дані більше 30 секунд - вважаємо офлайн
    if (now - status.lastSeen > 30000) {
      status.online = false;
    }
  });
}, 5000);

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
