"""USCIS H-1B Employer Data Hub.

https://www.uscis.gov/tools/reports-and-studies/h-1b-employer-data-hub

One CSV per federal fiscal year, with petition approval and denial counts split
into initial (new employment) and continuing (extensions, transfers, amendments).

The initial/continuing split is the useful part and is preserved rather than
summed. An employer with 400 continuing approvals and 2 initial approvals is
maintaining an existing population, not hiring new H-1B workers — which is
precisely the distinction a candidate deciding whether to apply cares about, and
precisely the distinction a single "H-1B petitions" number destroys.
"""

from __future__ import annotations

import csv
from collections.abc import Iterator
from datetime import date
from pathlib import Path

from ..base import Pipeline, StatRecord, find_column, to_int

#: The hub's landing page links a CSV per fiscal year. Discovery reads the page
#: rather than hardcoding, because USCIS changes the file naming each release.
HUB_URL = "https://www.uscis.gov/tools/reports-and-studies/h-1b-employer-data-hub"


class UscisH1bPipeline(Pipeline):
    source_id = "uscis_h1b_hub"
    country = "US"

    def __init__(self, urls: list[tuple[str, date]] | None = None) -> None:
        #: Injectable so tests and reruns can pin an exact set of files.
        self._urls = urls

    def discover(self) -> list[tuple[str, date]]:
        if self._urls is not None:
            return self._urls
        raise NotImplementedError(
            "Automatic discovery scrapes the USCIS hub page, whose markup changes "
            "between releases. Pass explicit (url, published_date) pairs via "
            "--url, or implement discovery against the current page. See "
            "docs/adding-a-country.md."
        )

    def parse(self, path: Path, published_date: date) -> Iterator[StatRecord]:
        with path.open(newline="", encoding="utf-8-sig") as handle:
            reader = csv.DictReader(handle)
            if reader.fieldnames is None:
                return

            columns = list(reader.fieldnames)
            col_year = find_column(columns, "Fiscal Year")
            col_name = find_column(
                columns, "Employer (Petitioner) Name", "Employer Petitioner Name", "Employer"
            )
            col_initial_approval = find_column(columns, "Initial Approval", "Initial Approvals")
            col_initial_denial = find_column(columns, "Initial Denial", "Initial Denials")
            col_continuing_approval = find_column(
                columns, "Continuing Approval", "Continuing Approvals"
            )
            col_continuing_denial = find_column(columns, "Continuing Denial", "Continuing Denials")
            col_city = _optional_column(columns, "Petitioner City", "City")
            col_state = _optional_column(columns, "Petitioner State", "State")

            for row in reader:
                name = (row.get(col_name) or "").strip()
                if not name:
                    continue

                year = to_int(row.get(col_year))
                if year <= 0:
                    continue

                metrics = {
                    "h1b_initial_approvals": to_int(row.get(col_initial_approval)),
                    "h1b_initial_denials": to_int(row.get(col_initial_denial)),
                    "h1b_continuing_approvals": to_int(row.get(col_continuing_approval)),
                    "h1b_continuing_denials": to_int(row.get(col_continuing_denial)),
                }

                # Rows that are all zeroes carry no information and bloat the table.
                if not any(metrics.values()):
                    continue

                extra = {}
                if col_city and (city := (row.get(col_city) or "").strip()):
                    extra["city"] = city
                if col_state and (state := (row.get(col_state) or "").strip()):
                    extra["state"] = state

                for metric, value in metrics.items():
                    yield StatRecord(
                        company_name=name,
                        country=self.country,
                        metric=metric,
                        value=float(value),
                        year=year,
                        published_date=published_date,
                        source_id=self.source_id,
                        extra=extra,
                    )


def _optional_column(columns: list[str], *candidates: str) -> str | None:
    try:
        return find_column(columns, *candidates)
    except KeyError:
        return None
