# ⚡ Ultimate Redis Caching API (High-End)

A production-ready, ultra-fast Caching Server that wraps Redis in a secure REST API. Designed to be deployed on Render and used as a global caching layer for all your projects (Frontend, Backend, Edge, or Mobile).

## 🚀 Key Features
- **Global Access**: Connect to your cache from anywhere via simple HTTP calls.
- **High Performance**: Built-in Gzip compression, multi-core clustering, and Redis pipelining.
- **Secure**: Protected by API Key authentication (Bearer token or X-API-Key).
- **Safe Load Handling**: Automatic rate-limiting (300 req/min) to prevent abuse.
- **Batch Operations**: Save or retrieve up to 100 keys in a single request for maximum speed.
- **Auto-Cleanup**: Enforced TTL (Time-to-Live) support to keep your memory clean.

---

## 🛠️ Deployment Instructions (Render)

1. **Push to GitHub**: If you haven't already, push this folder to your GitHub account.
2. **Deploy Blueprint**:
   - Go to your [Render Dashboard](https://dashboard.render.com).
   - Click **New** -> **Blueprint**.
   - Select your repository.
3. **Wait for Setup**: Render will automatically create:
   - A managed **Redis Instance** (Private).
   - A **Docker Web Service** (Public API).
4. **Get your API Key**:
   - Once live, go to your **Web Service** -> **Environment** tab.
   - Copy the value of `API_KEY`.

---

## 📡 API Documentation

All routes (except `/health`) require the `Authorization: Bearer <YOUR_API_KEY>` header.

### 1. Set a Cache Value
`POST /api/cache`
```json
{
  "key": "user_123",
  "value": { "name": "Rajat", "premium": true },
  "ttl": 3600 
}
```
*Note: `ttl` is in seconds (default 3600).*

### 2. Get a Cache Value
`GET /api/cache/:key`
Returns the value (auto-parses JSON) and the remaining TTL.

### 3. Batch Set (Fastest for multiple keys)
`POST /api/cache/batch`
```json
{
  "entries": [
    { "key": "a", "value": 1 },
    { "key": "b", "value": 2 }
  ],
  "ttl": 600
}
```

### 4. Batch Get
`GET /api/cache/batch?keys=key1,key2,key3`

### 5. Update TTL
`PUT /api/cache/:key/ttl`
```json
{ "ttl": 7200 }
```

### 6. Stats & Health
- `GET /health`: Check server and Redis status (Public).
- `GET /api/cache/stats`: Detailed Redis memory and performance stats (Protected).

---

## 💻 Usage Examples

### 1. Node.js (Fetch)
```javascript
const response = await fetch('https://your-app.onrender.com/api/cache/my_key', {
  headers: { 'Authorization': 'Bearer YOUR_API_KEY' }
});
const data = await response.json();
console.log(data.value);
```

### 2. Python (Requests)
```python
import requests

url = "https://your-app.onrender.com/api/cache"
headers = {"Authorization": "Bearer YOUR_API_KEY"}
data = {"key": "score", "value": 100, "ttl": 300}

requests.post(url, json=data, headers=headers)
```

### 3. cURL
```bash
curl -H "Authorization: Bearer YOUR_API_KEY" https://your-app.onrender.com/api/cache/my_key
```

---

## 🛡️ Best Practices
1. **Always use TTL**: Don't store data forever. Use `ttl` to keep your Redis instance lean and fast.
2. **Use Batching**: If you need to fetch/save more than 2 keys, use the `/batch` endpoints. It reduces network latency significantly.
3. **Keep Keys Short**: Use colon-separated namespacing (e.g., `prod:users:123`) for better organization.
4. **1MB Limit**: This server rejects single values larger than 1MB to ensure high performance.

## 📝 License
ISC - Use it for any project you want!
