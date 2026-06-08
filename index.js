const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason 
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const express = require('express');
const cors = require('cors'); 
const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');
const rateLimit = require('express-rate-limit'); // Tambahan Pengaman DDOS

const app = express();

// --- CONFIG MIDDLEWARE EXPRESS ---
app.set('trust proxy', 1);
app.use(cors()); 
app.use(express.json()); 
app.use(express.urlencoded({ extended: true }));

const PORT = 8000;
const DB_FILE = './database.json';
// KUNCI UTAMA PEMILIK: Ganti string ini dengan password rahasia Anda sendiri!
const MASTER_SECRET_KEY = 'krisna_owner'; 

// Objek Global untuk menampung koneksi Baileys yang aktif di memory RAM
const activeSessions = {}; 

// --- MITIGASI DDOS & SPAM (RATE LIMITER) ---
// 1. Pembatasan Ketat untuk Pembuatan API Key (Maksimal 3 kali per jam per IP)
const apiKeyGenerateLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 Jam
    max: 3, 
    message: { status: false, message: 'Terlalu banyak meminta API Key. Silakan coba lagi dalam 1 jam.' },
    standardHeaders: true, 
    legacyHeaders: false,
});

// 2. Pembatasan Umum untuk Kirim Pesan (Maksimal 60 request per menit per IP)
const generalApiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 Menit
    max: 60, 
    message: { status: false, message: 'Request terlalu cepat! Batasan maksimum adalah 60 ketukan per menit.' },
    standardHeaders: true,
    legacyHeaders: false,
});


// --- CONFIGURATION SWAGGER UI ---
const swaggerOptions = {
    definition: {
        openapi: '3.0.0',
        info: {
            title: '🚀 WA Gateway Multi-Device API',
            version: '1.0.0',
            description: 'Dokumentasi API resmi untuk layanan WhatsApp Gateway Multi-Device (SaaS Ready). Semua endpoint diamankan menggunakan API Key.',
            contact: { name: 'Krisna Support', url: 'https://web.krisnamarket.my.id' }
        },
        servers: [
            { url: 'https://web.krisnamarket.my.id', description: 'Server Produksi (HTTPS)' }
        ],
        components: {
            securitySchemes: {
                ApiKeyAuth: {
                    type: 'apiKey',
                    in: 'header',
                    name: 'x-api-key',
                    description: 'Masukkan API Key User Anda untuk mengakses endpoint ini.'
                },
                MasterKeyAuth: {
                    type: 'apiKey',
                    in: 'header',
                    name: 'x-master-key',
                    description: 'Hanya untuk Pemilik/Admin Server. Masukkan Master Secret Key Anda.'
                }
            }
        }
    },
    apis: ['./index.js']
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));


// --- FUNGSI UTILITAS DATABASE (API KEY) ---
const readDB = () => {
    try {
        if (!fs.existsSync(DB_FILE)) {
            fs.writeFileSync(DB_FILE, '{}', 'utf-8');
            return {};
        }
        const data = fs.readFileSync(DB_FILE, 'utf-8');
        return data ? JSON.parse(data) : {};
    } catch (error) {
        console.error("Gagal membaca database.json:", error.message);
        return {};
    }
};

const writeDB = (data) => {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
};

// --- CORE FUNCTION: INISIALISASI SESI WHATSAPP DINAMIS ---
async function initWhatsAppSession(sessionId) {
    if (activeSessions[sessionId]) return activeSessions[sessionId];

    const sessionFolder = `./sessions/session-${sessionId}`;
    const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
    
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log(`[🔄 SESSION LOG] Sesi ${sessionId} terputus. Menghubungkan ulang: ${shouldReconnect}`);
            if (shouldReconnect) {
                delete activeSessions[sessionId];
                initWhatsAppSession(sessionId);
            } else {
                console.log(`[🗑️ SESSION LOG] Sesi ${sessionId} telah Logout (Expired). Menghapus folder...`);
                try { fs.rmSync(sessionFolder, { recursive: true, force: true }); } catch (e) {}
                delete activeSessions[sessionId];
            }
        } else if (connection === 'open') {
            console.log(`[✅ SESSION ONLINE] Sesi ${sessionId} BERHASIL TERHUBUNG & SIAP DIGUNAKAN!`);
        }
    });

    activeSessions[sessionId] = sock;
    return sock;
}

