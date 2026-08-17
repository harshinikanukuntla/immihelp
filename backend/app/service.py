"""Lookup service: query in, verdict out.

Kept separate from the HTTP layer so the interesting logic — which countries to
check, how to aggregate stats, when to refuse to answer — is testable without a
web client, and so a second transport (a CLI, a batch job) never has to
re-implement it.
"""

from __future__ import annotations

import logging
from collections import defaultdict
from datetime import date

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from .models import Company, LookupCounter, SponsorshipStat
from .resolution.matcher import MatchQuery, resolve
from .resolution.normalize import normalize
from .resolution.repository import find_candidates
from .schemas import (
    CompanyLookupResponse,
    CompanyMatch,
    NoRecordResponse,
    SourceAttribution,
    SponsorshipRecord,
    VerifiedResponse,
)
from .sources import get_source

logger = logging.getLogger(__name__)

#: Countries whose registers we hold. A lookup with no country hint checks all of
#: them, because a candidate browsing a remote posting may be considering any.
SUPPORTED_COUNTRIES = ("US", "GB", "CA")


def lookup_company(
    session: Session,
    name: str,
    country: str | None = None,
    domain: str | None = None,
) -> CompanyLookupResponse:
    """Resolves a company name to its sponsorship record, or to an honest absence."""
    countries_checked = [country] if country in SUPPORTED_COUNTRIES else list(SUPPORTED_COUNTRIES)

    candidates = find_candidates(session, name=name, country=country, domain=domain)
    match = resolve(MatchQuery(name=name, domain=domain, country=country), candidates)

    if match is None:
        return NoRecordResponse(queried_name=name, countries_checked=countries_checked)

    stats = session.scalars(
        select(SponsorshipStat).where(SponsorshipStat.company_id == match.company.id)
    ).all()

    if not stats:
        # We matched a company row but hold no figures for it. That is still an
        # absence of evidence, not evidence of absence, so it takes the same
        # verdict rather than a weaker-looking "verified with zero".
        return NoRecordResponse(queried_name=name, countries_checked=countries_checked)

    return VerifiedResponse(
        match=CompanyMatch(
            canonical_name=match.company.canonical_name,
            queried_name=name,
            score=round(match.score, 4),
            confidence=match.confidence.value,
            method=match.method,
            warnings=match.warnings,
        ),
        records=_aggregate(stats, countries_checked),
    )


def _aggregate(
    stats: list[SponsorshipStat], countries_checked: list[str]
) -> list[SponsorshipRecord]:
    """Groups raw stat rows into one record per country.

    Metrics are summed across years so the panel can show a headline figure, and
    the contributing years are listed so "12 approvals" is never mistaken for a
    single-year number.
    """
    by_country: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    years: dict[str, set[int]] = defaultdict(set)
    #: Keep only the most recent publication per source, which is what "as of" means.
    source_dates: dict[str, dict[str, date]] = defaultdict(dict)

    for stat in stats:
        if stat.country not in countries_checked:
            continue
        by_country[stat.country][stat.metric] += float(stat.value)
        if stat.year is not None:
            years[stat.country].add(stat.year)

        current = source_dates[stat.country].get(stat.source_id)
        if current is None or stat.published_date > current:
            source_dates[stat.country][stat.source_id] = stat.published_date

    records: list[SponsorshipRecord] = []
    for country, metrics in by_country.items():
        attributions = []
        for source_id, published in sorted(source_dates[country].items()):
            source = get_source(source_id)
            attributions.append(
                SourceAttribution(
                    id=source.id,
                    label=source.label,
                    publisher=source.publisher,
                    published_date=published,
                    url=source.url,
                )
            )
        records.append(
            SponsorshipRecord(
                country=country,
                metrics={k: round(v, 2) for k, v in metrics.items()},
                years=sorted(years[country]),
                sources=attributions,
            )
        )

    return sorted(records, key=lambda r: r.country)


def record_lookup(session: Session, name: str) -> None:
    """Increments the anonymous daily counter for a company name.

    This is the entire analytics surface of the backend. It stores a normalised
    company name and a date — nothing about who asked, from where, or in what
    order. See `LookupCounter` and docs/privacy.md.

    Failures here are swallowed: a counter is never worth failing a lookup over.
    """
    normalized = normalize(name)
    if not normalized:
        return

    try:
        stmt = (
            pg_insert(LookupCounter)
            .values(normalized_name=normalized, day=date.today(), count=1)
            .on_conflict_do_update(
                constraint="uq_lookup_name_day",
                set_={"count": LookupCounter.__table__.c.count + 1},
            )
        )
        session.execute(stmt)
        session.commit()
    except Exception:  # noqa: BLE001 - telemetry must never break the request path
        session.rollback()
        logger.warning("failed to record anonymous lookup counter", exc_info=True)


def company_count(session: Session) -> int:
    return session.scalar(select(func.count()).select_from(Company)) or 0
