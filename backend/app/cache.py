"""Redis cache for the hot lookup path.

Company lookups are extremely repetitive — a handful of large employers account
for most traffic — and the underlying data changes quarterly at best, so caching
is nearly free in freshness terms.

Cache keys contain only the normalised company name, country, and domain from the
query. Nothing identifying the requester is stored, hashed, or used as a key.
"""

from __future__ import annotations

import json
import logging

import redis

from .config import get_settings
from .resolution.normalize import normalize

logger = logging.getLogger(__name__)

_client: redis.Redis | None = None


def get_client() -> redis.Redis | None:
    """Returns a Redis client, or None if Redis is unreachable.

    The cache is an optimisation, never a dependency. A dead Redis degrades
    latency; it must not take the API down with it.
    """
    global _client
    if _client is None:
        try:
            _client = redis.Redis.from_url(
                get_settings().redis_url, decode_responses=True, socket_connect_timeout=1
            )
            _client.ping()
        except Exception:  # noqa: BLE001
            logger.warning("redis unavailable; serving uncached", exc_info=True)
            _client = None
    return _client


def cache_key(name: str, country: str | None, domain: str | None) -> str:
    return f"ss:v1:company:{normalize(name)}:{country or '*'}:{(domain or '*').lower()}"


def get(key: str) -> dict | None:
    client = get_client()
    if client is None:
        return None
    try:
        raw = client.get(key)
        return json.loads(raw) if raw else None
    except Exception:  # noqa: BLE001
        logger.warning("cache read failed", exc_info=True)
        return None


def set(key: str, value: dict) -> None:  # noqa: A001 - mirrors the redis verb
    client = get_client()
    if client is None:
        return
    try:
        client.setex(key, get_settings().cache_ttl_seconds, json.dumps(value, default=str))
    except Exception:  # noqa: BLE001
        logger.warning("cache write failed", exc_info=True)


def healthy() -> bool:
    client = get_client()
    if client is None:
        return False
    try:
        return bool(client.ping())
    except Exception:  # noqa: BLE001
        return False
