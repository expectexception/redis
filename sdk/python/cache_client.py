"""
Redis Cache Client SDK for Python v3.0

Universal client for the Redis Caching Server REST API.
Works with any Python 3.7+ project — Django, Flask, FastAPI, scripts, etc.

Two client classes are provided:
  - CacheClient      — synchronous (uses `requests`), for Django/Flask/scripts
  - AsyncCacheClient — async/await  (uses `httpx`),   for FastAPI/async Django

Usage (sync):
    from cache_client import CacheClient

    cache = CacheClient(
        url="https://your-app.onrender.com",
        api_key="YOUR_KEY",
        namespace="my-project"
    )
    cache.set("user:123", {"name": "Rajat"}, ttl=3600, tags=["users"])
    user = cache.get("user:123")

Usage (async — FastAPI):
    from cache_client import AsyncCacheClient

    cache = AsyncCacheClient(url="...", api_key="...", namespace="my-project")

    @app.get("/user/{uid}")
    async def get_user(uid: str):
        return await cache.get(f"user:{uid}")

Install deps:
    pip install requests           # for CacheClient (sync)
    pip install httpx              # for AsyncCacheClient (async)
"""

import asyncio
import time
import json
from typing import Any, Optional, List, Callable, Union
from urllib.parse import quote

# ── Sync dependency ──────────────────────────────────────────────────────────
try:
    import requests as _requests_lib
    _HAS_REQUESTS = True
except ImportError:
    _HAS_REQUESTS = False

# ── Async dependency (optional) ──────────────────────────────────────────────
try:
    import httpx as _httpx_lib
    _HAS_HTTPX = True
except ImportError:
    _HAS_HTTPX = False


class CacheError(Exception):
    """Raised on non-2xx responses from cache server."""
    def __init__(self, message: str, status_code: int = 0, data: dict = None):
        super().__init__(message)
        self.status_code = status_code
        self.data = data or {}


