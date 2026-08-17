"""UK Register of Licensed Sponsors: Workers.

https://www.gov.uk/government/publications/register-of-licensed-sponsors-workers

Structurally different from the US sources, and the difference matters to the UI.
This register is a snapshot of who *currently holds a licence*, not a history of
filings. There are no counts and no years — an organisation is on the list or it
is not.

That makes it stronger evidence than US filing history in one way (it is current,
updated near-daily) and weaker in another (a licence is permission to sponsor,
not a commitment to sponsor for any particular role). The `uk_licensed_sponsor`
metric is emitted as a 1/0 flag with `year=None`, and the extension renders
flag-shaped metrics with different copy from count-shaped ones.
"""

from __future__ import annotations

import csv
from collections.abc import Iterator
from datetime import date
from pathlib import Path

from ..base import Pipeline, StatRecord, find_column

REGISTER_URL = (
    "https://www.gov.uk/government/publications/register-of-licensed-sponsors-workers"
)

#: Routes that permit sponsoring a skilled worker. The register also lists
#: temporary and creative-worker routes, which are not relevant to the audience
#: and would otherwise flag employers who cannot sponsor an ordinary tech role.
SKILLED_ROUTES = (
    "skilled worker",
    "global business mobility",
    "senior or specialist worker",
    "scale-up",
    "international sportsperson",  # kept for completeness; harmless
    "t2 minister of religion",
)


class UkSponsorRegisterPipeline(Pipeline):
    source_id = "uk_sponsor_register"
    country = "GB"

    def __init__(self, urls: list[tuple[str, date]] | None = None) -> None:
        self._urls = urls

    def discover(self) -> list[tuple[str, date]]:
        if self._urls is not None:
            return self._urls
        raise NotImplementedError(
            "The register's CSV URL changes with every near-daily republish. Pass "
            "the current link via --url, or implement discovery against the "
            "publication page's attachment list."
        )

    def parse(self, path: Path, published_date: date) -> Iterator[StatRecord]:
        with path.open(newline="", encoding="utf-8-sig") as handle:
            reader = csv.DictReader(handle)
            if reader.fieldnames is None:
                return

            columns = list(reader.fieldnames)
            col_name = find_column(columns, "Organisation Name", "Organisation")
            col_route = _optional(columns, "Route", "Tier & Sub Tier", "Tier and Sub Tier")
            col_rating = _optional(columns, "Type & Rating", "Type and Rating", "Rating")
            col_city = _optional(columns, "Town/City", "Town City", "Town")

            # One organisation appears once per route it is licensed for. Collapse
            # to a single record per organisation so the panel shows "licensed
            # sponsor" once rather than five times.
            seen: set[str] = set()

            for row in reader:
                name = (row.get(col_name) or "").strip()
                if not name or name in seen:
                    continue

                route = (row.get(col_route) or "").strip().lower() if col_route else ""
                if route and not any(allowed in route for allowed in SKILLED_ROUTES):
                    continue

                seen.add(name)

                extra = {}
                if col_rating and (rating := (row.get(col_rating) or "").strip()):
                    extra["rating"] = rating
                if col_city and (city := (row.get(col_city) or "").strip()):
                    extra["city"] = city
                if route:
                    extra["route"] = route

                yield StatRecord(
                    company_name=name,
                    country=self.country,
                    metric="uk_licensed_sponsor",
                    value=1.0,
                    # No year: this is current status, not a yearly filing count.
                    year=None,
                    published_date=published_date,
                    source_id=self.source_id,
                    extra=extra,
                )


def _optional(columns: list[str], *candidates: str) -> str | None:
    try:
        return find_column(columns, *candidates)
    except KeyError:
        return None
