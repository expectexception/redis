require('dotenv').config();
const express = require('express');
const { createClient } = require('redis');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'default-secret-key-change-me';

// Middleware
app.use(express.json());
app.use(cors());
app.use(helmet());
app.use(morgan('dev'));

// Auth Middleware to secure our API
const authenticate = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    if (!authHeader || authHeader !== `Bearer ${API_KEY}`) {
        return res.status(401).json({ error: 'Unauthorized: Invalid or missing API Key' });
    }
    next();
};

// Initialize Redis Client
const redisClient = createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379'
});

redisClient.on('error', (err) => console.error('Redis Client Error:', err));
redisClient.on('connect', () => console.log('✅ Connected to Redis successfully'));
redisClient.on('reconnecting', () => console.log('⏳ Reconnecting to Redis...'));

// Healthcheck Route (Public)
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        redis: redisClient.isOpen ? 'connected' : 'disconnected',
        timestamp: new Date().toISOString()
    });
});

// ==========================================
// CACHE API ROUTES (Protected)
// ==========================================

// Set Cache (Supports JSON and strings, optional TTL in seconds)
app.post('/api/cache', authenticate, async (req, res) => {
    const { key, value, ttl } = req.body;
    
    if (!key || value === undefined) {
        return res.status(400).json({ error: 'Key and value are required in request body' });
    }

    try {
        const stringValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
        
        if (ttl) {
            await redisClient.setEx(key, parseInt(ttl, 10), stringValue);
        } else {
            await redisClient.set(key, stringValue);
        }
        res.json({ success: true, key, message: 'Saved to cache successfully' });
    } catch (error) {
        console.error('Cache SET error:', error);
        res.status(500).json({ error: 'Failed to save to cache' });
    }
});

// Get Cache
app.get('/api/cache/:key', authenticate, async (req, res) => {
    const { key } = req.params;

    try {
        const value = await redisClient.get(key);
        if (value === null) {
            return res.status(404).json({ error: 'Key not found in cache' });
        }
        
        try {
            // Attempt to parse JSON
            res.json({ success: true, key, value: JSON.parse(value) });
        } catch {
            // Return as string if parsing fails
            res.json({ success: true, key, value });
        }
    } catch (error) {
        console.error('Cache GET error:', error);
        res.status(500).json({ error: 'Failed to retrieve from cache' });
    }
});

// Delete Cache
app.delete('/api/cache/:key', authenticate, async (req, res) => {
    const { key } = req.params;

    try {
        const result = await redisClient.del(key);
        if (result === 0) {
            return res.status(404).json({ error: 'Key not found in cache' });
        }
        res.json({ success: true, key, message: 'Deleted from cache successfully' });
    } catch (error) {
        console.error('Cache DELETE error:', error);
        res.status(500).json({ error: 'Failed to delete from cache' });
    }
});

// Clear All Cache (Use with caution)
app.post('/api/cache/flush', authenticate, async (req, res) => {
    try {
        await redisClient.flushAll();
        res.json({ success: true, message: 'All cache cleared successfully' });
    } catch (error) {
        console.error('Cache FLUSH error:', error);
        res.status(500).json({ error: 'Failed to flush cache' });
    }
});

// Start the Server
async function startServer() {
    try {
        await redisClient.connect();
        app.listen(PORT, () => {
            console.log(`🚀 Caching API server is running on port ${PORT}`);
        });
    } catch (err) {
        console.error('Failed to start server:', err);
        process.exit(1);
    }
}

startServer();
