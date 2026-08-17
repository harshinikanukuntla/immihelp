"""Blocking: narrowing the whole company table to a scorable shortlist.

Scoring every company against every query is O(table). Blocking uses Postgres
trigram similarity to pull a small candidate set first, then the matcher does the
careful work on those.

Blocking is a *recall* mechanism, not a precision one. It is tuned to be generous
— a candidate wrongly included is discarded by the matcher's thresholds, whereas
a candidate wrongly excluded can never be matched at all, and shows the user
"no record found" for a company we actually have data on.
"""

from __future__ import annotations

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import Company, CompanyDomain
from .matcher import CandidateCompany
from .normalize import normalize


def find_candidates(
    session: Session,
    name: str,
    country: str | None = None,
    domain: str | None = None,
) -> list[CandidateCompany]:
    """Returns a shortlist of companies plausibly matching `name`.

    Candidates come from three sources, unioned: an exact domain hit, trigram
    similarity on the canonical name, and trigram similarity on any alias.
    """
    settings = get_settings()
    normalized = normalize(name)
    if not normalized:
        return []

    company_ids: set[int] = set()

    if domain:
        company_ids.update(session.scalars(_domain_query(domain)).all())

    company_ids.update(
        session.scalars(
            _similarity_query(
                "companies",
                "normalized_name",
                normalized,
                country,
                settings.blocking_similarity,
                settings.candidate_limit,
            )
        ).all()
    )

    company_ids.update(
        session.scalars(
            _similarity_query(
                "company_aliases",
                "normalized_alias",
                normalized,
                country,
                settings.blocking_similarity,
                settings.candidate_limit,
            )
        ).all()
    )

    if not company_ids:
        return []

    stmt = select(Company).where(Company.id.in_(company_ids))
    if country:
        stmt = stmt.where(Company.country == country)

    return [_to_candidate(company) for company in session.scalars(stmt).unique()]


def _domain_query(domain: str):
    cleaned = domain.strip().lower().removeprefix("https://").removeprefix("http://")
    cleaned = cleaned.removeprefix("www.").split("/")[0]
    return select(CompanyDomain.company_id).where(CompanyDomain.domain == cleaned)


def _similarity_query(
    table: str,
    column: str,
    normalized: str,
    country: str | None,
    threshold: float,
    limit: int,
):
    """Trigram-similarity shortlist against one table's normalised-name column.

    Written as text() because SQLAlchemy has no first-class construct for the
    pg_trgm `%` operator with a per-query threshold, and the alternative
    (`similarity(a, b) > x`) cannot use the GIN index. The `%` operator can.
    Both the table and column names are module-local literals, never user input.
    """
    company_id_column = "id" if table == "companies" else "company_id"
    country_filter = ""
    if country:
        country_filter = (
            " AND company_id IN (SELECT id FROM companies WHERE country = :country)"
            if table != "companies"
            else " AND country = :country"
        )

    sql = text(
        f"""
        SELECT {company_id_column} AS company_id
        FROM {table}
        WHERE {column} % :needle
          AND similarity({column}, :needle) >= :threshold
          {country_filter}
        ORDER BY similarity({column}, :needle) DESC
        LIMIT :limit
        """  # noqa: S608 - table/column are literals defined above, not user input
    ).columns(company_id=Company.id.type)

    params = {"needle": normalized, "threshold": threshold, "limit": limit}
    if country:
        params["country"] = country
    return sql.bindparams(**params)


def _to_candidate(company: Company) -> CandidateCompany:
    return CandidateCompany(
        id=company.id,
        canonical_name=company.canonical_name,
        aliases=tuple(alias.alias for alias in company.aliases),
        domains=tuple(d.domain for d in company.domains),
        country=company.country,
    )
