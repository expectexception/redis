# ⚡ Redis Caching Server v3.0

High-performance, language-agnostic caching service. Deploy once, use from **any** project in **any** language via REST API. Engineered for reliability, isolation, and scale.

## 🚀 Quick Start

```bash
# 1. Clone & install
npm install

# 2. Configure environment
# Copy .env.example to .env and set your secrets
export REDIS_URL=redis://localhost:6379
export API_KEY=your-secret-key

# 3. Run
npm start
```

## 📦 SDKs

| Language | Client SDK | Best For |
|----------|------------|----------|
| **JavaScript** | [`sdk/cache-client.js`](sdk/cache-client.js) | Node.js, Browser, Deno, Bun, Edge |
| **Python** | [`sdk/python/cache_client.py`](sdk/python/cache_client.py) | Django, Flask, FastAPI (Sync + Async) |
| **Any Language** | [`sdk/REST_API.md`](sdk/REST_API.md) | Go, Rust, PHP, Ruby, Java, C# |

---

## 💎 Premium Features

### 🛡️ Namespace Isolation
Multi-tenant ready. Each project uses an `X-Namespace` header to keep its keyspace completely isolated. No key collisions, ever.

### 🛡️ Stampede Protection (Compute-or-Fetch)
Built-in distributed locking. When multiple clients miss the cache simultaneously, only **one** wins the lock to compute the value. Others wait and retry automatically, preventing "cache stampedes" on heavy computations.

### 🏷️ Tag-Based Invalidation
Assign tags to keys (e.g., `user:123` tagged with `users`). Invalidate thousands of keys at once by tag without expensive pattern scans.

### 🧩 Rich Data Structures
Go beyond simple strings. Full REST support for:
- **Hashes**: Field-level updates and retrieval.
- **Lists**: Pushes, pops, and ranges.
- **Sets**: Unique collections, membership checks, and sizes.

### ⚡ Performance & Reliability
- **Pipelined Batching**: Fetch or set up to 500 keys in a single network round-trip.
- **Type Safety**: Preserves exact JS/Python types (Date, Buffer, Boolean, etc.) through serialization.
- **Maintenance Workers**: Background agents for stats, memory defragmentation (`MEMORY PURGE`), and stale tag cleanup.
- **Cluster Support**: Scales across multiple CPU cores automatically.

---

## 🛠️ SDK Usage Examples

### Python (FastAPI / Async)
```python
from cache_client import AsyncCacheClient

# Open connection pool on startup
cache = AsyncCacheClient(url="...", api_key="...", namespace="v1")
await cache.open()

# Smart Compute (with stampede protection)
async def get_expensive_report():
    return await cache.compute_or_fetch(
        "report:2024", 
        compute_fn=lambda: db.run_heavy_query(),
        ttl=3600
    )
```

### JavaScript (Node.js)
```javascript
const cache = require('./sdk/cache-client')({ url: '...', apiKey: '...' });

// Tagged storage
await cache.set('profile:123', { name: 'Rajat' }, { tags: ['users', 'vip'] });

// Atomic Invalidation
await cache.invalidate({ tags: ['users'] });
```

---

## 🏗️ Architecture

```text
src/
├── config.js          # Centralized configuration
├── redis-client.js    # Optimized Redis connector
├── helpers.js         # v2 Type-safe serializer + NS builder
├── workers.js         # Background maintenance agents
├── middleware/        # Security, Auth, Rate Limiting
└── routes/            # REST API Implementation
```

## 📡 API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Liveness & Latency |
| `POST` | `/api/cache` | Set key (with TTL & Tags) |
| `GET` | `/api/cache/:key` | Get key value + metadata |
| `PATCH` | `/api/cache/:key` | Update value/TTL (Preserves expiry) |
| `POST` | `/api/cache/compute` | Acquire lock for computation |
| `POST` | `/api/cache/batch` | Atomic Multi-SET |
| `GET` | `/api/cache/stats` | Real-time Redis & OS metrics |

---

## ☁️ Deployment

Deploy to **Render** in seconds via `render.yaml`:
1. Push to GitHub.
2. Dashboard → New → Blueprint.
3. Done.

---
**v3.0.0** • High-Performance Caching Standard
