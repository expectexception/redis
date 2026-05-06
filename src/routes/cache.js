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

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/cache — Set single key
// ─────────────────────────────────────────────────────────────────────────────
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
        
        const existing = await client.get(fullKey);
        const pipeline = client.multi();

        if (existing === serialized) {
            pipeline.expire(fullKey, safeTTL);
        } else {
            pipeline.setEx(fullKey, safeTTL, serialized);
        }

        if (Array.isArray(tags) && tags.length > 0) {
            for (const tag of tags) {
                const tagKey = nsKey(req.namespace, `__tag:${tag}`);
                // Tag set TTL = key TTL + 1h buffer so the index outlives the key
                pipeline.sAdd(tagKey, fullKey);
                pipeline.expire(tagKey, safeTTL + 3600);
            }
        }

        // Release stampede lock early!
        const lockKey = nsKey(req.namespace, `__lock:${key}`);
        pipeline.del(lockKey);

        await pipeline.exec();
        res.json({ success: true, key, namespace: req.namespace, ttl: safeTTL, unchanged: existing === serialized });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/cache/batch — Batch set (pipelined)
// ─────────────────────────────────────────────────────────────────────────────
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
        const keysToFetch = entries.map(e => nsKey(req.namespace, e.key));
        const existingVals = keysToFetch.length > 0 ? await client.mGet(keysToFetch) : [];

        const pipeline = client.multi();
        let written = 0;
        let skipped = 0;

        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            const keyErr = validateKey(entry.key);
            if (keyErr) { errors.push({ index: i, key: entry.key, error: keyErr }); continue; }
            if (entry.value === undefined) { errors.push({ index: i, key: entry.key, error: 'missing value' }); continue; }

            const entryTTL = sanitizeTTL(entry.ttl ?? ttl);
            const serialized = serialize(entry.value, entry.tags);
            const sizeErr = validateValueSize(serialized);
            if (sizeErr) { errors.push({ index: i, key: entry.key, error: sizeErr }); continue; }

            const fullKey = keysToFetch[i];
            if (existingVals[i] === serialized) {
                pipeline.expire(fullKey, entryTTL);
                skipped++;
            } else {
                pipeline.setEx(fullKey, entryTTL, serialized);
                written++;
            }

            // Fix tag indexing in batch
            if (Array.isArray(entry.tags) && entry.tags.length > 0) {
                for (const tag of entry.tags) {
                    const tagKey = nsKey(req.namespace, `__tag:${tag}`);
                    pipeline.sAdd(tagKey, fullKey);
                    pipeline.expire(tagKey, entryTTL + 3600);
                }
            }
        }

        if (written > 0 || skipped > 0) await pipeline.exec();
        res.json({ success: true, written, skippedUnchanged: skipped, skippedErrors: errors.length, errors: errors.length ? errors : undefined, ttl: safeTTL });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/cache/batch?keys=a,b,c — Batch get (MGET + pipelined TTLs)