// --- OTOMATIS MEMULIHKAN LOGIN SAAT SERVER VPS RESTART ---
function loadSavedSessions() {
    if (!fs.existsSync('./sessions')) {
        fs.mkdirSync('./sessions');
        return;
    }
    const dirs = fs.readdirSync('./sessions');
    dirs.forEach(dir => {
        if (dir.startsWith('session-')) {
            const sessionId = dir.replace('session-', '');
            console.log(`[⚙️ SYSTEM BOOT] Memulihkan koneksi untuk nomor: ${sessionId}`);
            initWhatsAppSession(sessionId);
        }
    });
}

// --- MIDDLEWARE VALIDASI API KEY USER ---
const validateApiKey = (req, res, next) => {
    const apiKey = req.headers['x-api-key'] || req.query.apikey || req.body.apikey;
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    console.log(`\n[🌐 API HIT] Path: ${req.path} | IP: ${clientIp} | API Key Used: ${apiKey || 'N/A'}`);

    if (!apiKey) {
        return res.status(401).json({ status: false, message: 'Akses ditolak. API Key dibutuhkan.' });
    }

    const db = readDB();
    if (!db[apiKey] || db[apiKey].status !== 'active') {
        return res.status(403).json({ status: false, message: 'API Key tidak cocok atau tidak valid.' });
    }

    next();
};

// --- MIDDLEWARE VALIDASI MASTER KEY (KHUSUS ADMIN) ---
const validateMasterKey = (req, res, next) => {
    const masterKey = req.headers['x-master-key'] || req.query.masterkey || req.body.masterkey;
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    if (!masterKey || masterKey !== MASTER_SECRET_KEY) {
        console.log(`[🚨 SECURITY ALERT] IP ${clientIp} mencoba membobol generate API Key tanpa Master Key valid!`);
        return res.status(401).json({ status: false, message: 'Akses ditolak. Membutuhkan X-Master-Key yang valid.' });
    }
    next();
};


// ==========================================
//          ENDPOINT MANAJEMEN API KEY
// ==========================================

/**
 * @swagger
 * /api-key/generate:
 *   post:
 *     summary: Membuat API Key baru otomatis (Khusus Admin/Owner)
 *     description: Endpoint ini dilindungi oleh Master Key dan Rate Limiter untuk mencegah pengeboman database berkas.
 *     tags: [Manajemen API Key]
 *     security:
 *       - MasterKeyAuth: []
 *     responses:
 *       201:
 *         description: API Key berhasil dibuat.
 *       401:
 *         description: Master Key salah atau tidak dilampirkan.
 *       422:
 *         description: Terkena blokir Rate Limit karena spamming.
 */
app.post('/api-key/generate', apiKeyGenerateLimiter, validateMasterKey, (req, res) => {
    try {
        const barisAcak = Math.random().toString(36).substring(2, 15).toUpperCase() + Math.random().toString(36).substring(2, 15).toUpperCase();
        const newApiKey = `KEY-${barisAcak}`;
        
        const db = readDB();
        db[newApiKey] = {
            status: 'active',
            createdAt: new Date()
        };
        writeDB(db);
        
        console.log(`[🔑 NEW API KEY GENERATED] Berhasil membuat dan menyimpan API Key: ${newApiKey}`);
        
        return res.status(201).json({
            status: true,
            message: 'API Key berhasil dibuat otomatis dan tersimpan di sistem.',
            api_key: newApiKey,
            key_status: 'active'
        });
    } catch (error) {
        return res.status(500).json({ status: false, message: 'Gagal membuat API Key.', error: error.message });
    }
});

