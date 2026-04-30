/**
 * Redis Cache Client SDK v2.1
 * Universal — works Node.js, browser, Deno, Bun, edge workers.
 */

const DEFAULTS = { timeout: 10000, retries: 2, retryDelay: 500 };

function createCacheClient({ url, apiKey, namespace = 'default', timeout, retries, retryDelay } = {}) {
    if (!url) throw new Error('CacheClient: url required');
    if (!apiKey) throw new Error('CacheClient: apiKey required');

    const baseUrl = url.replace(/\/$/, '');
    const opts = { timeout: timeout || DEFAULTS.timeout, retries: retries ?? DEFAULTS.retries, retryDelay: retryDelay || DEFAULTS.retryDelay };

    async function request(path, options = {}, attempt = 0) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), opts.timeout);

        try {
            const res = await fetch(`${baseUrl}${path}`, {
                ...options,
                signal: controller.signal,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                    'X-Namespace': namespace,
                    ...options.headers,
                },
            });

            const data = await res.json();
            if (!res.ok) {
                const err = new Error(data.error || data.message || `HTTP ${res.status}`);
                err.status = res.status;
                err.data = data;
                throw err;
            }
            return data;
        } catch (err) {
            if (err.name === 'AbortError') err.message = `Request timeout after ${opts.timeout}ms`;

            // Retry on network/5xx errors, not on 4xx
            const retryable = !err.status || err.status >= 500;
            if (retryable && attempt < opts.retries) {
                await new Promise(r => setTimeout(r, opts.retryDelay * (attempt + 1)));
                return request(path, options, attempt + 1);
            }
            throw err;
        } finally {
            clearTimeout(timer);
        }
    }

    const post = (path, body) => request(path, { method: 'POST', body: JSON.stringify(body) });

    return {
        // ─── Key/Value ───────────────────────────────
        async set(key, value, { ttl, tags } = {}) { return post('/api/cache', { key, value, ttl, tags }); },

        async get(key) {
            try { return (await request(`/api/cache/${encodeURIComponent(key)}`)).value; }
            catch (e) { if (e.status === 404) return null; throw e; }
        },

        async getWithMeta(key) {
            try { return await request(`/api/cache/${encodeURIComponent(key)}`); }
            catch (e) { if (e.status === 404) return null; throw e; }
        },

        async del(key) { return request(`/api/cache/${encodeURIComponent(key)}`, { method: 'DELETE' }); },

        async patch(key, { ttl, value, tags } = {}) {
            return request(`/api/cache/${encodeURIComponent(key)}`, { method: 'PATCH', body: JSON.stringify({ ttl, value, tags }) });
        },

        // ─── Batch ───────────────────────────────────
        async setMany(entries, { ttl } = {}) { return post('/api/cache/batch', { entries, ttl }); },

        async getMany(keys) {
            return (await request(`/api/cache/batch?keys=${keys.map(encodeURIComponent).join(',')}`)).result;
        },

        // ─── Pattern/Tags ────────────────────────────
        async keys(pattern = '*', limit = 100) {
            return (await request(`/api/cache/keys?pattern=${encodeURIComponent(pattern)}&limit=${limit}`)).keys;
        },

        async invalidate({ pattern, tags } = {}) { return post('/api/cache/invalidate', { pattern, tags }); },

        // ─── Atomic ──────────────────────────────────
        async incr(key, amount = 1) { return post('/api/cache/incr', { key, amount }); },
        async decr(key, amount = 1) { return post('/api/cache/incr', { key, amount: -amount }); },

        // ─── Cache-aside ─────────────────────────────
        async computeOrFetch(key, computeFn, { ttl, tags } = {}) {
            const data = await post('/api/cache/compute', { key });
            if (data.hit) return data.value;
            const value = await computeFn();
            await this.set(key, value, { ttl, tags });
            return value;
        },

        // ─── Hash ────────────────────────────────────
        async hSet(key, fields, { ttl } = {}) { return post('/api/cache/hash', { key, op: 'set', fields, ttl }); },
        async hGet(key, field) { return (await post('/api/cache/hash', { key, op: 'get', field })).value; },
        async hGetAll(key) { return (await post('/api/cache/hash', { key, op: 'get' })).value; },
        async hDel(key, fields) { return post('/api/cache/hash', { key, op: 'del', fields: Array.isArray(fields) ? fields : [fields] }); },

        // ─── List ────────────────────────────────────
        async lPush(key, values, { ttl } = {}) { return post('/api/cache/list', { key, op: 'lpush', values: Array.isArray(values) ? values : [values], ttl }); },
        async rPush(key, values, { ttl } = {}) { return post('/api/cache/list', { key, op: 'rpush', values: Array.isArray(values) ? values : [values], ttl }); },
        async lPop(key) { return (await post('/api/cache/list', { key, op: 'lpop' })).value; },
        async rPop(key) { return (await post('/api/cache/list', { key, op: 'rpop' })).value; },
        async lRange(key, start = 0, stop = -1) { return (await post('/api/cache/list', { key, op: 'range', start, stop })).values; },
        async lLen(key) { return (await post('/api/cache/list', { key, op: 'len' })).length; },

        // ─── Set ─────────────────────────────────────
        async sAdd(key, values, { ttl } = {}) { return post('/api/cache/set', { key, op: 'add', values: Array.isArray(values) ? values : [values], ttl }); },
        async sRem(key, values) { return post('/api/cache/set', { key, op: 'remove', values: Array.isArray(values) ? values : [values] }); },
        async sMembers(key) { return (await post('/api/cache/set', { key, op: 'members' })).members; },
        async sIsMember(key, value) { return (await post('/api/cache/set', { key, op: 'ismember', value })).isMember; },
        async sSize(key) { return (await post('/api/cache/set', { key, op: 'size' })).size; },

        // ─── Admin ───────────────────────────────────
        async flush() { return post('/api/cache/flush', {}); },
        async stats() { return request('/api/cache/stats'); },
        async health() { return (await fetch(`${baseUrl}/health`)).json(); },

        // ─── Utils ───────────────────────────────────
        withNamespace(ns) { return createCacheClient({ url, apiKey, namespace: ns, timeout: opts.timeout, retries: opts.retries, retryDelay: opts.retryDelay }); },
    };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = createCacheClient;
    module.exports.createCacheClient = createCacheClient;
}
if (typeof window !== 'undefined') window.createCacheClient = createCacheClient;
