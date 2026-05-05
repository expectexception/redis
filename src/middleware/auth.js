const crypto = require('crypto');
const config = require('../config');

/**
 * Constant-time string comparison to prevent timing-based API key discovery.
 * A plain `!==` comparison leaks timing information — an attacker can measure
 * how long the comparison takes and deduce how many characters are correct.
 */
function timingSafeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    // Lengths must match for timingSafeEqual; if they differ we still do a
    // dummy comparison so the function takes the same wall-clock time.
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) {
        // Dummy compare of a against itself so no early return
        crypto.timingSafeEqual(bufA, bufA);
        return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * API key authentication.
 * Accepts: Authorization: Bearer <key>, x-api-key: <key>, or ?apiKey=<key>
 *
 * After validation, stores req.apiKey so the rate-limiter can use it
 * as a per-client bucket key instead of falling back to IP.
 */
function authenticate(req, res, next) {
    const auth = req.headers['authorization'] || req.headers['x-api-key'] || req.query.apiKey;
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : auth;

    if (!token || !timingSafeEqual(token, config.API_KEY)) {
        return res.status(401).json({
            error: 'Unauthorized',
            message: 'Invalid or missing API key. Use Authorization: Bearer <key>'
        });
    }

    // Store for rate-limiter key generator
    req.apiKey = token;

    // Extract namespace from header (defaults to 'default')
    req.namespace = (req.headers['x-namespace'] || config.DEFAULT_NAMESPACE)
        .replace(/[^a-zA-Z0-9_\-]/g, '_')  // sanitize
        .substring(0, 64);                   // cap length

    next();
}

module.exports = { authenticate };
