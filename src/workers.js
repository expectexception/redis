const { client, isReady } = require('./redis-client');
const config = require('./config');

let intervals = [];

/**
 * Background workers that run alongside the server.
 * All workers are interval-based — no separate processes needed.
 */
function startWorkers() {
    console.log(`🔧 Starting background workers (pid ${process.pid})`);

    // ── Worker 1: Stats Aggregator ──────────────────────────────────

    // Collects server metrics every 30s for monitoring
    const statsWorker = setInterval(async () => {
        if (!isReady()) return;
        try {
            const memInfo = await client.info('memory');
            const usedMatch = memInfo.match(/used_memory_human:(.+)/);
            const peakMatch = memInfo.match(/used_memory_peak_human:(.+)/);
            const fragMatch = memInfo.match(/mem_fragmentation_ratio:(.+)/);

            const snapshot = {
                ts: Date.now(),
                pid: process.pid,
                rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
                redisUsed: usedMatch ? usedMatch[1].trim() : 'unknown',
                redisPeak: peakMatch ? peakMatch[1].trim() : 'unknown',
                fragRatio: fragMatch ? parseFloat(fragMatch[1]) : 0,
                dbSize: await client.dbSize(),
            };

            // Store rolling stats in Redis itself (last 100 snapshots)
            const statsKey = '__system::stats_snapshots';
            await client.lPush(statsKey, JSON.stringify(snapshot));
            await client.lTrim(statsKey, 0, 99);
            await client.expire(statsKey, 86400); // 24h TTL on stats
        } catch (err) {
            console.error('Stats worker error:', err.message);
        }
    }, config.WORKER_STATS_INTERVAL_MS);
    intervals.push(statsWorker);

    // ── Worker 2: Memory Watchdog ───────────────────────────────────
    // Warns if Node.js or Redis memory is getting high
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
                    if (typeof client.memoryPurge === 'function') {
                        await client.memoryPurge();
                        console.log('🧹 Triggered MEMORY PURGE to reduce fragmentation');
                    }
                } catch (e) {
                    console.error('Failed to trigger MEMORY PURGE:', e.message);
                }
            }

            // Check eviction stats
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
    // Cleans up tag indexes that point to expired keys
    const tagCleanerWorker = setInterval(async () => {
        if (!isReady()) return;
        try {
            let cleaned = 0;
            for await (const scanResult of client.scanIterator({ MATCH: '*::__tag:*', COUNT: 100 })) {
                const tagKeys = Array.isArray(scanResult) ? scanResult : [scanResult];
                
                for (const tagKey of tagKeys) {
                    const members = await client.sMembers(tagKey);
                    if (members.length === 0) {
                        await client.del(tagKey);
                        cleaned++;
                        continue;
                    }

                    // Check which tagged keys still exist
                    const pipeline = client.multi();
                    for (const m of members) {
                        pipeline.exists(m);
                    }
                    const results = await pipeline.exec();

                    const toRemove = [];
                    members.forEach((m, i) => {
                        if (results[i] === 0) toRemove.push(m);
                    });

                    if (toRemove.length > 0) {
                        await client.sRem(tagKey, toRemove);
                        cleaned += toRemove.length;
                    }

                    // If tag set is now empty, delete it
                    const remaining = await client.sCard(tagKey);
                    if (remaining === 0) await client.del(tagKey);
                }
            }

            if (cleaned > 0) {
                console.log(`🧹 Tag cleaner: removed ${cleaned} stale tag references`);
            }
        } catch (err) {
            console.error('Tag cleaner worker error:', err.message);
        }
    }, config.WORKER_EVICTION_CHECK_MS);
    intervals.push(tagCleanerWorker);

    // ── Worker 4: Render Auto-Wake ──────────────────────────────────
    // Pings its own URL every 14 minutes to prevent Render free tier from sleeping
    if (config.RENDER_EXTERNAL_URL) {
        const pingInterval = setInterval(() => {
            const proto = config.RENDER_EXTERNAL_URL.startsWith('https') ? require('https') : require('http');
            const url = config.RENDER_EXTERNAL_URL.endsWith('/') ? config.RENDER_EXTERNAL_URL + 'health' : config.RENDER_EXTERNAL_URL + '/health';
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

    console.log('✅ All background workers started');
}

function stopWorkers() {
    intervals.forEach(clearInterval);
    intervals = [];
    console.log('⏹️  All background workers stopped');
}

module.exports = { startWorkers, stopWorkers };
