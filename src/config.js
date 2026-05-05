// Config loaded once — dotenv called in server.js entrypoint only

module.exports = {
    // ─── Server ──────────────────────────────────────
    PORT: parseInt(process.env.PORT, 10) || 3000,
    NODE_ENV: process.env.NODE_ENV || 'development',
    IS_PRODUCTION: process.env.NODE_ENV === 'production',
    RENDER_EXTERNAL_URL: process.env.RENDER_EXTERNAL_URL || process.env.SELF_PING_URL,

    // ─── Redis ───────────────────────────────────────
    REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
    REDIS_CONNECT_TIMEOUT: 5000,
    REDIS_KEEPALIVE: 5000,
    REDIS_MAX_RETRIES: 20,
    REDIS_RETRY_DELAY_CAP: 3000,

    // ─── Auth ────────────────────────────────────────
    API_KEY: process.env.API_KEY || 'dev-test-api-key',

    // ─── Cache defaults ──────────────────────────────
    DEFAULT_TTL: 3600,                    // 1 hour
    MAX_TTL: 60 * 60 * 24 * 30,          // 30 days max
    MAX_VALUE_BYTES: 5 * 1024 * 1024,    // 5 MB max value
    MAX_BATCH_SIZE: 500,                  // 500 keys per batch
    MAX_PATTERN_SCAN: 10000,             // max keys returned by pattern scan

    // ─── Rate limits ─────────────────────────────────
    RATE_LIMIT_WINDOW_MS: 60_000,
    RATE_LIMIT_READ_MAX: 600,            // 600 reads/min
    RATE_LIMIT_WRITE_MAX: 200,           // 200 writes/min

    // ─── Workers ─────────────────────────────────────
    WORKER_STATS_INTERVAL_MS: 30_000,
    WORKER_MEMORY_CHECK_MS: 60_000,
    WORKER_MEMORY_WARN_MB: 200,
    WORKER_EVICTION_CHECK_MS: 300_000,

    // ─── Distributed locking (stampede protection) ───
    // How long a compute lock is held before it auto-expires (seconds).
    // Must be > your worst-case compute time.
    DISTRIBUTED_LOCK_TTL_S: 10,

    // ─── Namespaces ──────────────────────────────────
    NAMESPACE_SEPARATOR: '::',
    DEFAULT_NAMESPACE: 'default',
};

