"""API response models.

These mirror `extension/src/types/domain.ts`. When one side changes, change both
— there is no codegen, by choice: the surface is small and a generator would be
more machinery than the contract is worth.

The shape encodes two product rules that must not be negotiable at the API layer:

1. Every figure carries `sources`, and every source carries a `published_date`.
   There is no way to return a number without saying where it came from and when.
2. `no_record` is a distinct verdict from `does_not_sponsor`. They are separate
   members of a tagged union rather than a nullable count, so no client can
   accidentally render an absence of data as a negative finding.
"""

from __future__ import annotations

from datetime import date
from typing import Literal

from pydantic import BaseModel, Field


class SourceAttribution(BaseModel):
    id: str
    label: str
    publisher: str
    published_date: date = Field(alias="publishedDate")
    url: str

    model_config = {"populate_by_name": True}


class CompanyMatch(BaseModel):
    canonical_name: str = Field(alias="canonicalName")
    queried_name: str = Field(alias="queriedName")
    score: float = Field(ge=0.0, le=1.0)
    confidence: Literal["high", "probable", "possible"]
    #: How the match was made — "exact_normalized", "domain", "alias", "fuzzy".
    method: str
    #: Machine-readable caveats: "staffing_agency", "matched_via_alias", "low_confidence".
    warnings: list[str] = []

    model_config = {"populate_by_name": True}


class SponsorshipRecord(BaseModel):
    country: str
    metrics: dict[str, float]
    years: list[int]
    sources: list[SourceAttribution]


class VerifiedResponse(BaseModel):
    kind: Literal["verified"] = "verified"
    match: CompanyMatch
    records: list[SponsorshipRecord]


class NoRecordResponse(BaseModel):
    """No filing was located.

    Explicitly *not* evidence that the company does not sponsor. Small employers,
    recent sponsors, subsidiaries filing under a parent's legal name, and (in
    Canada) any employer whose name contains a personal name are all absent from
    these datasets while sponsoring perfectly normally.
    """

    kind: Literal["no_record"] = "no_record"
    queried_name: str = Field(alias="queriedName")
    countries_checked: list[str] = Field(alias="countriesChecked")

    model_config = {"populate_by_name": True}


class DoesNotSponsorResponse(BaseModel):
    """Reserved for a positive finding of non-sponsorship.

    No current data source supports this verdict — none of the registers publish
    "this employer does not sponsor". The variant exists so the contract is
    complete and the extension's rendering path is written, but nothing in the
    current ETL emits it. See docs/data-sources.md.
    """

    kind: Literal["does_not_sponsor"] = "does_not_sponsor"
    match: CompanyMatch
    sources: list[SourceAttribution]
    note: str


CompanyLookupResponse = VerifiedResponse | NoRecordResponse | DoesNotSponsorResponse


class HealthResponse(BaseModel):
    status: Literal["ok", "degraded"]
    database: bool
    cache: bool
    #: False when rate limiting fell back to in-process counters because Redis was
    #: unreachable at startup, making limits per-worker rather than shared.
    shared_rate_limits: bool = Field(True, alias="sharedRateLimits")
    #: Most recent successful ETL run per source, so staleness is externally visible.
    last_ingest: dict[str, date | None] = Field(
        default_factory=dict, alias="lastIngest"
    )

    model_config = {"populate_by_name": True}
