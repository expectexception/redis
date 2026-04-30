const config = require('../config');

/**
 * API key authentication.
 * Accepts: Authorization: Bearer <key>, x-api-key: <key>, or ?apiKey=<key>
 */
function authenticate(req, res, next) {
    const auth = req.headers['authorization'] || req.headers['x-api-key'] || req.query.apiKey;
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : auth;

    if (!token || token !== config.API_KEY) {
        return res.status(401).json({
            error: 'Unauthorized',
            message: 'Invalid or missing API key. Use Authorization: Bearer <key>'
        });
    }

    // Extract namespace from header (defaults to 'default')
    req.namespace = (req.headers['x-namespace'] || config.DEFAULT_NAMESPACE)
        .replace(/[^a-zA-Z0-9_\-]/g, '_')  // sanitize
        .substring(0, 64);                   // cap length

    next();
}

module.exports = { authenticate };
