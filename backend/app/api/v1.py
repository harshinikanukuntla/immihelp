"""Public v1 API.

No authentication, by design — requiring an account would mean holding identities,
which is the one thing this project promises never to do. The cost of that choice
is that the endpoint is an open abuse target, so it is rate-limited per IP and
every response is cacheable.
"""

from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import cache
from ..config import get_settings
from ..db import get_session
from ..models import EtlRun
from ..ratelimit import limiter, using_shared_storage
from ..schemas import CompanyLookupResponse, HealthResponse
from ..service import SUPPORTED_COUNTRIES, lookup_company, record_lookup
from ..sources import SOURCES

router = APIRouter(prefix="/v1", tags=["v1"])
settings = get_settings()


@router.get("/company", response_model=CompanyLookupResponse, response_model_by_alias=True)
@limiter.limit(settings.rate_limit)
def get_company(
    request: Request,
    name: str = Query(
        ..., min_length=1, max_length=300,
        description="Company name as shown on the job board.",
    ),
    country: str | None = Query(
        None,
        min_length=2,
        max_length=2,
        description="ISO 3166-1 alpha-2. Omit to check every supported register.",
    ),
    domain: str | None = Query(
        None, max_length=255, description="Company web domain, when the page exposes one."
    ),
    session: Session = Depends(get_session),
) -> CompanyLookupResponse:
    """Looks up a company's sponsorship history.

    Returns one of three verdicts — see `app.schemas`. Note that `no_record` and
    `does_not_sponsor` are different answers and the client renders them
    differently; an absent filing is not a negative finding.
    """
    normalized_country = country.upper() if country else None

    key = cache.cache_key(name, normalized_country, domain)
    cached = cache.get(key)
    if cached is not None:
        return cached

    result = lookup_company(session, name=name, country=normalized_country, domain=domain)
    payload = result.model_dump(by_alias=True, mode="json")
    cache.set(key, payload)

    # Aggregate, anonymous, and after the response is computed so it can never
    # influence what the user gets back.
    record_lookup(session, name)

    return payload


@router.get("/sources")
@limiter.limit(settings.rate_limit)
def list_sources(request: Request) -> dict:
    """The provenance table, served so the extension's about page never hardcodes it."""
    return {
        "countries": list(SUPPORTED_COUNTRIES),
        "sources": [
            {
                "id": s.id,
                "label": s.label,
                "publisher": s.publisher,
                "country": s.country,
                "url": s.url,
                "cadence": s.cadence,
                "means": s.means,
            }
            for s in SOURCES.values()
        ],
    }


@router.get("/health", response_model=HealthResponse, response_model_by_alias=True)
def health(session: Session = Depends(get_session)) -> HealthResponse:
    """Liveness plus data staleness.

    `last_ingest` is exposed deliberately: if a pipeline silently stops, the data
    goes stale without any error, and stale sponsorship data presented as current
    is exactly the failure this project is trying not to commit.
    """
    database_ok = True
    last_ingest: dict[str, date | None] = {}
    try:
        rows = session.execute(
            select(EtlRun.source_id, func.max(EtlRun.published_date))
            .where(EtlRun.status == "success")
            .group_by(EtlRun.source_id)
        ).all()
        last_ingest = {source_id: published for source_id, published in rows}
    except Exception:  # noqa: BLE001
        database_ok = False

    for source_id in SOURCES:
        last_ingest.setdefault(source_id, None)

    cache_ok = cache.healthy()
    return HealthResponse(
        status="ok" if database_ok else "degraded",
        database=database_ok,
        cache=cache_ok,
        shared_rate_limits=using_shared_storage,
        last_ingest=last_ingest,
    )