/**
 * @swagger
 * /api-key/check:
 *   get:
 *     summary: Mengecek status validitas API Key
 *     tags: [Manajemen API Key]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: API Key valid.
 */
app.get('/api-key/check', generalApiLimiter, validateApiKey, (req, res) => {
    const apiKey = req.headers['x-api-key'] || req.query.apikey || req.body.apikey;
    const db = readDB();
    return res.status(200).json({ status: true, api_key: apiKey, details: db[apiKey] });
});


// ==========================================
//           ENDPOINT DEVICE / SAAS
// ==========================================

/**
 * @swagger
 * /device/add:
 *   post:
 *     summary: Menbah perangkat baru & meminta Pairing Code
 *     tags: [Manajemen Device]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - nomor_device
 *             properties:
 *               nomor_device:
 *                 type: string
 *                 example: "628123456789"
 */
app.post('/device/add', generalApiLimiter, validateApiKey, async (req, res) => {
    const { nomor_device } = req.body;
    if (!nomor_device) return res.status(400).json({ status: false, message: 'Parameter "nomor_device" wajib diisi.' });

    const cleanDevice = nomor_device.replace(/[^0-9]/g, '');
    try {
        const sock = await initWhatsAppSession(cleanDevice);
        if (sock.authState.creds.registered) {
            return res.status(200).json({ status: true, message: 'Perangkat ini sudah terhubung.', device_status: 'CONNECTED' });
        }

        setTimeout(async () => {
            try {
                let pairingCode = await sock.requestPairingCode(cleanDevice);
                return res.status(200).json({
                    status: true,
                    message: 'Pairing code berhasil dibuat.',
                    pairing_code: pairingCode,
                    device_status: 'WAITING_PAIRING'
                });
            } catch (err) {
                return res.status(500).json({ status: false, message: 'Gagal generate pairing code.', error: err.message });
            }
        }, 3500);
    } catch (error) {
        return res.status(500).json({ status: false, error: error.message });
    }
});

/**
 * @swagger
 * /device/list:
 *   get:
 *     summary: Melihat seluruh nomor device yang online
 *     tags: [Manajemen Device]
 *     security:
 *       - ApiKeyAuth: []
 */
app.get('/device/list', generalApiLimiter, validateApiKey, (req, res) => {
    const listOnline = Object.keys(activeSessions);
    return res.status(200).json({ status: true, total_online_device: listOnline.length, online_devices: listOnline });
});

/**
 * @swagger
 * /device/delete:
 *   post:
 *     summary: Menghapus perangkat & logout total
 *     tags: [Manajemen Device]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - nomor_device
 *             properties:
 *               nomor_device:
 *                 type: string
 *                 example: "628123456789"
 */
app.post('/device/delete', generalApiLimiter, validateApiKey, async (req, res) => {
    const { nomor_device } = req.body;
    if (!nomor_device) return res.status(400).json({ status: false, message: 'Parameter "nomor_device" wajib diisi.' });

    const cleanDevice = nomor_device.replace(/[^0-9]/g, '');
    const sessionFolder = `./sessions/session-${cleanDevice}`;
    const clientSock = activeSessions[cleanDevice];

    try {
        if (clientSock) {
            try { await clientSock.logout(); } catch (e) { clientSock.end(); }
            delete activeSessions[cleanDevice];
        }
        if (fs.existsSync(sessionFolder)) fs.rmSync(sessionFolder, { recursive: true, force: true });
        return res.status(200).json({ status: true, message: `Sesi perangkat ${cleanDevice} berhasil dibersihkan.` });
    } catch (error) {
        return res.status(500).json({ status: false, error: error.message });
    }
});


// ==========================================
//          ENDPOINT UTAMA KIRIM PESAN
// ==========================================

