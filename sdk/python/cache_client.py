"""
Redis Cache Client SDK for Python

Universal client for the Redis Caching Server REST API.
Works with any Python 3.7+ project — Django, Flask, FastAPI, scripts, etc.

Usage:
    from cache_client import CacheClient

    cache = CacheClient(
        url="https://your-app.onrender.com",
        api_key="YOUR_KEY",
        namespace="my-project"
    )

    # Set/Get
    cache.set("user:123", {"name": "Rajat"}, ttl=3600, tags=["users"])
    user = cache.get("user:123")

    # Cache-aside (auto-compute on miss)
    data = cache.compute_or_fetch("expensive:query", lambda: db.query("..."), ttl=300)

Install deps:
    pip install requests
"""

import time
import json
from typing import Any, Optional, List, Dict, Callable, Union
from urllib.parse import quote

try:
    import requests
except ImportError:
    raise ImportError("Install requests: pip install requests")


class CacheError(Exception):
    """Raised on non-2xx responses from cache server."""
    def __init__(self, message: str, status_code: int = 0, data: dict = None):
        super().__init__(message)
        self.status_code = status_code
        self.data = data or {}


class CacheClient:
    """
    Python client for Redis Caching Server.

    Args:
        url: Base URL of the caching server (e.g. https://your-app.onrender.com)
        api_key: API key for authentication
        namespace: Project namespace for key isolation (default: 'default')
        timeout: Request timeout in seconds (default: 10)
        retries: Number of retry attempts on 5xx/network errors (default: 2)
        retry_delay: Base delay between retries in seconds (default: 0.5)
    """

    def __init__(
        self,
        url: str,
        api_key: str,
        namespace: str = "default",
        timeout: int = 10,
        retries: int = 2,
        retry_delay: float = 0.5,
    ):
        if not url:
            raise ValueError("url is required")
        if not api_key:
            raise ValueError("api_key is required")

        self.base_url = url.rstrip("/")
        self.api_key = api_key
        self.namespace = namespace
        self.timeout = timeout
        self.retries = retries
        self.retry_delay = retry_delay

        self._session = requests.Session()
        self._session.headers.update({
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
            "X-Namespace": namespace,
        })

    def _request(self, method: str, path: str, json_data: dict = None, params: dict = None, attempt: int = 0) -> dict:
        """Make HTTP request with retry logic."""
        try:
            resp = self._session.request(
                method=method,
                url=f"{self.base_url}{path}",
                json=json_data,
                params=params,
                timeout=self.timeout,
            )

            data = resp.json()

            if not resp.ok:
                err = CacheError(
                    data.get("error", data.get("message", f"HTTP {resp.status_code}")),
                    status_code=resp.status_code,
                    data=data,
                )
                # Only retry on 5xx
                if resp.status_code >= 500 and attempt < self.retries:
                    time.sleep(self.retry_delay * (attempt + 1))
                    return self._request(method, path, json_data, params, attempt + 1)
                raise err

            return data

        except requests.exceptions.RequestException as e:
            if attempt < self.retries:
                time.sleep(self.retry_delay * (attempt + 1))
                return self._request(method, path, json_data, params, attempt + 1)
            raise CacheError(f"Network error: {e}")

    # ─── Key/Value ────────────────────────────────────────────────────────────

    def set(self, key: str, value: Any, ttl: int = None, tags: List[str] = None) -> dict:
        """Set a cache key."""
        body = {"key": key, "value": value}
        if ttl is not None:
            body["ttl"] = ttl
        if tags:
            body["tags"] = tags
        return self._request("POST", "/api/cache", json_data=body)

    def get(self, key: str) -> Any:
        """Get a cache key value. Returns None if not found."""
        try:
            data = self._request("GET", f"/api/cache/{quote(key, safe='')}")
            return data.get("value")
        except CacheError as e:
            if e.status_code == 404:
                return None
            raise

    def get_with_meta(self, key: str) -> Optional[dict]:
        """Get key with full metadata (value, type, ttl, tags, storedAt)."""
        try:
            return self._request("GET", f"/api/cache/{quote(key, safe='')}")
        except CacheError as e:
            if e.status_code == 404:
                return None
            raise

    def delete(self, key: str) -> dict:
        """Delete a cache key."""
        return self._request("DELETE", f"/api/cache/{quote(key, safe='')}")

    def patch(self, key: str, value: Any = None, ttl: int = None, tags: List[str] = None) -> dict:
        """Update value and/or TTL on existing key."""
        body = {}
        if value is not None:
            body["value"] = value
        if ttl is not None:
            body["ttl"] = ttl
        if tags is not None:
            body["tags"] = tags
        return self._request("PATCH", f"/api/cache/{quote(key, safe='')}", json_data=body)

    # ─── Batch ────────────────────────────────────────────────────────────────

    def set_many(self, entries: List[dict], ttl: int = None) -> dict:
        """
        Batch set multiple keys.
        entries: list of {"key": str, "value": any, "tags"?: list, "ttl"?: int}
        """
        body = {"entries": entries}
        if ttl is not None:
            body["ttl"] = ttl
        return self._request("POST", "/api/cache/batch", json_data=body)

    def get_many(self, keys: List[str]) -> dict:
        """Batch get. Returns dict of key -> {value, type, ttl} or None."""
        data = self._request("GET", "/api/cache/batch", params={"keys": ",".join(keys)})
        return data.get("result", {})

    # ─── Pattern/Tags ─────────────────────────────────────────────────────────

    def keys(self, pattern: str = "*", limit: int = 100) -> List[str]:
        """List keys matching pattern."""
        data = self._request("GET", "/api/cache/keys", params={"pattern": pattern, "limit": limit})
        return data.get("keys", [])

    def invalidate(self, pattern: str = None, tags: List[str] = None) -> dict:
        """Invalidate keys by pattern and/or tags."""
        body = {}
        if pattern:
            body["pattern"] = pattern
        if tags:
            body["tags"] = tags
        return self._request("POST", "/api/cache/invalidate", json_data=body)

    # ─── Atomic ───────────────────────────────────────────────────────────────

    def incr(self, key: str, amount: int = 1) -> int:
        """Atomic increment. Returns new value."""
        data = self._request("POST", "/api/cache/incr", json_data={"key": key, "amount": amount})
        return data.get("value", 0)

    def decr(self, key: str, amount: int = 1) -> int:
        """Atomic decrement. Returns new value."""
        return self.incr(key, -amount)

    # ─── Cache-aside ──────────────────────────────────────────────────────────

    def compute_or_fetch(self, key: str, compute_fn: Callable, ttl: int = None, tags: List[str] = None) -> Any:
        """
        Cache-aside pattern: check cache, if miss compute + store.

        Args:
            key: Cache key
            compute_fn: Callable that returns the value to cache on miss
            ttl: TTL in seconds
            tags: Tags for invalidation
        """
        data = self._request("POST", "/api/cache/compute", json_data={"key": key})
        if data.get("hit"):
            return data.get("value")

        # Cache miss — compute and store
        value = compute_fn()
        self.set(key, value, ttl=ttl, tags=tags)
        return value

    # ─── Hash ─────────────────────────────────────────────────────────────────

    def hset(self, key: str, fields: dict, ttl: int = None) -> dict:
        """Set hash fields. fields = {"field1": value1, "field2": value2}"""
        body = {"key": key, "op": "set", "fields": fields}
        if ttl is not None:
            body["ttl"] = ttl
        return self._request("POST", "/api/cache/hash", json_data=body)

    def hget(self, key: str, field: str = None) -> Any:
        """Get hash field value, or all fields if field=None."""
        body = {"key": key, "op": "get"}
        if field:
            body["field"] = field
        data = self._request("POST", "/api/cache/hash", json_data=body)
        return data.get("value")

    def hgetall(self, key: str) -> dict:
        """Get all hash fields."""
        return self.hget(key)

    def hdel(self, key: str, fields: Union[str, List[str]]) -> dict:
        """Delete hash field(s)."""
        if isinstance(fields, str):
            fields = [fields]
        return self._request("POST", "/api/cache/hash", json_data={"key": key, "op": "del", "fields": fields})

    # ─── List ─────────────────────────────────────────────────────────────────

    def lpush(self, key: str, values: Union[Any, List[Any]], ttl: int = None) -> int:
        """Push to left of list. Returns new length."""
        if not isinstance(values, list):
            values = [values]
        body = {"key": key, "op": "lpush", "values": values}
        if ttl is not None:
            body["ttl"] = ttl
        data = self._request("POST", "/api/cache/list", json_data=body)
        return data.get("length", 0)

    def rpush(self, key: str, values: Union[Any, List[Any]], ttl: int = None) -> int:
        """Push to right of list. Returns new length."""
        if not isinstance(values, list):
            values = [values]
        body = {"key": key, "op": "rpush", "values": values}
        if ttl is not None:
            body["ttl"] = ttl
        data = self._request("POST", "/api/cache/list", json_data=body)
        return data.get("length", 0)

    def lpop(self, key: str) -> Any:
        """Pop from left. Returns value or None."""
        try:
            data = self._request("POST", "/api/cache/list", json_data={"key": key, "op": "lpop"})
            return data.get("value")
        except CacheError as e:
            if e.status_code == 404:
                return None
            raise

    def rpop(self, key: str) -> Any:
        """Pop from right. Returns value or None."""
        try:
            data = self._request("POST", "/api/cache/list", json_data={"key": key, "op": "rpop"})
            return data.get("value")
        except CacheError as e:
            if e.status_code == 404:
                return None
            raise

    def lrange(self, key: str, start: int = 0, stop: int = -1) -> List[Any]:
        """Get list slice."""
        data = self._request("POST", "/api/cache/list", json_data={"key": key, "op": "range", "start": start, "stop": stop})
        return data.get("values", [])

    def llen(self, key: str) -> int:
        """Get list length."""
        data = self._request("POST", "/api/cache/list", json_data={"key": key, "op": "len"})
        return data.get("length", 0)

    # ─── Set ──────────────────────────────────────────────────────────────────

    def sadd(self, key: str, values: Union[Any, List[Any]], ttl: int = None) -> int:
        """Add to set. Returns count added."""
        if not isinstance(values, list):
            values = [values]
        body = {"key": key, "op": "add", "values": values}
        if ttl is not None:
            body["ttl"] = ttl
        data = self._request("POST", "/api/cache/set", json_data=body)
        return data.get("added", 0)

    def srem(self, key: str, values: Union[Any, List[Any]]) -> int:
        """Remove from set. Returns count removed."""
        if not isinstance(values, list):
            values = [values]
        data = self._request("POST", "/api/cache/set", json_data={"key": key, "op": "remove", "values": values})
        return data.get("removed", 0)

    def smembers(self, key: str) -> List[Any]:
        """Get all set members."""
        data = self._request("POST", "/api/cache/set", json_data={"key": key, "op": "members"})
        return data.get("members", [])

    def sismember(self, key: str, value: Any) -> bool:
        """Check set membership."""
        data = self._request("POST", "/api/cache/set", json_data={"key": key, "op": "ismember", "value": value})
        return data.get("isMember", False)

    def ssize(self, key: str) -> int:
        """Get set size."""
        data = self._request("POST", "/api/cache/set", json_data={"key": key, "op": "size"})
        return data.get("size", 0)

    # ─── Admin ────────────────────────────────────────────────────────────────

    def flush(self) -> dict:
        """Flush all keys in this namespace."""
        return self._request("POST", "/api/cache/flush")

    def stats(self) -> dict:
        """Get cache stats."""
        return self._request("GET", "/api/cache/stats")

    def health(self) -> dict:
        """Health check (no auth needed)."""
        resp = requests.get(f"{self.base_url}/health", timeout=self.timeout)
        return resp.json()

    # ─── Utils ────────────────────────────────────────────────────────────────

    def with_namespace(self, namespace: str) -> "CacheClient":
        """Create new client pointing to different namespace."""
        return CacheClient(
            url=self.base_url,
            api_key=self.api_key,
            namespace=namespace,
            timeout=self.timeout,
            retries=self.retries,
            retry_delay=self.retry_delay,
        )

    def close(self):
        """Close the underlying HTTP session."""
        self._session.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    def __repr__(self):
        return f"CacheClient(url={self.base_url!r}, namespace={self.namespace!r})"
