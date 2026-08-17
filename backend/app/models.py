"""Database schema.

Deliberately small: four tables for the data, two for operations. There is no
user table, no session table, and no credential of any kind, because the product
never authenticates anyone. See docs/privacy.md — the absence of these tables is
a design guarantee, not an omission to be filled in later.
"""

from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import (
    BigInteger,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class Company(Base):
    """One employer, as identified across every dataset we ingest."""

    __tablename__ = "companies"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    canonical_name: Mapped[str] = mapped_column(String(512), nullable=False)
    #: Output of `app.resolution.normalize.normalize`, stored so the blocking
    #: query can use a trigram index instead of normalising on every request.
    normalized_name: Mapped[str] = mapped_column(String(512), nullable=False)
    #: ISO 3166-1 alpha-2 of the filing jurisdiction, not of the company's HQ.
    country: Mapped[str] = mapped_column(String(2), nullable=False)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    aliases: Mapped[list[CompanyAlias]] = relationship(
        back_populates="company", cascade="all, delete-orphan", lazy="selectin"
    )
    domains: Mapped[list[CompanyDomain]] = relationship(
        back_populates="company", cascade="all, delete-orphan", lazy="selectin"
    )
    stats: Mapped[list[SponsorshipStat]] = relationship(
        back_populates="company", cascade="all, delete-orphan", lazy="selectin"
    )

    __table_args__ = (
        UniqueConstraint("normalized_name", "country", name="uq_company_normalized_country"),
        # Trigram index powers the blocking shortlist. Created in the migration
        # alongside `CREATE EXTENSION pg_trgm`.
        Index(
            "ix_companies_normalized_name_trgm",
            "normalized_name",
            postgresql_using="gin",
            postgresql_ops={"normalized_name": "gin_trgm_ops"},
        ),
    )


class CompanyAlias(Base):
    """Another name the same employer files or advertises under.

    Aliases are how "Amazon" reaches "AMAZON.COM SERVICES LLC" without loosening
    the fuzzy thresholds — see the module docstring in `resolution/matcher.py`.
    They come from three places: ETL-derived variants within a dataset, a curated
    seed list, and cross-dataset joins on shared domains.
    """

    __tablename__ = "company_aliases"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    company_id: Mapped[int] = mapped_column(
        ForeignKey("companies.id", ondelete="CASCADE"), nullable=False, index=True
    )
    alias: Mapped[str] = mapped_column(String(512), nullable=False)
    normalized_alias: Mapped[str] = mapped_column(String(512), nullable=False)
    #: "etl:uscis_h1b_hub", "seed", or "domain_join" — kept so a bad batch can be undone.
    source: Mapped[str] = mapped_column(String(64), nullable=False)

    company: Mapped[Company] = relationship(back_populates="aliases")

    __table_args__ = (
        UniqueConstraint("company_id", "normalized_alias", name="uq_alias_company_normalized"),
        Index(
            "ix_aliases_normalized_trgm",
            "normalized_alias",
            postgresql_using="gin",
            postgresql_ops={"normalized_alias": "gin_trgm_ops"},
        ),
    )


class CompanyDomain(Base):
    """A web domain the employer controls. The strongest matching evidence we have."""

    __tablename__ = "company_domains"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    company_id: Mapped[int] = mapped_column(
        ForeignKey("companies.id", ondelete="CASCADE"), nullable=False, index=True
    )
    domain: Mapped[str] = mapped_column(String(255), nullable=False, index=True)

    company: Mapped[Company] = relationship(back_populates="domains")

    __table_args__ = (UniqueConstraint("company_id", "domain", name="uq_domain_company"),)


class SponsorshipStat(Base):
    """One (company, country, year, metric) figure from one government dataset.

    Long format rather than a column per metric, because each country publishes a
    different set of numbers and adding a country must not require a migration.
    See docs/adding-a-country.md for the metric-naming contract.
    """

    __tablename__ = "sponsorship_stats"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    company_id: Mapped[int] = mapped_column(
        ForeignKey("companies.id", ondelete="CASCADE"), nullable=False, index=True
    )
    country: Mapped[str] = mapped_column(String(2), nullable=False)
    #: Fiscal year for US data, calendar year elsewhere. Null for registers like
    #: the UK's, which publish current licence status rather than yearly filings.
    year: Mapped[int | None] = mapped_column(Integer, nullable=True)
    #: e.g. "h1b_initial_approvals", "perm_certified", "lmia_positive_positions".
    metric: Mapped[str] = mapped_column(String(64), nullable=False)
    value: Mapped[float] = mapped_column(Numeric(14, 2), nullable=False)

    source_id: Mapped[str] = mapped_column(String(64), nullable=False)
    #: When the publisher released this data. Shown to the user as the "as of" date.
    published_date: Mapped[date] = mapped_column(Date, nullable=False)
    ingested_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    company: Mapped[Company] = relationship(back_populates="stats")

    __table_args__ = (
        UniqueConstraint(
            "company_id", "country", "year", "metric", "source_id", name="uq_stat_natural_key"
        ),
        Index("ix_stats_company_country", "company_id", "country"),
    )


class EtlRun(Base):
    """Audit trail for pipeline runs, so a bad ingest can be identified and rolled back."""

    __tablename__ = "etl_runs"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    source_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="running")
    rows_ingested: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    published_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    notes: Mapped[str | None] = mapped_column(String(2048), nullable=True)


class LookupCounter(Base):
    """Anonymous, aggregate lookup volume.

    This is the *only* thing the backend records about usage, and it is
    deliberately shaped so it cannot become a profile: one row per
    (normalised company name, day) with a counter. No IP, no user agent, no
    session, no request ordering, nothing joinable to a person. It exists to show
    which companies to prioritise for alias curation.
    """

    __tablename__ = "lookup_counters"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    normalized_name: Mapped[str] = mapped_column(String(512), nullable=False)
    day: Mapped[date] = mapped_column(Date, nullable=False)
    count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    __table_args__ = (
        UniqueConstraint("normalized_name", "day", name="uq_lookup_name_day"),
    )
