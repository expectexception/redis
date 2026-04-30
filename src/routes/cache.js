const express = require('express');
const { client } = require('../redis-client');
const { readLimiter, writeLimiter } = require('../middleware/rate-limiter');
const config = require('../config');
const {
    nsKey, stripNs, nsPattern,
    sanitizeTTL, serialize, deserialize,
    validateKey, validateValueSize,
} = require('../helpers');

const router = express.Router();

// POST /api/cache — Set single key
router.post('/', writeLimiter, async (req, res) => {
    const { key, value, ttl, tags } = req.body;
    const keyErr = validateKey(key);
    if (keyErr) return res.status(400).json({ error: keyErr });
    if (value === undefined) return res.status(400).json({ error: '"value" is required' });

    const serialized = serialize(value, tags);
    const sizeErr = validateValueSize(serialized);
    if (sizeErr) return res.status(413).json({ error: sizeErr });

    try {
        const safeTTL = sanitizeTTL(ttl);
        const fullKey = nsKey(req.namespace, key);
        const pipeline = client.multi();
        pipeline.setEx(fullKey, safeTTL, serialized);

        if (Array.isArray(tags) && tags.length > 0) {
            for (const tag of tags) {
                const tagKey = nsKey(req.namespace, `__tag:${tag}`);
                pipeline.sAdd(tagKey, fullKey);
                pipeline.expire(tagKey, safeTTL + 3600);
            }
        }
        await pipeline.exec();
        res.json({ success: true, key, namespace: req.namespace, ttl: safeTTL });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/cache/batch — Batch set (pipelined)
router.post('/batch', writeLimiter, async (req, res) => {
    const { entries, ttl } = req.body;
    if (!Array.isArray(entries) || entries.length === 0) {
        return res.status(400).json({ error: '"entries" must be non-empty array of {key,value}' });
    }
    if (entries.length > config.MAX_BATCH_SIZE) {
        return res.status(400).json({ error: `Max ${config.MAX_BATCH_SIZE} entries per batch` });
    }

    const safeTTL = sanitizeTTL(ttl);
    const errors = [];
    try {
        const pipeline = client.multi();
        let written = 0;

        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            const keyErr = validateKey(entry.key);
            if (keyErr) { errors.push({ index: i, key: entry.key, error: keyErr }); continue; }
            if (entry.value === undefined) { errors.push({ index: i, key: entry.key, error: 'missing value' }); continue; }

            const entryTTL = sanitizeTTL(entry.ttl ?? ttl);
            const serialized = serialize(entry.value, entry.tags);
            const sizeErr = validateValueSize(serialized);
            if (sizeErr) { errors.push({ index: i, key: entry.key, error: sizeErr }); continue; }

            pipeline.setEx(nsKey(req.namespace, entry.key), entryTTL, serialized);
            written++;
        }

        if (written > 0) await pipeline.exec();
        res.json({ success: true, written, skipped: errors.length, errors: errors.length ? errors : undefined, ttl: safeTTL });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/cache/batch?keys=a,b,c — Batch get (MGET)
router.get('/batch', readLimiter, async (req, res) => {
    const keys = req.query.keys?.split(',').map(k => k.trim()).filter(Boolean);
    if (!keys || keys.length === 0) {
        return res.status(400).json({ error: 'Provide ?keys=key1,key2,key3' });
    }
    if (keys.length > config.MAX_BATCH_SIZE) {
        return res.status(400).json({ error: `Max ${config.MAX_BATCH_SIZE} keys per batch` });
    }

    try {
        const fullKeys = keys.map(k => nsKey(req.namespace, k));
        const [values, ...ttls] = await Promise.all([
            client.mGet(fullKeys),
            ...fullKeys.map(k => client.ttl(k)),
        ]);
        const result = {};
        let hits = 0;

        keys.forEach((key, i) => {
            const parsed = deserialize(values[i]);
            if (parsed) {
                result[key] = { value: parsed.value, type: parsed.type, ttl: ttls[i] >= 0 ? ttls[i] : 'no-expiry' };
                hits++;
            } else {
                result[key] = null;
            }
        });

        res.json({ success: true, hits, misses: keys.length - hits, result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/cache/keys?pattern=user:* — List keys (SCAN)
router.get('/keys', readLimiter, async (req, res) => {
    const pattern = req.query.pattern || '*';
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, config.MAX_PATTERN_SCAN);

    try {
        const scanPattern = nsPattern(req.namespace, pattern);
        const keys = [];
        for await (const key of client.scanIterator({ MATCH: scanPattern, COUNT: 100 })) {
            keys.push(stripNs(key));
            if (keys.length >= limit) break;
        }
        res.json({ success: true, count: keys.length, keys });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/cache/invalidate — Invalidate by pattern or tags
router.post('/invalidate', writeLimiter, async (req, res) => {
    const { pattern, tags } = req.body;
    if (!pattern && (!Array.isArray(tags) || tags.length === 0)) {
        return res.status(400).json({ error: 'Provide "pattern" or "tags" array' });
    }

    try {
        let deleted = 0;

        if (pattern) {
            const keysToDelete = [];
            for await (const key of client.scanIterator({ MATCH: nsPattern(req.namespace, pattern), COUNT: 200 })) {
                keysToDelete.push(key);
                if (keysToDelete.length >= config.MAX_PATTERN_SCAN) break;
            }
            if (keysToDelete.length > 0) {
                for (let i = 0; i < keysToDelete.length; i += 1000) {
                    deleted += await client.del(keysToDelete.slice(i, i + 1000));
                }
            }
        }

        if (Array.isArray(tags) && tags.length > 0) {
            for (const tag of tags) {
                const tagKey = nsKey(req.namespace, `__tag:${tag}`);
                const taggedKeys = await client.sMembers(tagKey);
                if (taggedKeys.length > 0) {
                    for (let i = 0; i < taggedKeys.length; i += 1000) {
                        deleted += await client.del(taggedKeys.slice(i, i + 1000));
                    }
                    await client.del(tagKey);
                }
            }
        }

        res.json({ success: true, deleted });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/cache/compute — Cache-aside check
router.post('/compute', readLimiter, async (req, res) => {
    const { key } = req.body;
    const keyErr = validateKey(key);
    if (keyErr) return res.status(400).json({ error: keyErr });

    try {
        const fullKey = nsKey(req.namespace, key);
        const [raw, remaining] = await Promise.all([client.get(fullKey), client.ttl(fullKey)]);

        if (raw !== null) {
            const parsed = deserialize(raw);
            return res.json({
                success: true, hit: true, key,
                value: parsed?.value ?? raw,
                ttl: remaining >= 0 ? remaining : 'no-expiry',
            });
        }
        res.json({ success: true, hit: false, key });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/cache/incr — Atomic increment/decrement
router.post('/incr', writeLimiter, async (req, res) => {
    const { key, amount = 1 } = req.body;
    const keyErr = validateKey(key);
    if (keyErr) return res.status(400).json({ error: keyErr });

    try {
        const fullKey = nsKey(req.namespace, key);
        const n = parseInt(amount, 10);
        if (isNaN(n)) return res.status(400).json({ error: '"amount" must be integer' });

        let newVal;
        if (n >= 0) {
            newVal = await client.incrBy(fullKey, n);
        } else {
            newVal = await client.decrBy(fullKey, Math.abs(n));
        }
        res.json({ success: true, key, value: newVal });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/cache/hash — Hash operations (HSET/HGET/HDEL/HGETALL)
router.post('/hash', writeLimiter, async (req, res) => {
    const { key, op, field, fields, value, ttl } = req.body;
    const keyErr = validateKey(key);
    if (keyErr) return res.status(400).json({ error: keyErr });

    const fullKey = nsKey(req.namespace, key);
    try {
        switch (op) {
            case 'set': {
                if (fields && typeof fields === 'object') {
                    // Multi-field set
                    const flat = [];
                    for (const [f, v] of Object.entries(fields)) {
                        flat.push(f, typeof v === 'object' ? JSON.stringify(v) : String(v));
                    }
                    await client.hSet(fullKey, flat);
                } else if (field && value !== undefined) {
                    await client.hSet(fullKey, field, typeof value === 'object' ? JSON.stringify(value) : String(value));
                } else {
                    return res.status(400).json({ error: 'Provide "field"+"value" or "fields" object' });
                }
                if (ttl) await client.expire(fullKey, sanitizeTTL(ttl));
                return res.json({ success: true, key, op: 'hset' });
            }
            case 'get': {
                if (field) {
                    const val = await client.hGet(fullKey, field);
                    if (val === null) return res.status(404).json({ error: 'Field not found' });
                    let parsed; try { parsed = JSON.parse(val); } catch { parsed = val; }
                    return res.json({ success: true, key, field, value: parsed });
                }
                // HGETALL
                const all = await client.hGetAll(fullKey);
                if (!all || Object.keys(all).length === 0) return res.status(404).json({ error: 'Key not found' });
                const parsed = {};
                for (const [f, v] of Object.entries(all)) {
                    try { parsed[f] = JSON.parse(v); } catch { parsed[f] = v; }
                }
                return res.json({ success: true, key, value: parsed });
            }
            case 'del': {
                if (!field && !fields) return res.status(400).json({ error: '"field" or "fields" required' });
                const toDel = fields || [field];
                const count = await client.hDel(fullKey, toDel);
                return res.json({ success: true, key, deleted: count });
            }
            default:
                return res.status(400).json({ error: '"op" must be "set", "get", or "del"' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/cache/list — List operations (PUSH/POP/RANGE/LEN)
router.post('/list', writeLimiter, async (req, res) => {
    const { key, op, value, values, start = 0, stop = -1, ttl } = req.body;
    const keyErr = validateKey(key);
    if (keyErr) return res.status(400).json({ error: keyErr });

    const fullKey = nsKey(req.namespace, key);
    const ser = (v) => typeof v === 'object' ? JSON.stringify(v) : String(v);

    try {
        switch (op) {
            case 'rpush': {
                const items = values || (value !== undefined ? [value] : null);
                if (!items) return res.status(400).json({ error: '"value" or "values" required' });
                const len = await client.rPush(fullKey, items.map(ser));
                if (ttl) await client.expire(fullKey, sanitizeTTL(ttl));
                return res.json({ success: true, key, length: len });
            }
            case 'lpush': {
                const items = values || (value !== undefined ? [value] : null);
                if (!items) return res.status(400).json({ error: '"value" or "values" required' });
                const len = await client.lPush(fullKey, items.map(ser));
                if (ttl) await client.expire(fullKey, sanitizeTTL(ttl));
                return res.json({ success: true, key, length: len });
            }
            case 'rpop': {
                const val = await client.rPop(fullKey);
                if (val === null) return res.status(404).json({ error: 'List empty or not found' });
                let p; try { p = JSON.parse(val); } catch { p = val; }
                return res.json({ success: true, key, value: p });
            }
            case 'lpop': {
                const val = await client.lPop(fullKey);
                if (val === null) return res.status(404).json({ error: 'List empty or not found' });
                let p; try { p = JSON.parse(val); } catch { p = val; }
                return res.json({ success: true, key, value: p });
            }
            case 'range': {
                const items = await client.lRange(fullKey, start, stop);
                const parsed = items.map(v => { try { return JSON.parse(v); } catch { return v; } });
                return res.json({ success: true, key, values: parsed, length: parsed.length });
            }
            case 'len': {
                const len = await client.lLen(fullKey);
                return res.json({ success: true, key, length: len });
            }
            default:
                return res.status(400).json({ error: '"op" must be rpush/lpush/rpop/lpop/range/len' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/cache/set — Set (unique collection) operations
router.post('/set', writeLimiter, async (req, res) => {
    const { key, op, value, values, ttl } = req.body;
    const keyErr = validateKey(key);
    if (keyErr) return res.status(400).json({ error: keyErr });

    const fullKey = nsKey(req.namespace, key);
    const ser = (v) => typeof v === 'object' ? JSON.stringify(v) : String(v);

    try {
        switch (op) {
            case 'add': {
                const items = values || (value !== undefined ? [value] : null);
                if (!items) return res.status(400).json({ error: '"value" or "values" required' });
                const added = await client.sAdd(fullKey, items.map(ser));
                if (ttl) await client.expire(fullKey, sanitizeTTL(ttl));
                return res.json({ success: true, key, added });
            }
            case 'remove': {
                const items = values || (value !== undefined ? [value] : null);
                if (!items) return res.status(400).json({ error: '"value" or "values" required' });
                const removed = await client.sRem(fullKey, items.map(ser));
                return res.json({ success: true, key, removed });
            }
            case 'members': {
                const members = await client.sMembers(fullKey);
                const parsed = members.map(v => { try { return JSON.parse(v); } catch { return v; } });
                return res.json({ success: true, key, members: parsed, size: parsed.length });
            }
            case 'ismember': {
                if (value === undefined) return res.status(400).json({ error: '"value" required' });
                const is = await client.sIsMember(fullKey, ser(value));
                return res.json({ success: true, key, isMember: is });
            }
            case 'size': {
                const size = await client.sCard(fullKey);
                return res.json({ success: true, key, size });
            }
            default:
                return res.status(400).json({ error: '"op" must be add/remove/members/ismember/size' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/cache/stats
router.get('/stats', readLimiter, async (req, res) => {
    try {
        const [info, memory, keyspace, dbsize] = await Promise.all([
            client.info('stats'), client.info('memory'),
            client.info('keyspace'), client.dbSize(),
        ]);

        let nsKeyCount = 0;
        for await (const _ of client.scanIterator({ MATCH: nsPattern(req.namespace, '*'), COUNT: 500 })) {
            nsKeyCount++;
            if (nsKeyCount >= config.MAX_PATTERN_SCAN) break;
        }

        res.json({
            success: true, namespace: req.namespace, namespaceKeys: nsKeyCount, totalKeys: dbsize,
            redis: { stats: info, memory, keyspace },
            server: { pid: process.pid, uptime: `${Math.floor(process.uptime())}s`, memory: `${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB` },
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/cache/:key
router.get('/:key', readLimiter, async (req, res) => {
    try {
        const fullKey = nsKey(req.namespace, req.params.key);
        const [raw, ttl] = await Promise.all([client.get(fullKey), client.ttl(fullKey)]);
        if (raw === null) return res.status(404).json({ error: 'Key not found or expired' });

        const parsed = deserialize(raw);
        res.json({
            success: true, key: req.params.key, namespace: req.namespace,
            value: parsed.value, type: parsed.type,
            storedAt: parsed.storedAt ? new Date(parsed.storedAt).toISOString() : null,
            tags: parsed.tags, sizeBytes: parsed.sizeBytes,
            ttl: ttl >= 0 ? ttl : 'no-expiry',
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/cache/:key
router.delete('/:key', writeLimiter, async (req, res) => {
    try {
        const fullKey = nsKey(req.namespace, req.params.key);
        const result = await client.del(fullKey);
        if (result === 0) return res.status(404).json({ error: 'Key not found' });
        res.json({ success: true, key: req.params.key, deleted: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PATCH /api/cache/:key — Update TTL or value
router.patch('/:key', writeLimiter, async (req, res) => {
    const { ttl, value, tags } = req.body;
    const fullKey = nsKey(req.namespace, req.params.key);

    try {
        const exists = await client.exists(fullKey);
        if (!exists) return res.status(404).json({ error: 'Key not found' });

        const updates = {};
        if (value !== undefined) {
            const serialized = serialize(value, tags);
            const sizeErr = validateValueSize(serialized);
            if (sizeErr) return res.status(413).json({ error: sizeErr });
            const safeTTL = sanitizeTTL(ttl);
            await client.setEx(fullKey, safeTTL, serialized);
            updates.value = true;
            updates.ttl = safeTTL;
        } else if (ttl !== undefined) {
            const safeTTL = sanitizeTTL(ttl);
            await client.expire(fullKey, safeTTL);
            updates.ttl = safeTTL;
        }
        res.json({ success: true, key: req.params.key, updates });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/cache/flush — Flush namespace only
router.post('/flush', writeLimiter, async (req, res) => {
    try {
        const keysToDelete = [];
        for await (const key of client.scanIterator({ MATCH: nsPattern(req.namespace, '*'), COUNT: 500 })) {
            keysToDelete.push(key);
        }

        let deleted = 0;
        for (let i = 0; i < keysToDelete.length; i += 1000) {
            deleted += await client.del(keysToDelete.slice(i, i + 1000));
        }
        res.json({ success: true, namespace: req.namespace, deleted });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
