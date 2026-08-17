"""Per-IP rate limiting for the public API.

The endpoint has no login and never will, so there is no account to throttle —
the client IP is the only handle available. It is used transiently by the limiter
and is never written to the database or to a log line that persists; see
docs/privacy.md.

## Storage, and why it is probed rather than assumed

Redis-backed limiting is shared across processes, which is what you want in
production. But `limits` connects lazily and raises `ConnectionError` on the
first limited request when Redis is down — which turns "the cache is offline"
into "every lookup returns a 500". That is the wrong trade for an optional
dependency, and it is a mistake that only shows up once Redis actually fails.

So the backend probes Redis once at import and falls back to in-process counters
if it is unreachable. In-process limiting is weaker — each worker keeps its own
counters, so the effective limit is roughly `limit × workers` — but a weaker
limit is a much better failure mode than a dead endpoint. The degradation is
logged loudly and surfaced through `/v1/health`.
"""

from __future__ import annotations

import logging

from slowapi import Limiter
from slowapi.util import get_remote_address

from .config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

#: Set to False when the limiter fell back to in-process counters, so /v1/health
#: can report that limits are per-worker rather than global.
using_shared_storage = True


def _storage_uri() -> str:
    """Returns the Redis URI if Redis answers, else in-memory storage."""
    global using_shared_storage

    try:
        import redis

        client = redis.Redis.from_url(settings.redis_url, socket_connect_timeout=1)
        client.ping()
        client.close()
        return settings.redis_url
    except Exception:  # noqa: BLE001 - any failure means "do not depend on it"
        using_shared_storage = False
        logger.warning(
            "Redis unreachable at %s; rate limiting falls back to in-process counters. "
            "Limits are per-worker rather than shared until Redis returns.",
            settings.redis_url,
        )
        return "memory://"


limiter = Limiter(
    key_func=get_remote_address,
    # Two tiers: a per-minute limit that stops scripted hammering, and an hourly
    # ceiling that stops a slow, sustained scrape of the whole company table.
    default_limits=[settings.rate_limit_burst],
    storage_uri=_storage_uri(),
    strategy="fixed-window",
)
