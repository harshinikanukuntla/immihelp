"""ETL command line.

    # Ingest a USCIS fiscal-year CSV you have already downloaded
    python -m etl.run ingest uscis_h1b_hub --file ./data/h1b_fy2024.csv --published 2025-01-15

    # Or let it fetch
    python -m etl.run ingest uk_sponsor_register --url https://... --published 2026-08-01

    # List what is registered
    python -m etl.run sources

Each source is scheduled on its own cadence, matched to when the publisher
actually releases — see docs/data-sources.md. There is no single "run everything"
schedule, because running a quarterly source daily just re-ingests identical rows.
"""

from __future__ import annotations

import argparse
import logging
import sys
import tempfile
from datetime import date, datetime
from pathlib import Path

import httpx

from app.db import SessionLocal
from app.sources import SOURCES

from .base import Pipeline
from .loader import load, seed_aliases
from .sources.ca_lmia import CanadaLmiaPipeline
from .sources.uk_sponsors import UkSponsorRegisterPipeline
from .sources.us_uscis import UscisH1bPipeline

logger = logging.getLogger("etl")

#: Registering a pipeline here is the last step of adding a country.
PIPELINES: dict[str, type[Pipeline]] = {
    "uscis_h1b_hub": UscisH1bPipeline,
    "uk_sponsor_register": UkSponsorRegisterPipeline,
    "esdc_lmia": CanadaLmiaPipeline,
}

USER_AGENT = "SponsorScope-ETL/0.1 (+https://github.com/your-org/sponsorscope)"


def ingest(source_id: str, *, file: Path | None, url: str | None, published: date) -> int:
    pipeline_cls = PIPELINES.get(source_id)
    if pipeline_cls is None:
        raise SystemExit(f"Unknown source {source_id!r}. Known: {', '.join(PIPELINES)}")

    pipeline = pipeline_cls()

    with tempfile.TemporaryDirectory() as tmp:
        if url:
            path = _download(url, Path(tmp))
        elif file:
            path = file
        else:
            raise SystemExit("Provide either --file or --url")

        session = SessionLocal()
        try:
            count = load(session, pipeline.parse(path, published), source_id=source_id)
        finally:
            session.close()

    print(f"Ingested {count} rows from {source_id} (published {published})")
    return count


def seed_aliases_from_file(path: Path) -> int:
    """Loads curated aliases from a CSV, ignoring comment and blank lines."""
    import csv

    if not path.exists():
        raise SystemExit(f"No such file: {path}")

    rows: list[tuple[str, str, str]] = []
    with path.open(newline="", encoding="utf-8") as handle:
        lines = [line for line in handle if not line.lstrip().startswith("#") and line.strip()]

    for row in csv.DictReader(lines):
        canonical = (row.get("canonical_name") or "").strip()
        alias = (row.get("alias") or "").strip()
        country = (row.get("country") or "").strip().upper()
        if canonical and alias and country:
            rows.append((canonical, alias, country))

    session = SessionLocal()
    try:
        return seed_aliases(session, rows)
    finally:
        session.close()


def _download(url: str, into: Path) -> Path:
    """Fetches a publisher's file.

    This is the only outbound fetch in the project, and it targets government
    open-data endpoints exclusively. Nothing here touches a job board — see the
    project's constraints in README.md.
    """
    logger.info("downloading %s", url)
    target = into / (url.rsplit("/", 1)[-1] or "download")

    with httpx.stream(
        "GET", url, follow_redirects=True, timeout=120.0, headers={"User-Agent": USER_AGENT}
    ) as response:
        response.raise_for_status()
        with target.open("wb") as handle:
            for chunk in response.iter_bytes(chunk_size=1 << 16):
                handle.write(chunk)

    logger.info("downloaded %s (%s bytes)", target.name, target.stat().st_size)
    return target


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="sponsorscope-etl", description=__doc__)
    parser.add_argument("--verbose", action="store_true")
    sub = parser.add_subparsers(dest="command", required=True)

    ingest_parser = sub.add_parser("ingest", help="Ingest one published file.")
    ingest_parser.add_argument("source", choices=sorted(PIPELINES))
    ingest_parser.add_argument(
        "--file", type=Path, help="Local path to an already-downloaded file."
    )
    ingest_parser.add_argument("--url", help="URL to download before parsing.")
    ingest_parser.add_argument(
        "--published",
        required=True,
        help="ISO date the publisher released this file. Shown to users as the 'as of' date.",
    )

    seed_parser = sub.add_parser(
        "seed-aliases", help="Load curated company aliases (see seed/aliases.csv)."
    )
    seed_parser.add_argument("--file", type=Path, default=Path("seed/aliases.csv"))

    sub.add_parser("sources", help="List registered sources and their cadence.")

    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO)

    if args.command == "seed-aliases":
        print(f"Seeded {seed_aliases_from_file(args.file)} aliases")
        return 0

    if args.command == "sources":
        for source in SOURCES.values():
            registered = "registered" if source.id in PIPELINES else "NO PIPELINE"
            print(f"{source.id:24} {source.country}  [{registered}]  {source.cadence}")
        return 0

    published = datetime.strptime(args.published, "%Y-%m-%d").date()
    ingest(args.source, file=args.file, url=args.url, published=published)
    return 0


if __name__ == "__main__":
    sys.exit(main())
