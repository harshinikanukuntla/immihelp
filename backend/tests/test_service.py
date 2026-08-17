"""Stat aggregation and the response contract.

No database: `_aggregate` is a pure function over stat rows, and the rules it
enforces — provenance on every figure, most-recent publication date wins, years
listed alongside summed metrics — are exactly the rules that would otherwise be
violated silently.
"""

from dataclasses import dataclass
from datetime import date

import pytest

from app.schemas import NoRecordResponse, VerifiedResponse
from app.service import _aggregate
from app.sources import SOURCES, get_source


@dataclass
class FakeStat:
    """Stands in for a SponsorshipStat row; `_aggregate` only reads attributes."""

    country: str
    metric: str
    value: float
    year: int | None
    source_id: str
    published_date: date


def stat(**kwargs) -> FakeStat:
    defaults = {
        "country": "US",
        "metric": "h1b_initial_approvals",
        "value": 10.0,
        "year": 2024,
        "source_id": "uscis_h1b_hub",
        "published_date": date(2025, 1, 15),
    }
    return FakeStat(**{**defaults, **kwargs})


class TestAggregate:
    def test_sums_a_metric_across_years(self):
        stats = [stat(year=2023, value=10), stat(year=2024, value=15)]
        records = _aggregate(stats, ["US"])

        assert len(records) == 1
        assert records[0].metrics["h1b_initial_approvals"] == 25
        # Years are listed so a summed figure is never mistaken for one year's.
        assert records[0].years == [2023, 2024]

    def test_keeps_different_metrics_separate(self):
        stats = [
            stat(metric="h1b_initial_approvals", value=5),
            stat(metric="h1b_continuing_approvals", value=100),
        ]
        metrics = _aggregate(stats, ["US"])[0].metrics
        assert metrics["h1b_initial_approvals"] == 5
        assert metrics["h1b_continuing_approvals"] == 100

    def test_groups_by_country(self):
        stats = [
            stat(country="US"),
            stat(country="GB", metric="uk_licensed_sponsor", value=1, year=None,
                 source_id="uk_sponsor_register"),
        ]
        records = _aggregate(stats, ["US", "GB"])
        assert [r.country for r in records] == ["GB", "US"]  # sorted

    def test_excludes_countries_that_were_not_checked(self):
        stats = [stat(country="US"), stat(country="CA", source_id="esdc_lmia")]
        records = _aggregate(stats, ["US"])
        assert [r.country for r in records] == ["US"]

    def test_every_record_carries_at_least_one_source(self):
        # The response schema makes this non-optional; this asserts the producer
        # actually honours it, since a record with no provenance is unrenderable.
        for record in _aggregate([stat()], ["US"]):
            assert len(record.sources) >= 1

    def test_uses_the_most_recent_publication_date_per_source(self):
        stats = [
            stat(year=2023, published_date=date(2024, 3, 1)),
            stat(year=2024, published_date=date(2025, 1, 15)),
        ]
        sources = _aggregate(stats, ["US"])[0].sources
        assert len(sources) == 1
        assert sources[0].published_date == date(2025, 1, 15)

    def test_lists_each_contributing_source_separately(self):
        stats = [
            stat(source_id="uscis_h1b_hub"),
            stat(metric="perm_certified", source_id="dol_oflc_perm"),
        ]
        ids = {source.id for source in _aggregate(stats, ["US"])[0].sources}
        assert ids == {"uscis_h1b_hub", "dol_oflc_perm"}

    def test_handles_status_registers_that_have_no_year(self):
        stats = [
            stat(country="GB", metric="uk_licensed_sponsor", value=1, year=None,
                 source_id="uk_sponsor_register")
        ]
        record = _aggregate(stats, ["GB"])[0]
        assert record.years == []
        assert record.metrics["uk_licensed_sponsor"] == 1

    def test_returns_nothing_for_no_stats(self):
        assert _aggregate([], ["US"]) == []


class TestResponseContract:
    def test_no_record_is_a_distinct_kind_from_a_verdict(self):
        # These must never collapse into one nullable field: an absent filing is
        # not a finding that the company does not sponsor.
        response = NoRecordResponse(queried_name="Acme", countries_checked=["US"])
        assert response.kind == "no_record"
        assert VerifiedResponse.model_fields["kind"].default == "verified"

    def test_no_record_serialises_with_camel_case_aliases(self):
        payload = NoRecordResponse(
            queried_name="Acme", countries_checked=["US"]
        ).model_dump(by_alias=True)
        assert payload["queriedName"] == "Acme"
        assert payload["countriesChecked"] == ["US"]


class TestSourceRegistry:
    @pytest.mark.parametrize("source_id", sorted(SOURCES))
    def test_every_source_is_fully_described(self, source_id: str):
        source = get_source(source_id)
        assert source.label and source.publisher and source.url
        assert source.cadence
        # `means` is the copy the UI uses to keep users from over-reading a
        # figure, so an empty one is a product bug, not a docs gap.
        assert len(source.means) > 40

    def test_unknown_source_ids_fail_loudly(self):
        with pytest.raises(KeyError, match="Register it in app/sources.py"):
            get_source("not_a_real_source")
