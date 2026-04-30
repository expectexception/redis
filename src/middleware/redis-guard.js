const { isReady } = require('../redis-client');

function requireRedis(req, res, next) {
    if (!isReady()) {
        return res.status(503).json({
            error: 'Service Unavailable',
            message: 'Cache backend temporarily unavailable. Retrying connection...'
        });
    }
    next();
}

module.exports = { requireRedis };
