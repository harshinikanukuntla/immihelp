"""Canada Positive LMIA Employers List.

https://open.canada.ca/data/en/dataset/90fed587-1364-4f33-a9ee-208181dc0b97

Quarterly, broken down by NOC occupation code and province. Two properties of
this dataset shape how it must be presented:

1. **Employers whose legal name contains a personal name are excluded** from the
   published list. A great many small Canadian employers sponsor and never
   appear here. Absence in this dataset is therefore unusually weak evidence, and
   the source registry says so in `means` — copy the UI shows verbatim.
2. An LMIA is per-position and per-quarter. Summing positions across quarters
   gives a volume signal, not a headcount, so the metric is named
   `lmia_positive_positions` rather than anything that reads like employees.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import date
from pathlib import Path

from ..base import Pipeline, StatRecord, find_column, to_int

DATASET_URL = "https://open.canada.ca/data/en/dataset/90fed587-1364-4f33-a9ee-208181dc0b97"


class CanadaLmiaPipeline(Pipeline):
    source_id = "esdc_lmia"
    country = "CA"

    def __init__(self, urls: list[tuple[str, date]] | None = None) -> None:
        self._urls = urls

    def discover(self) -> list[tuple[str, date]]:
        if self._urls is not None:
            return self._urls
        raise NotImplementedError(
            "Discovery should read the CKAN package API at "
            f"{DATASET_URL} and select the current quarter's resource. Until that "
            "is implemented, pass --url explicitly."
        )

    def parse(self, path: Path, published_date: date) -> Iterator[StatRecord]:
        # These are published as Excel workbooks with several header rows of
        # preamble above the real table, which is why this uses pandas rather
        # than csv: locating the header row is the fiddly part.
        import pandas as pd

        frame = _read_with_header_detection(pd, path)
        columns = [str(c) for c in frame.columns]

        col_employer = find_column(columns, "Employer", "Employer Name")
        col_positions = find_column(
            columns, "Approved Positions", "Positions Approved", "Number of Positions"
        )
        col_lmias = _optional(columns, "Approved LMIAs", "LMIAs Approved")
        col_province = _optional(columns, "Province/Territory", "Province Territory", "Province")

        # One employer appears on many rows (one per occupation). Aggregate before
        # yielding so the loader is not asked to upsert the same natural key
        # dozens of times per file.
        totals: dict[str, dict[str, float]] = {}
        provinces: dict[str, str] = {}

        for _, row in frame.iterrows():
            name = str(row.get(col_employer, "") or "").strip()
            if not name or name.lower() in {"nan", "total"}:
                continue

            bucket = totals.setdefault(name, {"lmia_positive_positions": 0.0, "lmia_approved": 0.0})
            bucket["lmia_positive_positions"] += to_int(row.get(col_positions))
            if col_lmias:
                bucket["lmia_approved"] += to_int(row.get(col_lmias))

            if col_province and name not in provinces:
                province = str(row.get(col_province, "") or "").strip()
                if province and province.lower() != "nan":
                    provinces[name] = province

        year = published_date.year
        for name, metrics in totals.items():
            extra = {"province": provinces[name]} if name in provinces else {}
            for metric, value in metrics.items():
                if value <= 0:
                    continue
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


def _read_with_header_detection(pd, path: Path):
    """Finds the real header row beneath the publisher's title/preamble rows.

    ESDC prefixes these workbooks with a title, a date, and a blank row, and the
    number of preamble rows changes between quarters. Reading with `header=0`
    silently yields a frame whose columns are the report title.
    """
    raw = pd.read_excel(path, header=None, nrows=25) if path.suffix in {".xlsx", ".xls"} else None
    header_row = 0

    if raw is not None:
        for index, row in raw.iterrows():
            values = [str(v).strip().lower() for v in row.tolist()]
            if any(v == "employer" or v.startswith("employer") for v in values):
                header_row = int(index)
                break

    if path.suffix in {".xlsx", ".xls"}:
        return pd.read_excel(path, header=header_row)
    return pd.read_csv(path)


def _optional(columns: list[str], *candidates: str) -> str | None:
    try:
        return find_column(columns, *candidates)
    except KeyError:
        return None
