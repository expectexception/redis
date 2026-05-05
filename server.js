require('dotenv').config();
const cluster = require('cluster');
const os = require('os');
const config = require('./src/config');

const NUM_CPUS = os.cpus().length;

// ─── CLUSTER MASTER ──────────────────────────────────────────────────────────
if (config.IS_PRODUCTION && cluster.isMaster && NUM_CPUS > 1) {
    console.log(`🧠 Master ${process.pid} — forking ${NUM_CPUS} workers`);
    for (let i = 0; i < NUM_CPUS; i++) cluster.fork();

    cluster.on('exit', (worker, code, signal) => {
        console.warn(`⚠️  Worker ${worker.process.pid} died (code=${code}, signal=${signal}). Respawning...`);
        setTimeout(() => cluster.fork(), 1000);
    });

    const shutdownMaster = () => {
        console.log('\n🛑 Master shutting down all workers...');
        for (const id in cluster.workers) {
            cluster.workers[id].process.kill('SIGTERM');
        }
        setTimeout(() => process.exit(0), 5000);
    };
    process.on('SIGTERM', shutdownMaster);
    process.on('SIGINT', shutdownMaster);
    return;
}

// ─── WORKER / SINGLE PROCESS ─────────────────────────────────────────────────
const express     = require('express');
const cors        = require('cors');
const helmet      = require('helmet');
const morgan      = require('morgan');
const compression = require('compression');

const { connect, disconnect }       = require('./src/redis-client');
const { authenticate }              = require('./src/middleware/auth');
const { requireRedis }              = require('./src/middleware/redis-guard');
const { generateRequestId }         = require('./src/helpers');
const cacheRoutes                   = require('./src/routes/cache');
const healthRoutes                  = require('./src/routes/health');
const { startWorkers, stopWorkers } = require('./src/workers');

const app = express();

// ─── GLOBAL MIDDLEWARE ───────────────────────────────────────────────────────
app.use(compression({ level: 9, threshold: 512 }));
app.use(helmet());
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'x-namespace'],
    exposedHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset', 'X-Request-Id', 'X-Response-Time'],
}));
app.use(express.json({ limit: '5mb' }));
app.use(morgan(config.IS_PRODUCTION ? 'combined' : 'dev'));

// Request ID + high-res timing
app.use((req, res, next) => {
    req.startTime = process.hrtime.bigint();
    req.requestId = req.headers['x-request-id'] || generateRequestId();
    res.setHeader('X-Request-Id', req.requestId);

    // Patch res.end so we can inject X-Response-Time before headers flush.
    // We do it here (in the interceptor) rather than in a res.on('finish')
    // listener because finish fires AFTER headers are sent — too late to set them.
    const origEnd = res.end;
    res.end = function (...args) {
        if (!res.headersSent) {
            const ms = Number(process.hrtime.bigint() - req.startTime) / 1e6;
            res.setHeader('X-Response-Time', `${ms.toFixed(2)}ms`);
        }
        return origEnd.apply(this, args);
    };
    next();
});

// ─── ROUTES ──────────────────────────────────────────────────────────────────
app.use('/health', healthRoutes);
app.use('/api/cache', authenticate, requireRedis, cacheRoutes);

app.get('/', (req, res) => {
    res.json({
        name: 'Redis Caching Server',
        version: '3.0.0',
        endpoints: {
            health: 'GET /health',
            cache: {
                get: 'GET /api/cache/:key',
                set: 'POST /api/cache',
                delete: 'DELETE /api/cache/:key',
                patch: 'PATCH /api/cache/:key',
                batchGet: 'GET /api/cache/batch?keys=a,b,c',
                batchSet: 'POST /api/cache/batch',
                keys: 'GET /api/cache/keys?pattern=*',
                invalidate: 'POST /api/cache/invalidate',
                compute: 'POST /api/cache/compute',
                incr: 'POST /api/cache/incr',
                flush: 'POST /api/cache/flush',
                stats: 'GET /api/cache/stats',
            },
            dataStructures: {
                hash: 'POST /api/cache/hash  {op: set|get|del}',
                list: 'POST /api/cache/list  {op: rpush|lpush|rpop|lpop|range|len}',
                set:  'POST /api/cache/set   {op: add|remove|members|ismember|size}',
            },
        },
        headers: {
            auth: 'Authorization: Bearer <API_KEY>',
            namespace: 'X-Namespace: <project-name>',
        },
        sdks: {
            nodejs: 'sdk/cache-client.js  — works in Node, browser, Deno, Bun',
            python: 'sdk/python/cache_client.py  — sync (requests) + async (httpx)',
        },
    });
});

app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

app.use((err, req, res, _next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// ─── START ───────────────────────────────────────────────────────────────────
// BUG FIX: The old code called app.listen() BEFORE await connect(). During the
// brief window between listen() and Redis being ready, requests would hit the
// requireRedis middleware and get a 503. Correct order: Redis first, then serve.
async function startServer() {
    try {
        await connect();
    } catch (err) {
        // connect() already logs and retries in the background — don't crash.
        console.warn('⚠️  Redis not immediately available; server will retry in background.');
    }

    const server = app.listen(config.PORT, '0.0.0.0', () => {
        console.log(`🚀 Server on port ${config.PORT} (pid ${process.pid})`);
    });

    server.on('error', (err) => {
        console.error('Server listen error:', err);
        process.exit(1);
    });

    startWorkers();
    return server;
}

startServer();

// ─── GRACEFUL SHUTDOWN ───────────────────────────────────────────────────────
const shutdown = async (signal) => {
    console.log(`\n${signal} — graceful shutdown...`);
    stopWorkers();
    await disconnect();
    process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    process.exit(1);
});
process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
});
