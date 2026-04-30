require('dotenv').config();
const cluster = require('cluster');
const os = require('os');

const NUM_CPUS = os.cpus().length;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// ─── CLUSTER MASTER ────────────────────────────────────────────────────────────
// In production on Render (single CPU), clustering is skipped automatically.
// On multi-core machines, each CPU gets its own worker process for max throughput.
if (IS_PRODUCTION && cluster.isMaster && NUM_CPUS > 1) {
    console.log(`🧠 Master process ${process.pid} started — forking ${NUM_CPUS} workers`);
    for (let i = 0; i < NUM_CPUS; i++) cluster.fork();
    cluster.on('exit', (worker) => {
        console.warn(`⚠️  Worker ${worker.process.pid} died. Restarting...`);
        cluster.fork(); // Auto-restart crashed workers
    });
    return; // Master exits here; only workers run Express
}

// ─── WORKER / SINGLE PROCESS LOGIC ────────────────────────────────────────────
const express        = require('express');
const { createClient } = require('redis');
const cors           = require('cors');
const helmet         = require('helmet');
const morgan         = require('morgan');
const compression    = require('compression');
const rateLimit      = require('express-rate-limit');

const app     = express();
const PORT    = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'dev-test-api-key';

// ─── DEFAULT TTLs & LIMITS ────────────────────────────────────────────────────
const DEFAULT_TTL      = 3600;          // 1 hour default TTL for all keys
const MAX_TTL          = 60 * 60 * 24 * 7; // 7 days max allowed TTL
const MAX_VALUE_BYTES  = 1 * 1024 * 1024;  // 1 MB max value size
const RATE_LIMIT_WINDOW_MS  = 60_000;  // 1 minute window
const RATE_LIMIT_MAX        = 300;     // 300 requests per minute per IP

// ─── MIDDLEWARE ────────────────────────────────────────────────────────────────

// Gzip compress all responses for faster transmission
app.use(compression());

// Security headers
app.use(helmet());

// Allow cross-origin requests from any domain
app.use(cors());

// Parse JSON bodies, reject payloads > 1MB
app.use(express.json({ limit: '1mb' }));

// Structured access logs
app.use(morgan(IS_PRODUCTION ? 'combined' : 'dev'));

// Global rate limiter — 300 req/min per IP
app.use(rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    max: RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Slow down.' }
}));

// Aggressive rate limit specifically for write operations
const writeLimiter = rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    max: 100, // 100 writes/min per IP
    message: { error: 'Write rate limit exceeded.' }
});

// ─── REDIS CLIENT ──────────────────────────────────────────────────────────────
let redisReady = false;

const redisClient = createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    socket: {
        reconnectStrategy: (retries) => {
            if (retries > 20) return new Error('Too many Redis reconnect retries');
            return Math.min(retries * 100, 3000); // Exponential backoff, capped at 3s
        },
        connectTimeout: 5000,
        keepAlive: 5000,
    }
});

redisClient.on('connect',       () => { redisReady = true;  console.log('✅ Redis connected'); });
redisClient.on('ready',         () => { redisReady = true;  console.log('⚡ Redis ready'); });
redisClient.on('end',           () => { redisReady = false; console.log('🔌 Redis disconnected'); });
redisClient.on('reconnecting',  () => { redisReady = false; console.log('⏳ Redis reconnecting...'); });
redisClient.on('error',         (err) => {
    redisReady = false;
    // Only log unique errors to avoid log flooding
    if (!err.message.includes('ENOTFOUND') || Math.random() < 0.05) {
        console.error('Redis error:', err.message);
    }
});

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────────────────
const authenticate = (req, res, next) => {
    const auth = req.headers['authorization'] || req.headers['x-api-key'];
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : auth;
    if (!token || token !== API_KEY) {
        return res.status(401).json({ error: 'Unauthorized: Invalid or missing API key' });
    }
    next();
};

