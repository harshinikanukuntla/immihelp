"""Runtime configuration. Everything is env-overridable; nothing is secret."""

from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="SPONSORSCOPE_", env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg://sponsorscope:sponsorscope@localhost:5432/sponsorscope"
    redis_url: str = "redis://localhost:6379/0"

    #: Allow the extension's origin only. Chrome extension origins are stable per
    #: build, so this is set at deploy time rather than left open.
    cors_allow_origins: list[str] = ["chrome-extension://*"]

    #: Per-IP request budget for the public lookup endpoint. The API has no login,
    #: which makes it a standing abuse target — see docs/data-sources.md.
    rate_limit: str = "60/minute"
    rate_limit_burst: str = "600/hour"

    #: How long a company lookup stays in Redis. Government data changes quarterly
    #: at best, so a long TTL costs nothing in freshness.
    cache_ttl_seconds: int = 60 * 60 * 24

    #: Number of blocking candidates pulled from Postgres before scoring.
    candidate_limit: int = 25
    #: Trigram similarity floor for the blocking query. Lower values widen the
    #: shortlist and cost latency; they do not loosen the match thresholds, which
    #: are enforced in the matcher.
    blocking_similarity: float = 0.3

    log_level: str = "INFO"


@lru_cache
def get_settings() -> Settings:
    return Settings()
