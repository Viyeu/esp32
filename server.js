/**
 * server.js - ESP32 Smart Home Gateway (51 Relay - ĐÃ SỬA LỖI ĐIỀU KHIỂN RELAY 7+)
 * Tác giả: Sang iT | 17/11/2025 17:30
 */

const net = require('net');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { maxHttpBufferSize: 1e6 });

app.use(express.static('public'));
app.use(express.json({ limit: '1mb' }));

// === DATABASE ===
const db = new sqlite3.Database('./database.db', (err) => {
    if (err) return console.error('DB lỗi:', err) || process.exit(1);
    console.log('DB kết nối thành công');
});

db.serialize(() => {
    let createTable = 'CREATE TABLE IF NOT EXISTS relay_log (id INTEGER PRIMARY KEY AUTOINCREMENT, device TEXT NOT NULL, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP';
    for (let i = 1; i <= 51; i++) createTable += `, relay${i} INTEGER DEFAULT 0`;
    createTable += ')';
    db.run(createTable);
    db.run(`CREATE INDEX IF NOT EXISTS idx_device_time ON relay_log(device, timestamp DESC)`);
});

// === CONFIG ===
const configFile = path.join(__dirname, 'config.json');
let relayConfig = {};

function loadConfig() {
    if (fs.existsSync(configFile)) {
        try {
            relayConfig = JSON.parse(fs.readFileSync(configFile, 'utf8'));
            console.log('Đã tải config.json');
        } catch (e) {
            console.error('Lỗi đọc config:', e);
            relayConfig = {};
        }
    }
}
function saveConfig() {
    try {
        fs.writeFileSync(configFile, JSON.stringify(relayConfig, null, 2));
        console.log('Đã lưu config.json');
        io.emit('configUpdate', relayConfig);
    } catch (e) {
        console.error('Lỗi ghi config:', e);
    }
}
loadConfig();

// === TCP SERVER ===
const tcpServer = net.createServer();
const devices = {};
const MAX_DEVICES = 50;
const MAX_RELAYS = 51;
const DEFAULT_RELAYS = 8;

tcpServer.on('connection', (socket) => {
    if (Object.keys(devices).length >= MAX_DEVICES) return socket.end();

    let deviceId = null;
    const timeout = setTimeout(() => socket.destroy(), 60000);

    const handleData = (data) => {
        clearTimeout(timeout);
        const msg = data.toString().trim();
        if (!msg) return;

        let json;
        try { json = JSON.parse(msg); } catch { return; }

        if (json.type === 'register' && json.device) {
            deviceId = json.device;
            devices[deviceId] = socket;

            if (!relayConfig[deviceId]) {
                relayConfig[deviceId] = {};
                for (let i = 1; i <= DEFAULT_RELAYS; i++) {
                    const key = `relay${i}`;
                    if (!relayConfig[deviceId][key]) {
                        relayConfig[deviceId][key] = { name: `Thiết bị ${i}`, gpio: i - 1, type: 'relay' };
                    }
                }
                saveConfig();
            }
            sendConfig(deviceId, socket);
            return;
        }

        if (json.device) {
            deviceId = json.device;
            devices[deviceId] = socket;

            // Lưu log động
            const keys = Object.keys(json).filter(k => /^relay\d+$/.test(k) && parseInt(k.slice(5)) <= 51);
            if (keys.length > 0) {
                const placeholders = keys.map(() => '?').join(',');
                const sql = `INSERT INTO relay_log (device, ${keys.join(',')}) VALUES (?, ${placeholders})`;
                const stmt = db.prepare(sql);
                const values = [json.device, ...keys.map(k => json[k] ?? 0)];
                stmt.run(values, () => stmt.finalize());
            }

            io.emit('relayStatus', json);
        }
    };

    socket.on('data', handleData);
    socket.on('end', () => {
        clearTimeout(timeout);
        if (deviceId && devices[deviceId] === socket) delete devices[deviceId];
    });
    socket.on('error', () => {});
});

function sendConfig(deviceId, socket) {
    if (relayConfig[deviceId] && socket.writable) {
        const msg = JSON.stringify({ type: 'config', config: relayConfig[deviceId] }) + '\n';
        socket.write(msg);
    }
}

tcpServer.listen(5000, '0.0.0.0', () => console.log('TCP Server: 5000'));

// === API CONFIG ===
app.get('/api/config', (req, res) => res.json(relayConfig));

app.post('/api/config', (req, res) => {
    const { device, relay, name, gpio, type, action } = req.body;
    if (!device || !relay) return res.status(400).json({ error: 'Thiếu device/relay' });

    if (!relayConfig[device]) relayConfig[device] = {};

    if (action === 'delete') {
        delete relayConfig[device][relay];
        saveConfig();
        const target = devices[device];
        if (target && target.writable) sendConfig(device, target);
        return res.json(relayConfig);
    }

    if (!name || name.length > 20 || gpio < 0 || gpio > 50 || !['light','fan','pump','tv','ac','door','curtain','speaker','camera','relay'].includes(type)) {
        return res.status(400).json({ error: 'Dữ liệu không hợp lệ' });
    }

    const newGpio = parseInt(gpio);
    for (const r in relayConfig[device]) {
        if (r !== relay && relayConfig[device][r].gpio === newGpio) {
            return res.status(400).json({ error: `GPIO ${newGpio} đã dùng bởi "${relayConfig[device][r].name}"` });
        }
    }

    relayConfig[device][relay] = { name, gpio: newGpio, type };
    saveConfig();

    const target = devices[device];
    if (target && target.writable) sendConfig(device, target);

    res.json(relayConfig);
});

// === DASHBOARD & SOCKET.IO ===
server.listen(3000, '0.0.0.0', () => console.log('Dashboard: http://YOUR_IP:3000'));

io.on('connection', (socket) => {
    db.all(`SELECT * FROM relay_log ORDER BY timestamp DESC LIMIT 50`, [], (err, rows) => {
        if (!err) socket.emit('relayHistory', rows.reverse());
    });
    socket.emit('configUpdate', relayConfig);

    // DÒNG DUY NHẤT ĐÃ SỬA – BÂY GIỜ NHẬN ĐƯỢC relay7 → relay51
    socket.on('command', (data) => {
        const { device, cmd } = data;
        const target = devices[device];
        // Regex mới: nhận relay1 đến relay51 + _on hoặc _off
        if (target && target.writable && /^relay([1-9]|[1-4][0-9]|5[0-1])_(on|off)$/.test(cmd)) {
            target.write(cmd + '\n');
            console.log(`Đã gửi lệnh: ${cmd} tới ${device}`);
        }
    });
});