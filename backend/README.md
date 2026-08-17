# SponsorScope backend

The public lookup API and the government-data ETL pipelines.

Full documentation lives in the [root README](../README.md). This file covers
just enough to get the service running.

## Quick start

```bash
docker compose up -d          # from the repository root: Postgres + Redis
cd backend
uv venv && uv pip install -e ".[dev]"
python -m app.init_db         # creates the schema and the pg_trgm indexes
uvicorn app.main:app --reload # http://localhost:8000/docs
```

With no data ingested, every lookup correctly returns `no_record`. To load some:

```bash
# Download a fiscal-year CSV from the USCIS H-1B Employer Data Hub, then:
python -m etl.run ingest uscis_h1b_hub --file ./h1b_fy2024.csv --published 2025-01-15
python -m etl.run seed-aliases --file seed/aliases.csv
```

## Layout

| Path | What it is |
| --- | --- |
| `app/resolution/` | Entity resolution. The hardest and most consequential part — read its module docstrings before changing thresholds. |
| `app/sources.py` | The provenance registry. Every figure the API returns cites an entry here. |
| `app/service.py` | Lookup logic, independent of HTTP. |
| `app/api/v1.py` | The public endpoints. No authentication, rate limited per IP. |
| `etl/` | One module per government dataset, plus a shared loader. |

## Tests

```bash
pytest
```

No database is required: the resolution, aggregation, and parsing tests all run
against fixtures.