// ─────────────────────────────────────────────────────────────────────────────
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

        // PERF: Pipeline MGET + all TTL commands in one round-trip.
        // node-redis auto-pipelines concurrent awaits, but an explicit multi()
        // guarantees a single network write and read regardless of event loop timing.
        const pipeline = client.multi();
        pipeline.mGet(fullKeys);
        for (const k of fullKeys) pipeline.ttl(k);
        const pipeResults = await pipeline.exec();

        const values = pipeResults[0];           // array of raw strings (or null)
        const ttls   = pipeResults.slice(1);     // one TTL number per key

        const result = {};
        let hits = 0;

        keys.forEach((key, i) => {
            const parsed = deserialize(values[i]);
            if (parsed !== null) {
                result[key] = {
                    value: parsed.value,
                    type: parsed.type,
                    ttl: ttls[i] >= 0 ? ttls[i] : 'no-expiry',
                };
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

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/cache/batch — Batch delete keys
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/batch', writeLimiter, async (req, res) => {
    const { keys } = req.body;
    if (!Array.isArray(keys) || keys.length === 0) {
        return res.status(400).json({ error: '"keys" must be a non-empty array' });
    }
    if (keys.length > config.MAX_BATCH_SIZE) {
        return res.status(400).json({ error: `Max ${config.MAX_BATCH_SIZE} keys per batch` });
    }

    try {
        const fullKeys = keys.map(k => nsKey(req.namespace, k));
        const deleted = await client.del(fullKeys);
        res.json({ success: true, requested: keys.length, deleted });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/cache/keys?pattern=user:* — List keys (SCAN)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/keys', readLimiter, async (req, res) => {
    const pattern = req.query.pattern || '*';
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, config.MAX_PATTERN_SCAN);

    try {
        const scanPattern = nsPattern(req.namespace, pattern);
        const keys = [];
        for await (const result of client.scanIterator({ MATCH: scanPattern, COUNT: 200 })) {
            const batch = Array.isArray(result) ? result : [result];
            for (const key of batch) {
                if (key) {
                    keys.push(stripNs(key));
                    if (keys.length >= limit) break;
                }
            }
            if (keys.length >= limit) break;
        }
        res.json({ success: true, count: keys.length, keys });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/cache/invalidate — Invalidate by pattern or tags
// ─────────────────────────────────────────────────────────────────────────────
router.post('/invalidate', writeLimiter, async (req, res) => {
    const { pattern, tags } = req.body;
    if (!pattern && (!Array.isArray(tags) || tags.length === 0)) {
        return res.status(400).json({ error: 'Provide "pattern" or "tags" array' });
    }

    try {
        let deleted = 0;

        if (pattern) {
            const keysToDelete = [];
            for await (const result of client.scanIterator({ MATCH: nsPattern(req.namespace, pattern), COUNT: 200 })) {
                const batch = Array.isArray(result) ? result : [result];
                for (const key of batch) {
                    if (key) {
                        keysToDelete.push(key);
                        if (keysToDelete.length >= config.MAX_PATTERN_SCAN) break;
                    }
                }
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

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/cache/compute — Cache-aside check with stampede protection
//
// STAMPEDE FIX: When multiple clients simultaneously get a cache miss, they'd
// all go compute the same expensive value. We now use a Redis SET NX lock so
// only one caller gets told to compute (locked:true); the others are told to
// wait and retry (locked:false). The SDK's computeOrFetch handles the retry loop.
// ─────────────────────────────────────────────────────────────────────────────
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

        // Cache miss — acquire a distributed lock (SET NX EX) to prevent stampede.
        // Only the first concurrent caller gets locked=true and should compute.
        // The rest get locked=false and should wait then retry.
        const lockKey = nsKey(req.namespace, `__lock:${key}`);
        const lockResult = await client.set(lockKey, '1', {
            NX: true,
            EX: config.DISTRIBUTED_LOCK_TTL_S,
        });

        res.json({
            success: true,
            hit: false,
            key,
            // locked=true  → this caller should compute & call POST /api/cache to store
            // locked=false → another caller is computing; retry after a short delay
            locked: lockResult === 'OK',
            retryAfterMs: lockResult === 'OK' ? null : Math.ceil(config.DISTRIBUTED_LOCK_TTL_S * 1000 / 2),
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/cache/incr — Atomic increment/decrement
// ─────────────────────────────────────────────────────────────────────────────
router.post('/incr', writeLimiter, async (req, res) => {
    const { key, amount = 1 } = req.body;
    const keyErr = validateKey(key);
    if (keyErr) return res.status(400).json({ error: keyErr });

    try {
        const fullKey = nsKey(req.namespace, key);
        const n = parseInt(amount, 10);
        if (isNaN(n)) return res.status(400).json({ error: '"amount" must be integer' });

        const newVal = n >= 0
            ? await client.incrBy(fullKey, n)
            : await client.decrBy(fullKey, Math.abs(n));

        res.json({ success: true, key, value: newVal });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/cache/hash — Hash operations (HSET/HGET/HDEL)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/hash', writeLimiter, async (req, res) => {
    const { key, op, field, fields, value, ttl } = req.body;
    const keyErr = validateKey(key);
    if (keyErr) return res.status(400).json({ error: keyErr });

    const fullKey = nsKey(req.namespace, key);
    try {
        switch (op) {
            case 'set': {
                if (fields && typeof fields === 'object') {
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

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/cache/list — List operations
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/cache/set — Set (unique collection) operations
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/cache/flush — Flush all keys in this namespace
//
// ROUTE ORDER FIX: This was originally defined AFTER PATCH /:key and DELETE /:key.
// While it didn't cause a conflict (different HTTP method), it's cleaner and safer
// to keep all specific named POST routes above parametric ones.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/flush', writeLimiter, async (req, res) => {
    try {
        const keysToDelete = [];
        for await (const result of client.scanIterator({ MATCH: nsPattern(req.namespace, '*'), COUNT: 500 })) {
            const batch = Array.isArray(result) ? result : [result];
            for (const key of batch) {
                if (key) keysToDelete.push(key);
            }
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

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/cache/stats
//
// PERF FIX: The old code ran a full scanIterator loop just to count namespace
// keys. For large keyspaces (10k+ keys) this was very slow. We now cap the
// count at MAX_PATTERN_SCAN and run the Redis INFO calls in parallel.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/stats', readLimiter, async (req, res) => {
    try {
        const [info, memory, keyspace, dbsize] = await Promise.all([
            client.info('stats'),
            client.info('memory'),
            client.info('keyspace'),
            client.dbSize(),
        ]);

        // Count namespace keys up to MAX_PATTERN_SCAN — don't block forever
        let nsKeyCount = 0;
        for await (const result of client.scanIterator({ MATCH: nsPattern(req.namespace, '*'), COUNT: 500 })) {
            const batch = Array.isArray(result) ? result : [result];
            for (const _ of batch) {
                nsKeyCount++;
                if (nsKeyCount >= config.MAX_PATTERN_SCAN) break;
            }
            if (nsKeyCount >= config.MAX_PATTERN_SCAN) break;
        }

        res.json({
            success: true,
            namespace: req.namespace,
            namespaceKeys: nsKeyCount,
            namespaceKeysCapped: nsKeyCount >= config.MAX_PATTERN_SCAN,
            totalKeys: dbsize,
            redis: { stats: info, memory, keyspace },
            server: {
                pid: process.pid,
                uptime: `${Math.floor(process.uptime())}s`,
                memory: `${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`,
            },
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/cache/stats/history
// ─────────────────────────────────────────────────────────────────────────────
router.get('/stats/history', readLimiter, async (req, res) => {
    try {
        const rawHistory = await client.lRange('__system::stats_snapshots', 0, -1);
        const history = rawHistory.map(item => {
            try { return JSON.parse(item); } catch { return item; }
        });
        res.json({ success: true, count: history.length, history });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/cache/:key
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/cache/:key
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/cache/:key — Update TTL or value
//
// BUG FIX: The old code called sanitizeTTL(ttl) when ttl was undefined, which
// returned DEFAULT_TTL (3600s = 1 hour). This silently RESET the key's expiry
// every time you patched its value without specifying a TTL — losing the original
// expiry. Fix: fetch the existing TTL first and preserve it when no new TTL is given.
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/:key', writeLimiter, async (req, res) => {
    const { ttl, value, tags } = req.body;
    const fullKey = nsKey(req.namespace, req.params.key);

    try {
        // Fetch existence and current TTL in one round-trip
        const [exists, currentTTL] = await Promise.all([
            client.exists(fullKey),
            client.ttl(fullKey),
        ]);
        if (!exists) return res.status(404).json({ error: 'Key not found' });

        const updates = {};
        if (value !== undefined) {
            const serialized = serialize(value, tags);
            const sizeErr = validateValueSize(serialized);
            if (sizeErr) return res.status(413).json({ error: sizeErr });

            // BUG FIX: preserve original TTL when caller doesn't specify a new one.
            // currentTTL > 0 means the key has an expiry set; -1 means no expiry.
            const safeTTL = ttl !== undefined
                ? sanitizeTTL(ttl)
                : (currentTTL > 0 ? currentTTL : config.DEFAULT_TTL);

            await client.setEx(fullKey, safeTTL, serialized);
            updates.value = true;
            updates.ttl = safeTTL;
            updates.ttlPreserved = ttl === undefined && currentTTL > 0;
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

module.exports = router;
