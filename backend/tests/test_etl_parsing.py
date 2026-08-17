"""Pipeline parsing, against fixtures shaped like the real published files.

These tests need no database. They exist because the failure mode of an ETL bug
is silent: a renamed column or a mis-parsed cell produces zero rows or wrong
counts, the API keeps serving cheerfully, and nobody notices until a user acts on
a number that was never right.
"""

from datetime import date
from pathlib import Path

import pytest

from etl.base import find_column, to_int
from etl.sources.uk_sponsors import UkSponsorRegisterPipeline
from etl.sources.us_uscis import UscisH1bPipeline

FIXTURES = Path(__file__).parent / "fixtures"
PUBLISHED = date(2025, 1, 15)


def records_by_company(records, name):
    return {r.metric: r.value for r in records if r.company_name == name}


class TestUscisPipeline:
    @pytest.fixture
    def records(self):
        pipeline = UscisH1bPipeline()
        return list(pipeline.parse(FIXTURES / "uscis_h1b_sample.csv", PUBLISHED))

    def test_parses_counts_with_thousands_separators(self, records):
        google = records_by_company(records, "GOOGLE LLC")
        assert google["h1b_initial_approvals"] == 1234
        assert google["h1b_continuing_approvals"] == 3456

    def test_keeps_initial_and_continuing_separate(self, records):
        # An employer with continuing approvals but no initial ones is maintaining
        # an existing population, not hiring. Summing these would hide that.
        maintenance = records_by_company(records, "MAINTENANCE ONLY CORP")
        assert maintenance["h1b_initial_approvals"] == 0
        assert maintenance["h1b_continuing_approvals"] == 742

    def test_skips_rows_with_no_activity(self, records):
        assert records_by_company(records, "ZERO ACTIVITY LLC") == {}

    def test_skips_rows_with_no_employer_name(self, records):
        assert all(r.company_name.strip() for r in records)

    def test_treats_placeholder_cells_as_zero(self, records):
        dashes = records_by_company(records, "DASH VALUES INC")
        assert dashes["h1b_initial_approvals"] == 0
        assert dashes["h1b_initial_denials"] == 0
        assert dashes["h1b_continuing_approvals"] == 15

    def test_every_record_carries_provenance(self, records):
        assert records
        for record in records:
            assert record.source_id == "uscis_h1b_hub"
            assert record.published_date == PUBLISHED
            assert record.country == "US"
            assert record.year == 2024

    def test_retains_location_for_debugging(self, records):
        google = next(r for r in records if r.company_name == "GOOGLE LLC")
        assert google.extra["state"] == "CA"


class TestUkSponsorPipeline:
    @pytest.fixture
    def records(self):
        pipeline = UkSponsorRegisterPipeline()
        return list(pipeline.parse(FIXTURES / "uk_sponsors_sample.csv", PUBLISHED))

    def test_collapses_one_organisation_listed_under_several_routes(self, records):
        monzo = [r for r in records if r.company_name == "Monzo Bank Limited"]
        assert len(monzo) == 1

    def test_excludes_routes_that_cannot_sponsor_a_skilled_role(self, records):
        names = {r.company_name for r in records}
        assert "Ye Olde Theatre Company" not in names

    def test_emits_a_flag_rather_than_a_count(self, records):
        # The register says "licensed", not "sponsored N people". A count-shaped
        # metric here would invite the UI to render a number that does not exist.
        for record in records:
            assert record.metric == "uk_licensed_sponsor"
            assert record.value == 1.0

    def test_has_no_year_because_it_is_current_status(self, records):
        assert all(record.year is None for record in records)

    def test_includes_scale_up_and_skilled_worker_routes(self, records):
        names = {r.company_name for r in records}
        assert {"Monzo Bank Limited", "Deliveroo plc", "Scale Up Startup Ltd"} <= names


class TestFindColumn:
    def test_matches_ignoring_case_and_punctuation(self):
        columns = ["Employer (Petitioner) Name", "Fiscal Year"]
        assert find_column(columns, "Employer Petitioner Name") == "Employer (Petitioner) Name"

    def test_falls_back_to_containment(self):
        assert find_column(["Total Approved Positions"], "Approved Positions") == (
            "Total Approved Positions"
        )

    def test_raises_with_the_available_columns_listed(self):
        # A loud failure at ingest beats stale data served as current.
        with pytest.raises(KeyError) as exc:
            find_column(["Something Else"], "Employer")
        assert "Something Else" in str(exc.value)


class TestToInt:
    @pytest.mark.parametrize(
        ("value", "expected"),
        [
            ("1,234", 1234),
            ("42", 42),
            ("", 0),
            ("-", 0),
            ("N/A", 0),
            (None, 0),
            ("nan", 0),
            ("12.0", 12),
            ("garbage", 0),
        ],
    )
    def test_parses_government_spreadsheet_cells(self, value, expected):
        assert to_int(value) == expected