// Redis availability check middleware
const requireRedis = (req, res, next) => {
    if (!redisReady) {
        return res.status(503).json({ error: 'Cache service temporarily unavailable. Retrying connection...' });
    }
    next();
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const sanitizeTTL = (ttl) => {
    const n = parseInt(ttl, 10);
    if (isNaN(n) || n <= 0) return DEFAULT_TTL;
    return Math.min(n, MAX_TTL);
};

// ─── PUBLIC ROUTES ────────────────────────────────────────────────────────────

// Health check — used by Render's port scanner and monitoring
app.get('/health', async (req, res) => {
    let redisPing = 'disconnected';
    try {
        if (redisReady) {
            await redisClient.ping();
            redisPing = 'ok';
        }
    } catch { /* ignore */ }

    const status = redisPing === 'ok' ? 200 : 503;
    res.status(status).json({
        status:    status === 200 ? 'ok' : 'degraded',
        redis:     redisPing,
        pid:       process.pid,
        uptime:    `${Math.floor(process.uptime())}s`,
        memory:    `${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB`,
        timestamp: new Date().toISOString()
    });
});

// ─── PROTECTED CACHE ROUTES ───────────────────────────────────────────────────
const router = express.Router();
router.use(authenticate, requireRedis);

// POST /api/cache — Set a single key (with optional TTL)
router.post('/', writeLimiter, async (req, res) => {
    const { key, value, ttl } = req.body;
    if (!key || value === undefined) {
        return res.status(400).json({ error: 'Both "key" and "value" are required' });
    }

    const stringValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
    if (Buffer.byteLength(stringValue) > MAX_VALUE_BYTES) {
        return res.status(413).json({ error: 'Value exceeds 1MB limit' });
    }

    try {
        const safeTTL = sanitizeTTL(ttl ?? DEFAULT_TTL);
        await redisClient.setEx(key, safeTTL, stringValue);
        res.json({ success: true, key, ttl: safeTTL, message: 'Cached successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/cache/batch — Set multiple keys at once (pipeline for speed)
router.post('/batch', writeLimiter, async (req, res) => {
    const { entries, ttl } = req.body;
    if (!Array.isArray(entries) || entries.length === 0) {
        return res.status(400).json({ error: '"entries" must be a non-empty array of { key, value } objects' });
    }
    if (entries.length > 100) {
        return res.status(400).json({ error: 'Max 100 entries per batch request' });
    }

    const safeTTL = sanitizeTTL(ttl ?? DEFAULT_TTL);
    try {
        // Use a pipeline — sends all commands in a single round-trip to Redis
        const pipeline = redisClient.multi();
        for (const { key, value } of entries) {
            if (!key || value === undefined) continue;
            const str = typeof value === 'object' ? JSON.stringify(value) : String(value);
            pipeline.setEx(key, safeTTL, str);
        }
        await pipeline.exec();
        res.json({ success: true, count: entries.length, ttl: safeTTL });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/cache/batch?keys=a,b,c — Get multiple keys at once (MUST be before /:key)
router.get('/batch', async (req, res) => {
    const keys = req.query.keys?.split(',').map(k => k.trim()).filter(Boolean);
    if (!keys || keys.length === 0) {
        return res.status(400).json({ error: 'Provide keys as ?keys=key1,key2,key3' });
    }
    if (keys.length > 100) {
        return res.status(400).json({ error: 'Max 100 keys per batch request' });
    }

    try {
        const values = await redisClient.mGet(keys);
        const result = {};
        keys.forEach((key, i) => {
            const v = values[i];
            if (v !== null) {
                try { result[key] = JSON.parse(v); } catch { result[key] = v; }
            } else {
                result[key] = null; // Not found
            }
        });
        res.json({ success: true, result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/cache/stats — Redis server info and memory usage (MUST be before /:key)
router.get('/stats', async (req, res) => {
    try {
        const info = await redisClient.info('stats');
        const memory = await redisClient.info('memory');
        const keyspace = await redisClient.info('keyspace');
        res.json({ success: true, stats: { info, memory, keyspace } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/cache/:key — Retrieve a single key (wildcard — must be last GET)
router.get('/:key', async (req, res) => {
    try {
        const { key } = req.params;
        const [value, ttl] = await Promise.all([
            redisClient.get(key),
            redisClient.ttl(key)
        ]);

        if (value === null) {
            return res.status(404).json({ error: 'Key not found or expired' });
        }

        let parsed;
        try { parsed = JSON.parse(value); } catch { parsed = value; }

        res.json({ success: true, key, value: parsed, ttl: ttl >= 0 ? ttl : 'no-expiry' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/cache/:key — Remove a single key
router.delete('/:key', async (req, res) => {
    try {
        const result = await redisClient.del(req.params.key);
        if (result === 0) return res.status(404).json({ error: 'Key not found' });
        res.json({ success: true, key: req.params.key, message: 'Deleted from cache' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/cache/:key/ttl — Update TTL on an existing key without changing value
router.put('/:key/ttl', writeLimiter, async (req, res) => {
    const { ttl } = req.body;
    if (!ttl) return res.status(400).json({ error: '"ttl" is required in the request body' });
    try {
        const exists = await redisClient.exists(req.params.key);
        if (!exists) return res.status(404).json({ error: 'Key not found' });
        const safeTTL = sanitizeTTL(ttl);
        await redisClient.expire(req.params.key, safeTTL);
        res.json({ success: true, key: req.params.key, ttl: safeTTL });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/cache/flush — Wipe everything (use carefully!)
router.post('/flush', writeLimiter, async (req, res) => {
    try {
        await redisClient.flushAll();
        res.json({ success: true, message: 'All cache flushed' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.use('/api/cache', router);

// 404 handler
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

// ─── START SERVER ─────────────────────────────────────────────────────────────
async function startServer() {
    // Bind Express FIRST so Render's port scanner succeeds immediately
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Server running on port ${PORT} (pid ${process.pid})`);
    });

    // Then connect to Redis in the background — it will retry automatically
    try {
        await redisClient.connect();
    } catch (err) {
        console.error('Initial Redis connect failed (retrying in background):', err.message);
    }
}

startServer();

// ─── GRACEFUL SHUTDOWN ────────────────────────────────────────────────────────
const shutdown = async (signal) => {
    console.log(`\n${signal} received — shutting down gracefully...`);
    await redisClient.quit().catch(() => {});
    process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
