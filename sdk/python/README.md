# Redis Cache Client — Python SDK

## Install

```bash
pip install requests
```

Then copy `cache_client.py` into your project, or install directly:

```bash
pip install -e /path/to/redis-caching-server/sdk/python
```

## Usage

```python
from cache_client import CacheClient

cache = CacheClient(
    url="https://your-app.onrender.com",
    api_key="YOUR_KEY",
    namespace="my-project",
)

# Key/Value
cache.set("user:123", {"name": "Rajat", "premium": True}, ttl=3600, tags=["users"])
user = cache.get("user:123")  # {"name": "Rajat", "premium": True}

# Batch
cache.set_many([
    {"key": "a", "value": 1},
    {"key": "b", "value": {"nested": True}},
], ttl=600)
result = cache.get_many(["a", "b"])

# Atomic counter
cache.incr("page:views")
cache.decr("stock:item1", 5)

# Hash (like a dict)
cache.hset("session:abc", {"userId": 123, "role": "admin"}, ttl=1800)
session = cache.hgetall("session:abc")

# List (queue)
cache.rpush("jobs:pending", {"task": "send-email", "to": "user@mail.com"})
job = cache.lpop("jobs:pending")

# Set (unique collection)
cache.sadd("online:users", ["user1", "user2"])
is_online = cache.sismember("online:users", "user1")

# Cache-aside (auto-compute on miss)
data = cache.compute_or_fetch(
    "expensive:query",
    lambda: db.query("SELECT * FROM big_table"),
    ttl=300,
    tags=["queries"]
)

# Invalidate by tags
cache.invalidate(tags=["users"])

# Switch namespace
other = cache.with_namespace("other-project")
other.set("key", "value")

# Context manager
with CacheClient(url="...", api_key="...") as c:
    c.set("temp", "data")
```
