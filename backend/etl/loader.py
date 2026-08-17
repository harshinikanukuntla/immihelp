"""Loads `StatRecord`s into Postgres.

Centralised so every pipeline gets identical normalisation, identical dedupe
behaviour, and identical provenance handling. A pipeline that wanted to do any of
this itself would be a bug.

Loads are idempotent: re-running a pipeline over the same file updates rows in
place rather than duplicating them, keyed on
(company, country, year, metric, source). This matters because these publishers
re-issue corrected files under the same name.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.models import Company, CompanyAlias, CompanyDomain, EtlRun, SponsorshipStat
from app.resolution.normalize import normalize
from app.sources import get_source

from .base import StatRecord

logger = logging.getLogger(__name__)

BATCH_SIZE = 2_000


def load(session: Session, records: Iterable[StatRecord], *, source_id: str) -> int:
    """Upserts records, returning the number written.

    Validates the source id up front so a typo fails before any write rather than
    producing rows whose provenance cannot be resolved at read time.
    """
    get_source(source_id)

    run = EtlRun(source_id=source_id, status="running")
    session.add(run)
    session.commit()

    written = 0
    batch: list[StatRecord] = []
    published: set = set()

    try:
        for record in records:
            batch.append(record)
            published.add(record.published_date)
            if len(batch) >= BATCH_SIZE:
                written += _flush(session, batch)
                batch.clear()

        if batch:
            written += _flush(session, batch)

        run.status = "success"
        run.rows_ingested = written
        run.finished_at = datetime.now()
        run.published_date = max(published) if published else None
        session.commit()

    except Exception as exc:
        session.rollback()
        run.status = "failed"
        run.finished_at = datetime.now()
        run.notes = str(exc)[:2000]
        session.add(run)
        session.commit()
        raise

    logger.info("loaded %s rows from %s", written, source_id)
    return written


def _flush(session: Session, batch: list[StatRecord]) -> int:
    company_ids = _upsert_companies(session, batch)

    rows = []
    for record in batch:
        company_id = company_ids.get(_company_key(record))
        if company_id is None:
            continue
        rows.append(
            {
                "company_id": company_id,
                "country": record.country,
                "year": record.year,
                "metric": record.metric,
                "value": record.value,
                "source_id": record.source_id,
                "published_date": record.published_date,
            }
        )

    if not rows:
        return 0

    stmt = pg_insert(SponsorshipStat).values(rows)
    stmt = stmt.on_conflict_do_update(
        constraint="uq_stat_natural_key",
        set_={
            "value": stmt.excluded.value,
            "published_date": stmt.excluded.published_date,
        },
    )
    session.execute(stmt)
    session.commit()
    return len(rows)


def _company_key(record: StatRecord) -> tuple[str, str]:
    return (normalize(record.company_name), record.country)


def _upsert_companies(session: Session, batch: list[StatRecord]) -> dict[tuple[str, str], int]:
    """Ensures a company row exists for every record, returning key -> id.

    Companies are keyed on (normalised name, country). Two employers that
    normalise identically within one country are treated as the same entity —
    which is the intended behaviour, since that is exactly what normalisation is
    for, and the alternative is duplicate rows that split one employer's history.
    """
    wanted: dict[tuple[str, str], StatRecord] = {}
    for record in batch:
        key = _company_key(record)
        if key[0] and key not in wanted:
            wanted[key] = record

    if not wanted:
        return {}

    values = [
        {
            "canonical_name": record.company_name.strip(),
            "normalized_name": key[0],
            "country": key[1],
        }
        for key, record in wanted.items()
    ]

    stmt = pg_insert(Company).values(values)
    # DO UPDATE rather than DO NOTHING so RETURNING yields a row for existing
    # companies too; DO NOTHING silently omits conflicting rows from RETURNING.
    stmt = stmt.on_conflict_do_update(
        constraint="uq_company_normalized_country",
        set_={"updated_at": stmt.excluded.updated_at},
    ).returning(Company.id, Company.normalized_name, Company.country)

    result = {(n, c): i for i, n, c in session.execute(stmt).all()}
    session.commit()

    _upsert_aliases_and_domains(session, wanted, result)
    return result


def _upsert_aliases_and_domains(
    session: Session,
    wanted: dict[tuple[str, str], StatRecord],
    company_ids: dict[tuple[str, str], int],
) -> None:
    alias_rows = []
    domain_rows = []

    for key, record in wanted.items():
        company_id = company_ids.get(key)
        if company_id is None:
            continue

        for alias in record.aliases:
            normalized = normalize(alias)
            if not normalized or normalized == key[0]:
                continue
            alias_rows.append(
                {
                    "company_id": company_id,
                    "alias": alias.strip(),
                    "normalized_alias": normalized,
                    "source": f"etl:{record.source_id}",
                }
            )

        for domain in record.domains:
            cleaned = domain.strip().lower().removeprefix("www.")
            if cleaned:
                domain_rows.append({"company_id": company_id, "domain": cleaned})

    if alias_rows:
        session.execute(
            pg_insert(CompanyAlias)
            .values(alias_rows)
            .on_conflict_do_nothing(constraint="uq_alias_company_normalized")
        )
    if domain_rows:
        session.execute(
            pg_insert(CompanyDomain)
            .values(domain_rows)
            .on_conflict_do_nothing(constraint="uq_domain_company")
        )
    if alias_rows or domain_rows:
        session.commit()


def seed_aliases(session: Session, pairs: Iterable[tuple[str, str, str]]) -> int:
    """Adds curated aliases: (canonical_name, alias, country).

    Curated aliases are how the big consumer brands get connected to their filing
    entities — "Amazon" to "AMAZON.COM SERVICES LLC", "Google" to "GOOGLE LLC".
    String similarity cannot bridge those gaps, and widening the thresholds until
    it could would break far more than it fixed.
    """
    written = 0
    for canonical, alias, country in pairs:
        company = session.scalar(
            select(Company).where(
                Company.normalized_name == normalize(canonical), Company.country == country
            )
        )
        if company is None:
            logger.warning("seed alias skipped, no such company: %s (%s)", canonical, country)
            continue

        session.execute(
            pg_insert(CompanyAlias)
            .values(
                company_id=company.id,
                alias=alias,
                normalized_alias=normalize(alias),
                source="seed",
            )
            .on_conflict_do_nothing(constraint="uq_alias_company_normalized")
        )
        written += 1

    session.commit()
    return written
