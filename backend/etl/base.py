"""The ETL contract every data source implements.

Adding a country means writing one module that yields `StatRecord`s and
registering it. Nothing else in the codebase changes — see
docs/adding-a-country.md.

The contract is deliberately narrow. A pipeline's only job is to turn a published
file into normalised records; matching, storage, and provenance are handled here
so a new source cannot accidentally invent its own conventions for them.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path


@dataclass(frozen=True)
class StatRecord:
    """One figure about one employer, ready to be loaded.

    `company_name` is the raw legal name exactly as the government published it.
    Do not normalise it in the pipeline — the loader does that, so normalisation
    stays consistent across every source and changes in one place.
    """

    company_name: str
    country: str
    metric: str
    value: float
    #: Fiscal or calendar year. None for registers publishing current status
    #: rather than yearly filings (the UK sponsor register).
    year: int | None
    #: When the *publisher* released this data. Becomes the user-facing "as of" date.
    published_date: date
    #: Must be a key in `app.sources.SOURCES`.
    source_id: str
    #: Extra names for the same employer found in this row (trading names, etc).
    aliases: tuple[str, ...] = ()
    #: Employer web domains, when the dataset provides them. Strongest match signal.
    domains: tuple[str, ...] = ()
    #: Free-form extras retained for debugging; not loaded into the schema.
    extra: dict[str, str] = field(default_factory=dict)


class Pipeline(ABC):
    """Base class for a single government dataset."""

    #: Key in `app.sources.SOURCES`. The loader refuses records citing an unknown id.
    source_id: str
    #: ISO 3166-1 alpha-2 of the filing jurisdiction.
    country: str

    @abstractmethod
    def discover(self) -> list[tuple[str, date]]:
        """Returns (url, published_date) pairs currently offered by the publisher.

        Implementations should read the publisher's own index page or dataset API
        rather than hardcoding URLs, because every one of these agencies moves
        files between fiscal years.
        """

    @abstractmethod
    def parse(self, path: Path, published_date: date) -> Iterator[StatRecord]:
        """Turns one downloaded file into records.

        Must be tolerant of column renames: these publishers rename headers
        between releases without notice. Prefer fuzzy header lookup (see
        `find_column`) over exact indexing, and raise a clear error naming the
        missing column rather than emitting silently wrong data.
        """


def find_column(columns: list[str], *candidates: str) -> str:
    """Locates a column by case- and punctuation-insensitive match.

    Government spreadsheets rename headers constantly — "Employer (Petitioner)
    Name" became "Employer Petitioner Name" between two USCIS releases, and a
    pipeline keyed on the exact string silently produced zero rows. Raises with
    the available columns listed, because a loud failure at ingest time is far
    cheaper than stale data served as current.
    """

    def key(value: str) -> str:
        return "".join(ch for ch in value.lower() if ch.isalnum())

    lookup = {key(column): column for column in columns}
    for candidate in candidates:
        if (hit := lookup.get(key(candidate))) is not None:
            return hit

    # Fall back to a containment match before giving up.
    for candidate in candidates:
        needle = key(candidate)
        for normalised, original in lookup.items():
            if needle in normalised:
                return original

    raise KeyError(
        f"None of {candidates!r} found. Available columns: {columns!r}. "
        "The publisher likely renamed a header; update the candidate list."
    )


def to_int(value: object) -> int:
    """Parses a count from a government spreadsheet cell.

    These files use blanks, "-", "N/A", and thousands separators interchangeably
    for zero-ish values. Anything unparseable becomes 0 rather than raising,
    because one malformed cell must not drop an otherwise-good employer row.
    """
    if value is None:
        return 0
    text = str(value).strip().replace(",", "")
    if not text or text in {"-", "--", "N/A", "NA", "null", "nan"}:
        return 0
    try:
        return int(float(text))
    except ValueError:
        return 0
