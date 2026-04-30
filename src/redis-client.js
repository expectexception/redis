const { createClient } = require('redis');
const config = require('./config');

let redisReady = false;
let lastError = null;
let connectTime = null;

const client = createClient({
    url: config.REDIS_URL,
    socket: {
        reconnectStrategy: (retries) => {
            if (retries > config.REDIS_MAX_RETRIES) {
                return new Error('Redis: max reconnect retries exceeded');
            }
            return Math.min(retries * 100, config.REDIS_RETRY_DELAY_CAP);
        },
        connectTimeout: config.REDIS_CONNECT_TIMEOUT,
        keepAlive: config.REDIS_KEEPALIVE,
    }
});

client.on('connect', () => {
    redisReady = true;
    connectTime = Date.now();
    lastError = null;
    console.log('✅ Redis connected');
});

client.on('ready', () => {
    redisReady = true;
    console.log('⚡ Redis ready');
});

client.on('end', () => {
    redisReady = false;
    console.log('🔌 Redis disconnected');
});

client.on('reconnecting', () => {
    redisReady = false;
    console.log('⏳ Redis reconnecting...');
});

client.on('error', (err) => {
    redisReady = false;
    lastError = err.message;
    // throttle log noise
    if (!err.message.includes('ENOTFOUND') || Math.random() < 0.05) {
        console.error('Redis error:', err.message);
    }
});

async function connect() {
    try {
        await client.connect();
    } catch (err) {
        console.error('Initial Redis connect failed (retrying in background):', err.message);
    }
}

async function disconnect() {
    try {
        await client.quit();
    } catch { /* swallow */ }
}

function isReady() {
    return redisReady;
}

function getStatus() {
    return {
        connected: redisReady,
        lastError,
        connectTime: connectTime ? new Date(connectTime).toISOString() : null,
        uptimeSeconds: connectTime ? Math.floor((Date.now() - connectTime) / 1000) : 0,
    };
}

module.exports = { client, connect, disconnect, isReady, getStatus };
