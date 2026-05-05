const { client, isReady } = require('./redis-client');
const config = require('./config');

let intervals = [];

const cluster = require('cluster');

/**
 * Background workers that run alongside the server.
 * All workers are interval-based — no separate processes needed.
 */
function startWorkers() {
    // Only run maintenance workers (Stats, Memory, Tag Cleaner) in the PRIMARY worker
    // to avoid redundant load and log noise in clustered environments.
    const isPrimary = !cluster.isWorker || cluster.worker.id === 1;
    
    if (!isPrimary) {
        console.log(`🔧 Worker ${process.pid} skipping background maintenance (not primary)`);
        
        // Non-primary workers still run Auto-Wake if needed (or we can move it to primary only)
        startAutoWake();
        return;
    }

    console.log(`🔧 Starting PRIMARY background workers (pid ${process.pid})`);

    // ── Worker 1: Stats Aggregator ──────────────────────────────────
    const statsWorker = setInterval(async () => {
        if (!isReady()) return;
        try {
            const memInfo = await client.info('memory');
            const usedMatch = memInfo.match(/used_memory_human:(.+)/);
            const peakMatch = memInfo.match(/used_memory_peak_human:(.+)/);
            const fragMatch = memInfo.match(/mem_fragmentation_ratio:([\d.]+)/);

            const snapshot = {
                ts: Date.now(),
                pid: process.pid,
                rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
                redisUsed: usedMatch ? usedMatch[1].trim() : 'unknown',
                redisPeak: peakMatch ? peakMatch[1].trim() : 'unknown',
                fragRatio: fragMatch ? parseFloat(fragMatch[1]) : 0,
                dbSize: await client.dbSize(),
            };

            const statsKey = '__system::stats_snapshots';
            const pipeline = client.multi();
            pipeline.lPush(statsKey, JSON.stringify(snapshot));
            pipeline.lTrim(statsKey, 0, 99);
            pipeline.expire(statsKey, 86400);
            await pipeline.exec();
        } catch (err) {
            console.error('Stats worker error:', err.message);
        }
    }, config.WORKER_STATS_INTERVAL_MS);
    intervals.push(statsWorker);

    // ── Worker 2: Memory Watchdog + Defrag ──────────────────────────
    const memoryWorker = setInterval(async () => {
        const rss = process.memoryUsage().rss / 1024 / 1024;
        if (rss > config.WORKER_MEMORY_WARN_MB) {
            console.warn(`⚠️  HIGH MEMORY: Node.js RSS = ${Math.round(rss)}MB (threshold: ${config.WORKER_MEMORY_WARN_MB}MB)`);
        }

        if (!isReady()) return;
        try {
            const memInfo = await client.info('memory');
            const fragMatch = memInfo.match(/mem_fragmentation_ratio:([\d.]+)/);
            const frag = fragMatch ? parseFloat(fragMatch[1]) : 1;

            if (frag > 1.5) {
                console.warn(`⚠️  Redis memory fragmentation high: ${frag.toFixed(2)} (>1.5 = wasteful)`);
                try {
                    // 1. Trigger JEMALLOC purge
                    await client.sendCommand(['MEMORY', 'PURGE']);
                    console.log('🧹 Triggered MEMORY PURGE');

                    // 2. If fragmentation is severe (>2.0), try enabling active defrag if it's off
                    if (frag > 2.0) {
                        try {
                            const configRes = await client.configGet('activedefrag');
                            if (configRes && configRes.activedefrag === 'no') {
                                console.log('🚀 Severe fragmentation: enabling active-defrag...');
                                await client.configSet('activedefrag', 'yes');
                            }
                        } catch { /* config command often restricted on managed Redis */ }
                    }
                } catch (e) {
                    console.error('Failed to mitigate fragmentation:', e.message);
                }
            }

            const statsInfo = await client.info('stats');
            const evictedMatch = statsInfo.match(/evicted_keys:(\d+)/);
            if (evictedMatch && parseInt(evictedMatch[1]) > 0) {
                console.warn(`⚠️  Redis has evicted ${evictedMatch[1]} keys — consider upgrading Redis plan`);
            }
        } catch (err) {
            console.error('Memory worker error:', err.message);
        }
    }, config.WORKER_MEMORY_CHECK_MS);
    intervals.push(memoryWorker);

    // ── Worker 3: Stale Tag Cleaner ─────────────────────────────────
    // Cleans up tag indexes that point to expired keys.
    //
    // BUG FIX: scanIterator behavior varies by version. It may yield individual 
    // strings OR arrays of strings (especially in newer or specific environments).
    // The code now robustly handles both cases and filters empty results.
    //
    // PERF: Batch tag-sets in groups of TAG_BATCH before processing, so we're
    // not context-switching for every single tag key in large keyspaces.
    const tagCleanerWorker = setInterval(async () => {
        if (!isReady()) return;
        try {
            let cleaned = 0;
            const TAG_BATCH = 50;
            let tagBatch = [];

            const flushBatch = async () => {
                if (tagBatch.length === 0) return;

                for (const tagKey of tagBatch) {
                    const members = await client.sMembers(tagKey);
                    if (members.length === 0) {
                        await client.del(tagKey);
                        cleaned++;
                        continue;
                    }

                    // Pipeline all EXISTS checks for this tag's members at once
                    const pipeline = client.multi();
                    for (const m of members) pipeline.exists(m);
                    const results = await pipeline.exec();

                    const toRemove = members.filter((_, i) => results[i] === 0);

                    if (toRemove.length > 0) {
                        await client.sRem(tagKey, toRemove);
                        cleaned += toRemove.length;
                    }

                    // Delete the tag set itself if now empty
                    const remaining = await client.sCard(tagKey);
                    if (remaining === 0) await client.del(tagKey);
                }

                tagBatch = [];
            };

            for await (const result of client.scanIterator({ MATCH: '*::__tag:*', COUNT: 100 })) {
                const keys = Array.isArray(result) ? result : [result];
                for (const key of keys) {
                    if (key) {
                        tagBatch.push(key);
                        if (tagBatch.length >= TAG_BATCH) await flushBatch();
                    }
                }
            }
            await flushBatch(); // flush any remainder

            if (cleaned > 0) {
                console.log(`🧹 Tag cleaner: removed ${cleaned} stale tag references`);
            }
        } catch (err) {
            console.error('Tag cleaner worker error:', err.stack);
        }
    }, config.WORKER_EVICTION_CHECK_MS);
    intervals.push(tagCleanerWorker);

    startAutoWake();

    console.log('✅ All background workers started');
}

/**
 * Pings its own URL every 14 minutes to prevent Render free tier from sleeping.
 * This runs on ALL workers to ensure at least one is always up.
 */
function startAutoWake() {
    if (!config.RENDER_EXTERNAL_URL) return;

    const pingInterval = setInterval(() => {
        const proto = config.RENDER_EXTERNAL_URL.startsWith('https') ? require('https') : require('http');
        const url = config.RENDER_EXTERNAL_URL.endsWith('/')
            ? config.RENDER_EXTERNAL_URL + 'health'
            : config.RENDER_EXTERNAL_URL + '/health';
        proto.get(url, (res) => {
            if (res.statusCode === 200) {
                console.log(`⏰ Auto-wake ping successful: ${url}`);
            }
        }).on('error', (err) => {
            console.error(`Auto-wake ping failed: ${err.message}`);
        });
    }, 14 * 60 * 1000); // 14 minutes
    intervals.push(pingInterval);
}

function stopWorkers() {
    intervals.forEach(clearInterval);
    intervals = [];
    console.log('⏹️  All background workers stopped');
}

module.exports = { startWorkers, stopWorkers };
