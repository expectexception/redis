# High-End Redis Caching Server API

This is a production-ready Caching Server API built with Node.js, Express, and Redis. It provides a secure, RESTful HTTP interface over a Redis database, allowing you to easily cache and retrieve data from any of your projects globally.

## Features
- **Global Access**: Connects to Redis and exposes it over HTTP, so you can use it from Frontend (Next.js/React), Backend, or Edge functions.
- **Secure**: Protected by an `API_KEY` via Bearer token authentication.
- **Flexible Data**: Supports caching Strings and JSON objects seamlessly.
- **TTL Support**: Built-in support for time-to-live (expiration) on cache keys.
- **Infrastructure as Code**: Includes `render.yaml` and `Dockerfile` for instantaneous 1-click deployment to Render.

## How to Deploy on Render

1. Push this folder to a GitHub repository.
2. Go to [Render Dashboard](https://dashboard.render.com).
3. Click **New** -> **Blueprint**.
4. Connect your GitHub repository.
5. Render will read the `render.yaml` file and automatically deploy TWO services:
   - A managed **Redis Database**.
   - Your **Caching API Server** (Dockerized).
6. Once deployed, find your generated `API_KEY` in the Environment Variables tab of your web service on Render.

## Local Setup

If you want to run this locally:

1. Install Redis locally or run via Docker: `docker run -d -p 6379:6379 redis`
2. Run `npm install`
3. Copy `.env.example` to `.env` and set your `API_KEY` and `REDIS_URL`
4. Run `node index.js`

## API Usage Example

All routes under `/api/*` require the `Authorization` header.

**1. Save Data to Cache**
```bash
curl -X POST https://your-render-app-url.onrender.com/api/cache \
  -H "Authorization: Bearer your-super-secret-api-key-here" \
  -H "Content-Type: application/json" \
  -d '{
    "key": "user_profile_123",
    "value": { "name": "John", "role": "admin" },
    "ttl": 3600
  }'
```

**2. Retrieve Data from Cache**
```bash
curl -X GET https://your-render-app-url.onrender.com/api/cache/user_profile_123 \
  -H "Authorization: Bearer your-super-secret-api-key-here"
```

**3. Delete Cache Key**
```bash
curl -X DELETE https://your-render-app-url.onrender.com/api/cache/user_profile_123 \
  -H "Authorization: Bearer your-super-secret-api-key-here"
```

**4. Check Server Health**
```bash
curl -X GET https://your-render-app-url.onrender.com/health
```
