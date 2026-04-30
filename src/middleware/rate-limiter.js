const rateLimit = require('express-rate-limit');
const config = require('../config');

const readLimiter = rateLimit({
    windowMs: config.RATE_LIMIT_WINDOW_MS,
    max: config.RATE_LIMIT_READ_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Rate limit exceeded', message: 'Too many read requests. Slow down.' },
    // Use API key if present, otherwise fall back to default IP-based keying
    keyGenerator: (req) => req.headers['x-api-key'] || undefined,
    validate: { xForwardedForHeader: false },
});

const writeLimiter = rateLimit({
    windowMs: config.RATE_LIMIT_WINDOW_MS,
    max: config.RATE_LIMIT_WRITE_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Rate limit exceeded', message: 'Too many write requests. Slow down.' },
    keyGenerator: (req) => req.headers['x-api-key'] || undefined,
    validate: { xForwardedForHeader: false },
});

module.exports = { readLimiter, writeLimiter };