/**
 * @swagger
 * /kirim-pesan:
 *   post:
 *     summary: Mengirimkan pesan teks biasa
 *     tags: [Core API Pengiriman]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [sender_id, nomor, pesan]
 *             properties:
 *               sender_id:
 *                 type: string
 *                 example: "628123456789"
 *               nomor:
 *                 type: string
 *                 example: "6287784550689"
 *               pesan:
 *                 type: string
 *                 example: "Pesan aman terlindungi Rate-Limit"
 */
app.post('/kirim-pesan', generalApiLimiter, validateApiKey, async (req, res) => {
    const { sender_id, nomor, pesan } = req.body;
    if (!sender_id || !nomor || !pesan) return res.status(400).json({ status: false, message: 'Parameter tidak lengkap.' });

    const cleanSender = sender_id.replace(/[^0-9]/g, '');
    const clientSock = activeSessions[cleanSender];
    if (!clientSock) return res.status(404).json({ status: false, message: `Sesi pengirim (${cleanSender}) tidak aktif.` });

    try {
        const cleanNomor = nomor.replace(/[^0-9]/g, '');
        await clientSock.sendMessage(`${cleanNomor}@s.whatsapp.net`, { text: pesan });
        return res.status(200).json({ status: true, message: 'Pesan teks berhasil dikirim.' });
    } catch (error) {
        return res.status(500).json({ status: false, error: error.message });
    }
});

/**
 * @swagger
 * /kirim-media:
 *   post:
 *     summary: Mengirim pesan media (Gambar, PDF, Audio, Video)
 *     tags: [Core API Pengiriman]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [sender_id, nomor, url, tipe]
 *             properties:
 *               sender_id:
 *                 type: string
 *                 example: "628123456789"
 *               nomor:
 *                 type: string
 *                 example: "6287784550689"
 *               url:
 *                 type: string
 *                 example: "https://raw.githubusercontent.com/AnangK/file-sample/main/sample-image.jpg"
 *               tipe:
 *                 type: string
 *                 enum: [image, video, audio, document]
 *                 example: "image"
 *               caption:
 *                 type: string
 *                 example: "Keterangan Media"
 */
app.post('/kirim-media', generalApiLimiter, validateApiKey, async (req, res) => {
    const { sender_id, nomor, url, tipe, caption } = req.body;
    if (!sender_id || !nomor || !url || !tipe) return res.status(400).json({ status: false, message: 'Parameter tidak lengkap.' });

    const cleanSender = sender_id.replace(/[^0-9]/g, '');
    const clientSock = activeSessions[cleanSender];
    if (!clientSock) return res.status(404).json({ status: false, message: `Sesi pengirim (${cleanSender}) tidak aktif.` });

    try {
        const cleanNomor = nomor.replace(/[^0-9]/g, '');
        const jid = `${cleanNomor}@s.whatsapp.net`;
        let messageOptions = {};

        if (tipe === 'image') messageOptions = { image: { url }, caption };
        else if (tipe === 'video') messageOptions = { video: { url }, caption };
        else if (tipe === 'audio') messageOptions = { audio: { url }, mimetype: 'audio/mp4' };
        else if (tipe === 'document') messageOptions = { document: { url }, mimetype: 'application/pdf', fileName: 'document.pdf', caption };
        else return res.status(400).json({ status: false, message: 'Tipe media tidak valid.' });

        await clientSock.sendMessage(jid, messageOptions);
        return res.status(200).json({ status: true, message: `Media ${tipe} berhasil dikirim.` });
    } catch (error) {
        return res.status(500).json({ status: false, error: error.message });
    }
});

// --- EXECUTE ON STARTUP ---
app.listen(PORT, () => {
    console.log(`===================================================`);
    console.log(`🚀 WA Gateway SECURE FULL-SAAS berjalan di port: ${PORT}`);
    console.log(`📖 Dokumentasi Swagger: https://web.krisnamarket.my.id/docs`);
    console.log(`===================================================`);
    loadSavedSessions();
});
      
