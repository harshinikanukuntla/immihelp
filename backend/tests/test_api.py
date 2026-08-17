"""HTTP layer.

This file exists because of a bug that every other test missed. `_aggregate` was
tested, the schemas were tested, entity resolution was tested — and
`GET /v1/company` still returned a 500 for every request, because the endpoint
serialised to camelCase and then FastAPI validated that output *back* into the
model. The models declared serialisation aliases only, so they could not parse
what they had just produced, and all eleven fields read as missing.

The lesson is narrow and worth keeping: a model that emits one spelling and
accepts another cannot round-trip, and anything that re-reads its output —
FastAPI's response validation, the Redis cache, a client replaying a stored
payload — breaks on it.
"""

from datetime import date

import pytest
from fastapi.testclient import TestClient

from app import api
from app.db import get_session
from app.main import app
from app.schemas import (
    CompanyMatch,
    HealthResponse,
    NoRecordResponse,
    SourceAttribution,
    SponsorshipRecord,
    VerifiedResponse,
)

VERIFIED = VerifiedResponse(
    match=CompanyMatch(
        canonical_name="GOOGLE LLC",
        queried_name="Google",
        score=1.0,
        confidence="high",
        method="exact_normalized",
        warnings=[],
    ),
    records=[
        SponsorshipRecord(
            country="US",
            metrics={"h1b_initial_approvals": 1234.0},
            years=[2024],
            sources=[
                SourceAttribution(
                    id="uscis_h1b_hub",
                    label="USCIS H-1B Employer Data Hub",
                    publisher="USCIS",
                    published_date=date(2025, 1, 15),
                    url="https://www.uscis.gov/tools/reports-and-studies/h-1b-employer-data-hub",
                )
            ],
        )
    ],
)

NO_RECORD = NoRecordResponse(queried_name="Infisical", countries_checked=["US"])


class TestAliasRoundTrip:
    """Every response model must be able to parse its own serialised output."""

    @pytest.mark.parametrize(
        ("model", "instance"),
        [
            (VerifiedResponse, VERIFIED),
            (NoRecordResponse, NO_RECORD),
            (
                HealthResponse,
                HealthResponse(status="ok", database=True, cache=True, last_ingest={}),
            ),
        ],
    )
    def test_serialised_output_validates_back_into_the_model(self, model, instance):
        payload = instance.model_dump(by_alias=True, mode="json")
        # The exact operation FastAPI performs on a returned dict, and the one
        # that used to 500 the endpoint.
        assert model.model_validate(payload) == instance

    def test_output_is_camel_case_for_the_extension(self):
        payload = NO_RECORD.model_dump(by_alias=True, mode="json")
        assert payload["queriedName"] == "Infisical"
        assert payload["countriesChecked"] == ["US"]
        assert "queried_name" not in payload

    def test_models_still_accept_snake_case_construction(self):
        # Python callers build these with field names, not aliases.
        assert NoRecordResponse(queried_name="X", countries_checked=[]).queried_name == "X"


@pytest.fixture
def client(monkeypatch):
    """A client with the database and telemetry stubbed out.

    The endpoint's own behaviour — serialisation, status codes, verdict shape —
    is what is under test here; `lookup_company` has its own tests.
    """
    app.dependency_overrides[get_session] = lambda: None
    monkeypatch.setattr(api.v1, "record_lookup", lambda *a, **k: None)
    monkeypatch.setattr(api.v1.cache, "get", lambda key: None)
    monkeypatch.setattr(api.v1.cache, "set", lambda key, value: None)
    yield TestClient(app)
    app.dependency_overrides.clear()


class TestCompanyEndpoint:
    def test_returns_a_verified_verdict(self, client, monkeypatch):
        monkeypatch.setattr(api.v1, "lookup_company", lambda *a, **k: VERIFIED)

        response = client.get("/v1/company", params={"name": "Google", "country": "US"})

        assert response.status_code == 200
        body = response.json()
        assert body["kind"] == "verified"
        assert body["match"]["canonicalName"] == "GOOGLE LLC"
        assert body["match"]["confidence"] == "high"

    def test_every_figure_carries_a_source_and_a_date(self, client, monkeypatch):
        monkeypatch.setattr(api.v1, "lookup_company", lambda *a, **k: VERIFIED)

        record = client.get("/v1/company", params={"name": "Google"}).json()["records"][0]

        assert record["sources"], "a figure without provenance is unrenderable"
        assert record["sources"][0]["publishedDate"] == "2025-01-15"
        assert record["sources"][0]["publisher"] == "USCIS"

    def test_no_record_is_reported_as_its_own_verdict(self, client, monkeypatch):
        monkeypatch.setattr(api.v1, "lookup_company", lambda *a, **k: NO_RECORD)

        body = client.get("/v1/company", params={"name": "Infisical"}).json()

        # Not an error, not a zero count, and emphatically not does_not_sponsor.
        assert body["kind"] == "no_record"
        assert body["queriedName"] == "Infisical"

    def test_a_cached_payload_is_served_unchanged(self, client, monkeypatch):
        # Cached responses used to take a different path out of the endpoint than
        # fresh ones. They now share one, so this asserts the cached path too.
        cached = VERIFIED.model_dump(by_alias=True, mode="json")
        monkeypatch.setattr(api.v1.cache, "get", lambda key: cached)
        monkeypatch.setattr(
            api.v1, "lookup_company", lambda *a, **k: pytest.fail("should not hit the database")
        )

        response = client.get("/v1/company", params={"name": "Google"})

        assert response.status_code == 200
        assert response.json() == cached

    def test_rejects_a_missing_name(self, client):
        assert client.get("/v1/company").status_code == 422

    def test_rejects_a_malformed_country(self, client):
        assert client.get(
            "/v1/company", params={"name": "X", "country": "USA"}
        ).status_code == 422


class TestSourcesEndpoint:
    def test_lists_every_registered_source(self, client):
        body = client.get("/v1/sources").json()
        assert "US" in body["countries"]
        assert any(s["id"] == "uscis_h1b_hub" for s in body["sources"])

    def test_each_source_explains_what_it_proves(self, client):
        # `means` is user-facing copy that keeps people from over-reading a figure.
        for source in client.get("/v1/sources").json()["sources"]:
            assert len(source["means"]) > 40