# ─────────────────────────────────────────────────────────────────────────────
# Synchronous client (uses requests — works in Django, Flask, scripts)
# ─────────────────────────────────────────────────────────────────────────────
class CacheClient:
    """
    Synchronous Python client for Redis Caching Server.

    Args:
        url:         Base URL of the caching server
        api_key:     API key for authentication
        namespace:   Project namespace for key isolation (default: 'default')
        timeout:     Request timeout in seconds (default: 10)
        retries:     Retry attempts on 5xx/network errors (default: 2)
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
        if not _HAS_REQUESTS:
            raise ImportError("Install requests: pip install requests")
        if not url:
            raise ValueError("url is required")
        if not api_key:
            raise ValueError("api_key is required")

        self.base_url    = url.rstrip("/")
        self.api_key     = api_key
        self.namespace   = namespace
        self.timeout     = timeout
        self.retries     = retries
        self.retry_delay = retry_delay

        self._session = _requests_lib.Session()
        self._session.headers.update({
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
            "X-Namespace": namespace,
        })

    def _request(
        self,
        method: str,
        path: str,
        json_data: dict = None,
        params: dict = None,
        attempt: int = 0,
    ) -> dict:
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
                if resp.status_code >= 500 and attempt < self.retries:
                    time.sleep(self.retry_delay * (attempt + 1))
                    return self._request(method, path, json_data, params, attempt + 1)
                raise err

            return data

        except _requests_lib.exceptions.RequestException as e:
            if attempt < self.retries:
                time.sleep(self.retry_delay * (attempt + 1))
                return self._request(method, path, json_data, params, attempt + 1)
            raise CacheError(f"Network error: {e}")

    # ─── Key/Value ────────────────────────────────────────────────────────────

    def set(self, key: str, value: Any, ttl: int = None, tags: List[str] = None) -> dict:
        """Set a cache key."""
        body = {"key": key, "value": value}
        if ttl is not None:   body["ttl"]  = ttl
        if tags is not None:  body["tags"] = tags
        return self._request("POST", "/api/cache", json_data=body)

    def get(self, key: str) -> Any:
        """Get a cache key value. Returns None if not found."""
        try:
            return self._request("GET", f"/api/cache/{quote(key, safe='')}").get("value")
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
        return self._request("DELETE", f"/api/cache/{quote(key, safe='')}")

    def patch(self, key: str, value: Any = None, ttl: int = None, tags: List[str] = None) -> dict:
        """Update value and/or TTL on an existing key.
        
        BUG FIX: The server now preserves the original TTL when you patch a
        value without specifying ttl= . No more accidental TTL resets.
        """
        body = {}
        if value is not None: body["value"] = value
        if ttl   is not None: body["ttl"]   = ttl
        if tags  is not None: body["tags"]  = tags
        return self._request("PATCH", f"/api/cache/{quote(key, safe='')}", json_data=body)

    # ─── Batch ────────────────────────────────────────────────────────────────

    def set_many(self, entries: List[dict], ttl: int = None) -> dict:
        """
        Batch set multiple keys in one request.
        entries: list of {"key": str, "value": any, "tags"?: list, "ttl"?: int}
        """
        body = {"entries": entries}
        if ttl is not None: body["ttl"] = ttl
        return self._request("POST", "/api/cache/batch", json_data=body)

    def get_many(self, keys: List[str]) -> dict:
        """Batch get. Returns dict of key -> {value, type, ttl} or None."""
        data = self._request("GET", "/api/cache/batch", params={"keys": ",".join(keys)})
        return data.get("result", {})

    def delete_many(self, keys: List[str]) -> dict:
        """Batch delete keys."""
        return self._request("DELETE", "/api/cache/batch", json_data={"keys": keys})

    # ─── Pattern/Tags ─────────────────────────────────────────────────────────

    def keys(self, pattern: str = "*", limit: int = 100) -> List[str]:
        data = self._request("GET", "/api/cache/keys", params={"pattern": pattern, "limit": limit})
        return data.get("keys", [])

    def invalidate(self, pattern: str = None, tags: List[str] = None) -> dict:
        body = {}
        if pattern: body["pattern"] = pattern
        if tags:    body["tags"]    = tags
        return self._request("POST", "/api/cache/invalidate", json_data=body)

    # ─── Atomic ───────────────────────────────────────────────────────────────

    def incr(self, key: str, amount: int = 1) -> int:
        return self._request("POST", "/api/cache/incr", json_data={"key": key, "amount": amount}).get("value", 0)

    def decr(self, key: str, amount: int = 1) -> int:
        return self.incr(key, -amount)

    # ─── Cache-aside with stampede protection ────────────────────────────────

    def compute_or_fetch(
        self,
        key: str,
        compute_fn: Callable,
        ttl: int = None,
        tags: List[str] = None,
        max_wait_s: float = 5.0,
    ) -> Any:
        """
        Cache-aside pattern with distributed stampede protection.

        Only ONE concurrent caller computes the value on a cache miss.
        Other callers wait and retry automatically until it's populated.

        Args:
            key:         Cache key
            compute_fn:  Callable that returns the value to cache on miss
            ttl:         TTL in seconds
            tags:        Tags for invalidation
            max_wait_s:  Maximum seconds to wait for another caller's result
        """
        deadline = time.monotonic() + max_wait_s

        while True:
            data = self._request("POST", "/api/cache/compute", json_data={"key": key})

            if data.get("hit"):
                return data.get("value")

            if data.get("locked"):
                # We won the lock — compute and store
                value = compute_fn()
                self.set(key, value, ttl=ttl, tags=tags)
                return value

            # Another caller is computing — wait then retry
            wait_ms = data.get("retryAfterMs", 250)
            wait_s  = wait_ms / 1000
            if time.monotonic() + wait_s > deadline:
                raise TimeoutError(f"compute_or_fetch: timed out waiting for lock on key '{key}'")
            time.sleep(wait_s)

    # ─── Hash ─────────────────────────────────────────────────────────────────

    def hset(self, key: str, fields: dict, ttl: int = None) -> dict:
        body = {"key": key, "op": "set", "fields": fields}
        if ttl is not None: body["ttl"] = ttl
        return self._request("POST", "/api/cache/hash", json_data=body)

    def hget(self, key: str, field: str = None) -> Any:
        body = {"key": key, "op": "get"}
        if field: body["field"] = field
        return self._request("POST", "/api/cache/hash", json_data=body).get("value")

    def hgetall(self, key: str) -> dict:
        return self.hget(key)

    def hdel(self, key: str, fields: Union[str, List[str]]) -> dict:
        if isinstance(fields, str): fields = [fields]
        return self._request("POST", "/api/cache/hash", json_data={"key": key, "op": "del", "fields": fields})

    # ─── List ─────────────────────────────────────────────────────────────────

    def lpush(self, key: str, values: Union[Any, List[Any]], ttl: int = None) -> int:
        if not isinstance(values, list): values = [values]
        body = {"key": key, "op": "lpush", "values": values}
        if ttl is not None: body["ttl"] = ttl
        return self._request("POST", "/api/cache/list", json_data=body).get("length", 0)

    def rpush(self, key: str, values: Union[Any, List[Any]], ttl: int = None) -> int:
        if not isinstance(values, list): values = [values]
        body = {"key": key, "op": "rpush", "values": values}
        if ttl is not None: body["ttl"] = ttl
        return self._request("POST", "/api/cache/list", json_data=body).get("length", 0)

    def lpop(self, key: str) -> Any:
        try:
            return self._request("POST", "/api/cache/list", json_data={"key": key, "op": "lpop"}).get("value")
        except CacheError as e:
            if e.status_code == 404: return None
            raise

    def rpop(self, key: str) -> Any:
        try:
            return self._request("POST", "/api/cache/list", json_data={"key": key, "op": "rpop"}).get("value")
        except CacheError as e:
            if e.status_code == 404: return None
            raise

    def lrange(self, key: str, start: int = 0, stop: int = -1) -> List[Any]:
        return self._request("POST", "/api/cache/list", json_data={"key": key, "op": "range", "start": start, "stop": stop}).get("values", [])

    def llen(self, key: str) -> int:
        return self._request("POST", "/api/cache/list", json_data={"key": key, "op": "len"}).get("length", 0)

    # ─── Set ──────────────────────────────────────────────────────────────────

    def sadd(self, key: str, values: Union[Any, List[Any]], ttl: int = None) -> int:
        if not isinstance(values, list): values = [values]
        body = {"key": key, "op": "add", "values": values}
        if ttl is not None: body["ttl"] = ttl
        return self._request("POST", "/api/cache/set", json_data=body).get("added", 0)

    def srem(self, key: str, values: Union[Any, List[Any]]) -> int:
        if not isinstance(values, list): values = [values]
        return self._request("POST", "/api/cache/set", json_data={"key": key, "op": "remove", "values": values}).get("removed", 0)

    def smembers(self, key: str) -> List[Any]:
        return self._request("POST", "/api/cache/set", json_data={"key": key, "op": "members"}).get("members", [])

    def sismember(self, key: str, value: Any) -> bool:
        return self._request("POST", "/api/cache/set", json_data={"key": key, "op": "ismember", "value": value}).get("isMember", False)

    def ssize(self, key: str) -> int:
        return self._request("POST", "/api/cache/set", json_data={"key": key, "op": "size"}).get("size", 0)

    # ─── Admin ────────────────────────────────────────────────────────────────

    def flush(self) -> dict:
        return self._request("POST", "/api/cache/flush")

    def stats(self) -> dict:
        return self._request("GET", "/api/cache/stats")

    def health(self) -> dict:
        resp = _requests_lib.get(f"{self.base_url}/health", timeout=self.timeout)
        return resp.json()

    # ─── Utils ────────────────────────────────────────────────────────────────

    def with_namespace(self, namespace: str) -> "CacheClient":
        return CacheClient(
            url=self.base_url, api_key=self.api_key, namespace=namespace,
            timeout=self.timeout, retries=self.retries, retry_delay=self.retry_delay,
        )

    def close(self):
        self._session.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    def __repr__(self):
        return f"CacheClient(url={self.base_url!r}, namespace={self.namespace!r})"


# ─────────────────────────────────────────────────────────────────────────────
# Async client (uses httpx — works in FastAPI, async Django, aiohttp apps)
#
# WHY THIS EXISTS: The synchronous `requests` library blocks the entire async
# event loop. In FastAPI or async Django a single cache.get() call would freeze
# all other concurrent requests until the HTTP call returns. AsyncCacheClient
# uses httpx's async transport so the event loop stays free.
#
# Install: pip install httpx
# ─────────────────────────────────────────────────────────────────────────────
class AsyncCacheClient:
    """
    Async Python client for Redis Caching Server.
    Use with FastAPI, async Django, aiohttp, or any asyncio-based framework.

    Args:
        url:         Base URL of the caching server
        api_key:     API key for authentication
        namespace:   Project namespace for key isolation (default: 'default')
        timeout:     Request timeout in seconds (default: 10)
        retries:     Retry attempts on 5xx/network errors (default: 2)
        retry_delay: Base delay between retries in seconds (default: 0.5)

    Example:
        cache = AsyncCacheClient(url="...", api_key="...", namespace="myapp")

        @app.on_event("startup")
        async def startup():
            await cache.open()   # create the httpx client

        @app.on_event("shutdown")
        async def shutdown():
            await cache.close()  # close connections cleanly

        @app.get("/user/{uid}")
        async def get_user(uid: str):
            return await cache.get(f"user:{uid}")
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
        if not _HAS_HTTPX:
            raise ImportError("Install httpx for async support: pip install httpx")
        if not url:
            raise ValueError("url is required")
        if not api_key:
            raise ValueError("api_key is required")

        self.base_url    = url.rstrip("/")
        self.api_key     = api_key
        self.namespace   = namespace
        self.timeout     = timeout
        self.retries     = retries
        self.retry_delay = retry_delay
        self._client: Optional[_httpx_lib.AsyncClient] = None

    async def open(self):
        """Open the underlying httpx connection pool. Call once at app startup."""
        if self._client is None:
            self._client = _httpx_lib.AsyncClient(
                base_url=self.base_url,
                timeout=self.timeout,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {self.api_key}",
                    "X-Namespace": self.namespace,
                },
                http2=True,  # HTTP/2 multiplexing for lower latency
            )
        return self

    async def close(self):
        """Close the connection pool. Call once at app shutdown."""
        if self._client:
            await self._client.aclose()
            self._client = None

    def _get_client(self) -> "_httpx_lib.AsyncClient":
        if self._client is None:
            raise RuntimeError("AsyncCacheClient not opened. Call await cache.open() first.")
        return self._client

    async def _request(self, method: str, path: str, json_data: dict = None, params: dict = None, attempt: int = 0) -> dict:
        try:
            resp = await self._get_client().request(
                method=method, url=path, json=json_data, params=params,
            )
            data = resp.json()

            if not resp.is_success:
                err = CacheError(
                    data.get("error", data.get("message", f"HTTP {resp.status_code}")),
                    status_code=resp.status_code,
                    data=data,
                )
                if resp.status_code >= 500 and attempt < self.retries:
                    await asyncio.sleep(self.retry_delay * (attempt + 1))
                    return await self._request(method, path, json_data, params, attempt + 1)
                raise err

            return data

        except _httpx_lib.RequestError as e:
            if attempt < self.retries:
                await asyncio.sleep(self.retry_delay * (attempt + 1))
                return await self._request(method, path, json_data, params, attempt + 1)
            raise CacheError(f"Network error: {e}")

    # ─── Key/Value ────────────────────────────────────────────────────────────

    async def set(self, key: str, value: Any, ttl: int = None, tags: List[str] = None) -> dict:
        body = {"key": key, "value": value}
        if ttl  is not None: body["ttl"]  = ttl
        if tags is not None: body["tags"] = tags
        return await self._request("POST", "/api/cache", json_data=body)

    async def get(self, key: str) -> Any:
        try:
            return (await self._request("GET", f"/api/cache/{quote(key, safe='')}")).get("value")
        except CacheError as e:
            if e.status_code == 404: return None
            raise

    async def get_with_meta(self, key: str) -> Optional[dict]:
        try:
            return await self._request("GET", f"/api/cache/{quote(key, safe='')}")
        except CacheError as e:
            if e.status_code == 404: return None
            raise

    async def delete(self, key: str) -> dict:
        return await self._request("DELETE", f"/api/cache/{quote(key, safe='')}")

    async def patch(self, key: str, value: Any = None, ttl: int = None, tags: List[str] = None) -> dict:
        body = {}
        if value is not None: body["value"] = value
        if ttl   is not None: body["ttl"]   = ttl
        if tags  is not None: body["tags"]  = tags
        return await self._request("PATCH", f"/api/cache/{quote(key, safe='')}", json_data=body)

    # ─── Batch ────────────────────────────────────────────────────────────────

    async def set_many(self, entries: List[dict], ttl: int = None) -> dict:
        body = {"entries": entries}
        if ttl is not None: body["ttl"] = ttl
        return await self._request("POST", "/api/cache/batch", json_data=body)

    async def get_many(self, keys: List[str]) -> dict:
        data = await self._request("GET", "/api/cache/batch", params={"keys": ",".join(keys)})
        return data.get("result", {})

    async def delete_many(self, keys: List[str]) -> dict:
        """Batch delete keys."""
        return await self._request("DELETE", "/api/cache/batch", json_data={"keys": keys})

    # ─── Pattern/Tags ─────────────────────────────────────────────────────────

    async def keys(self, pattern: str = "*", limit: int = 100) -> List[str]:
        data = await self._request("GET", "/api/cache/keys", params={"pattern": pattern, "limit": limit})
        return data.get("keys", [])

    async def invalidate(self, pattern: str = None, tags: List[str] = None) -> dict:
        body = {}
        if pattern: body["pattern"] = pattern
        if tags:    body["tags"]    = tags
        return await self._request("POST", "/api/cache/invalidate", json_data=body)

    # ─── Atomic ───────────────────────────────────────────────────────────────

    async def incr(self, key: str, amount: int = 1) -> int:
        return (await self._request("POST", "/api/cache/incr", json_data={"key": key, "amount": amount})).get("value", 0)

    async def decr(self, key: str, amount: int = 1) -> int:
        return await self.incr(key, -amount)

    # ─── Cache-aside with stampede protection ────────────────────────────────

    async def compute_or_fetch(
        self,
        key: str,
        compute_fn: Callable,
        ttl: int = None,
        tags: List[str] = None,
        max_wait_s: float = 5.0,
    ) -> Any:
        """Async cache-aside with distributed stampede protection."""
        deadline = asyncio.get_event_loop().time() + max_wait_s

        while True:
            data = await self._request("POST", "/api/cache/compute", json_data={"key": key})

            if data.get("hit"):
                return data.get("value")

            if data.get("locked"):
                # We won the lock — compute (possibly async) and store
                value = await compute_fn() if asyncio.iscoroutinefunction(compute_fn) else compute_fn()
                await self.set(key, value, ttl=ttl, tags=tags)
                return value

            wait_ms = data.get("retryAfterMs", 250)
            wait_s  = wait_ms / 1000
            if asyncio.get_event_loop().time() + wait_s > deadline:
                raise TimeoutError(f"compute_or_fetch: timed out waiting for lock on key '{key}'")
            await asyncio.sleep(wait_s)

    # ─── Hash / List / Set — same API as sync but with await ─────────────────

    async def hset(self, key: str, fields: dict, ttl: int = None) -> dict:
        body = {"key": key, "op": "set", "fields": fields}
        if ttl is not None: body["ttl"] = ttl
        return await self._request("POST", "/api/cache/hash", json_data=body)

    async def hget(self, key: str, field: str = None) -> Any:
        body = {"key": key, "op": "get"}
        if field: body["field"] = field
        return (await self._request("POST", "/api/cache/hash", json_data=body)).get("value")

    async def hgetall(self, key: str) -> dict:
        return await self.hget(key)

    async def hdel(self, key: str, fields: Union[str, List[str]]) -> dict:
        if isinstance(fields, str): fields = [fields]
        return await self._request("POST", "/api/cache/hash", json_data={"key": key, "op": "del", "fields": fields})

    async def lpush(self, key: str, values: Union[Any, List[Any]], ttl: int = None) -> int:
        if not isinstance(values, list): values = [values]
        body = {"key": key, "op": "lpush", "values": values}
        if ttl is not None: body["ttl"] = ttl
        return (await self._request("POST", "/api/cache/list", json_data=body)).get("length", 0)

    async def rpush(self, key: str, values: Union[Any, List[Any]], ttl: int = None) -> int:
        if not isinstance(values, list): values = [values]
        body = {"key": key, "op": "rpush", "values": values}
        if ttl is not None: body["ttl"] = ttl
        return (await self._request("POST", "/api/cache/list", json_data=body)).get("length", 0)

    async def lpop(self, key: str) -> Any:
        try:
            return (await self._request("POST", "/api/cache/list", json_data={"key": key, "op": "lpop"})).get("value")
        except CacheError as e:
            if e.status_code == 404: return None
            raise

    async def rpop(self, key: str) -> Any:
        try:
            return (await self._request("POST", "/api/cache/list", json_data={"key": key, "op": "rpop"})).get("value")
        except CacheError as e:
            if e.status_code == 404: return None
            raise

    async def lrange(self, key: str, start: int = 0, stop: int = -1) -> List[Any]:
        return (await self._request("POST", "/api/cache/list", json_data={"key": key, "op": "range", "start": start, "stop": stop})).get("values", [])

    async def llen(self, key: str) -> int:
        return (await self._request("POST", "/api/cache/list", json_data={"key": key, "op": "len"})).get("length", 0)

    async def sadd(self, key: str, values: Union[Any, List[Any]], ttl: int = None) -> int:
        if not isinstance(values, list): values = [values]
        body = {"key": key, "op": "add", "values": values}
        if ttl is not None: body["ttl"] = ttl
        return (await self._request("POST", "/api/cache/set", json_data=body)).get("added", 0)

    async def srem(self, key: str, values: Union[Any, List[Any]]) -> int:
        if not isinstance(values, list): values = [values]
        return (await self._request("POST", "/api/cache/set", json_data={"key": key, "op": "remove", "values": values})).get("removed", 0)

    async def smembers(self, key: str) -> List[Any]:
        return (await self._request("POST", "/api/cache/set", json_data={"key": key, "op": "members"})).get("members", [])

    async def sismember(self, key: str, value: Any) -> bool:
        return (await self._request("POST", "/api/cache/set", json_data={"key": key, "op": "ismember", "value": value})).get("isMember", False)

    async def ssize(self, key: str) -> int:
        return (await self._request("POST", "/api/cache/set", json_data={"key": key, "op": "size"})).get("size", 0)

    # ─── Admin ────────────────────────────────────────────────────────────────

    async def flush(self) -> dict:
        return await self._request("POST", "/api/cache/flush")

    async def stats(self) -> dict:
        return await self._request("GET", "/api/cache/stats")

    async def health(self) -> dict:
        resp = await self._get_client().get("/health")
        return resp.json()

    # ─── Utils ────────────────────────────────────────────────────────────────

    def with_namespace(self, namespace: str) -> "AsyncCacheClient":
        return AsyncCacheClient(
            url=self.base_url, api_key=self.api_key, namespace=namespace,
            timeout=self.timeout, retries=self.retries, retry_delay=self.retry_delay,
        )

    async def __aenter__(self):
        await self.open()
        return self

    async def __aexit__(self, *args):
        await self.close()

    def __repr__(self):
        return f"AsyncCacheClient(url={self.base_url!r}, namespace={self.namespace!r})"
