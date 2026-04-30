# ⚡ Redis Caching Server v2.1

Language-agnostic caching service. Deploy once, use from **any** project in **any** language via REST API. Includes ready-made SDKs for JavaScript and Python.

## Quick Start

```bash
# 1. Clone & install
npm install

# 2. Set env (or copy .env.example to .env)
export REDIS_URL=redis://localhost:6379
export API_KEY=your-secret-key

# 3. Run
npm start
```

## SDKs

| Language | File | Install |
|----------|------|---------|
| **JavaScript** (Node/Browser/Deno) | `sdk/cache-client.js` | Copy or `require()` |
| **Python** (Django/Flask/FastAPI) | `sdk/python/cache_client.py` | `pip install requests` then copy, or `pip install -e sdk/python` |
| **Any language** | `sdk/REST_API.md` | cURL/Go/PHP/Ruby/Java examples |

### Python
```python
from cache_client import CacheClient
cache = CacheClient(url="https://your-app.onrender.com", api_key="KEY", namespace="my-project")
cache.set("user:123", {"name": "Rajat"}, ttl=3600, tags=["users"])
user = cache.get("user:123")
```

### JavaScript
```javascript
const createCacheClient = require('./sdk/cache-client');
const cache = createCacheClient({ url: 'https://your-app.onrender.com', apiKey: 'KEY', namespace: 'my-project' });
await cache.set('user:123', { name: 'Rajat' }, { ttl: 3600, tags: ['users'] });
const user = await cache.get('user:123');
```

### cURL (any language)
```bash
curl -X POST https://your-app.onrender.com/api/cache \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "X-Namespace: my-project" \
  -H "Content-Type: application/json" \
  -d '{"key":"user:123","value":{"name":"Rajat"},"ttl":3600}'
```

## Features

- **Namespace isolation** — each project gets own keyspace, no collisions
- **All data types** — string, number, boolean, null, Date, Buffer, object, array
- **Data structures** — Hash, List, Set via REST endpoints
- **Tag-based invalidation** — tag keys, bulk invalidate by tag
- **Batch ops** — up to 500 keys per request, pipelined to Redis
- **Atomic counters** — incr/decr for views, stock, rate tracking
- **Cache-aside** — compute-or-fetch pattern built in
- **Background workers** — stats aggregator, memory watchdog, stale tag cleaner
- **Auto-wake mechanism** — pings itself to prevent Render free-tier from sleeping
- **Request tracing** — X-Request-Id on every response
- **Multi-core clustering** — auto-forks in production on multi-CPU machines

## Architecture

```
server.js                    # entry point + cluster manager
src/
├── config.js                # centralized config
├── redis-client.js           # singleton + reconnect
├── helpers.js                # namespace keys, v2 serializer, validation
├── workers.js                # background workers (stats, memory, tags)
├── middleware/
│   ├── auth.js               # API key + namespace extraction
│   ├── redis-guard.js        # 503 when Redis down
│   └── rate-limiter.js       # read/write rate limits
└── routes/
    ├── cache.js              # all cache endpoints
    └── health.js             # health + latency check
sdk/
├── cache-client.js           # JavaScript SDK
├── REST_API.md               # Generic REST reference (cURL/Go/PHP/Ruby/Java)
└── python/
    ├── cache_client.py       # Python SDK
    ├── setup.py              # pip installable
    └── README.md             # Python usage docs
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check (public) |
| POST | `/api/cache` | Set key |
| GET | `/api/cache/:key` | Get key |
| DELETE | `/api/cache/:key` | Delete key |
| PATCH | `/api/cache/:key` | Update value/TTL |
| POST | `/api/cache/batch` | Batch set |
| GET | `/api/cache/batch?keys=a,b` | Batch get |
| GET | `/api/cache/keys?pattern=*` | List keys |
| POST | `/api/cache/invalidate` | Delete by pattern/tags |
| POST | `/api/cache/compute` | Cache-aside check |
| POST | `/api/cache/incr` | Atomic increment |
| POST | `/api/cache/hash` | Hash ops |
| POST | `/api/cache/list` | List ops |
| POST | `/api/cache/set` | Set ops |
| POST | `/api/cache/flush` | Flush namespace |
| GET | `/api/cache/stats` | Stats |

## Deploy on Render

1. Push to GitHub
2. Dashboard → New → Blueprint → select repo
3. Render auto-creates Redis + API server
4. Copy `API_KEY` from Environment tab
