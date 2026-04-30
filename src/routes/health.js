const express = require('express');
const { isReady, getStatus, client } = require('../redis-client');
const config = require('../config');

const router = express.Router();

// ──────────────────────────────────────────────────────────────────────────────
// GET /health — Public health check
// ──────────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
    let redisPing = 'disconnected';
    let latencyMs = null;

    try {
        if (isReady()) {
            const start = process.hrtime.bigint();
            await client.ping();
            latencyMs = Number(process.hrtime.bigint() - start) / 1e6;
            redisPing = 'ok';
        }
    } catch { /* ignore */ }

    const status = redisPing === 'ok' ? 200 : 503;
    res.status(status).json({
        status: status === 200 ? 'healthy' : 'degraded',
        redis: {
            status: redisPing,
            latencyMs: latencyMs ? Math.round(latencyMs * 100) / 100 : null,
            ...getStatus(),
        },
        server: {
            pid: process.pid,
            uptime: `${Math.floor(process.uptime())}s`,
            memory: `${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`,
            nodeVersion: process.version,
            env: config.NODE_ENV,
        },
        timestamp: new Date().toISOString(),
    });
});

module.exports = router;
