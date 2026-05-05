const rateLimit = require('express-rate-limit');
const config = require('../config');

// ─── Redis-backed store for cluster-safe rate limiting ───────────────────────
//
// BUG FIX #1: The old keyGenerator used req.headers['x-api-key'] but the auth
// middleware reads from 'Authorization: Bearer' — so it almost always fell back
// to undefined, making express-rate-limit use IP-based keying. Now we use
// req.apiKey which the auth middleware sets after validating the token.
//
// BUG FIX #2: The default in-memory store is per-process. In cluster mode
// (N workers), a client could send max*N requests before being rate-limited.
// We use a Redis-backed store so all workers share a single rate limit counter.
//
function makeRedisStore(prefix) {
    // Lazy-load the redis client to avoid circular deps at module init time.
    // The client is imported here rather than at the top level so that
    // rate-limiter.js can be required before Redis connects.
    let _client = null;
    const getClient = () => {
        if (!_client) _client = require('../redis-client').client;
        return _client;
    };

    return {
        // express-rate-limit v7 store interface
        async increment(key) {
            const c = getClient();
            const rKey = `${prefix}${key}`;
            const windowSecs = Math.ceil(config.RATE_LIMIT_WINDOW_MS / 1000);
            // INCR + EXPIRE in a single pipeline so the TTL is always set
            const pipeline = c.multi();
            pipeline.incr(rKey);
            pipeline.expire(rKey, windowSecs, 'NX'); // only set TTL on first write
            const [count] = await pipeline.exec();
            const ttl = await c.pTTL(rKey);
            return {
                totalHits: count,
                resetTime: new Date(Date.now() + (ttl > 0 ? ttl : config.RATE_LIMIT_WINDOW_MS)),
            };
        },
        async decrement(key) {
            const c = getClient();
            await c.decr(`${prefix}${key}`);
        },
        async resetKey(key) {
            const c = getClient();
            await c.del(`${prefix}${key}`);
        },
    };
}

const readLimiter = rateLimit({
    windowMs: config.RATE_LIMIT_WINDOW_MS,
    max: config.RATE_LIMIT_READ_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Rate limit exceeded', message: 'Too many read requests. Slow down.' },
    // Use the validated API key stored by auth middleware (req.apiKey).
    // Falls back to IP only for unauthenticated routes (e.g. /health).
    keyGenerator: (req) => req.apiKey || req.ip,
    store: makeRedisStore('rl:read:'),
    validate: { xForwardedForHeader: false },
    skip: (req) => !req.apiKey, // skip limiter entirely for routes without auth
});

const writeLimiter = rateLimit({
    windowMs: config.RATE_LIMIT_WINDOW_MS,
    max: config.RATE_LIMIT_WRITE_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Rate limit exceeded', message: 'Too many write requests. Slow down.' },
    keyGenerator: (req) => req.apiKey || req.ip,
    store: makeRedisStore('rl:write:'),
    validate: { xForwardedForHeader: false },
    skip: (req) => !req.apiKey,
});

module.exports = { readLimiter, writeLimiter };
