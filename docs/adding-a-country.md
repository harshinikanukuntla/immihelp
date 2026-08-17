# Adding a country

Adding a country means writing one ETL pipeline and registering it in four
places. The pipeline's only job is turning a published file into normalised
records — matching, storage, and provenance are handled by shared code so a new
source cannot invent its own conventions for them.

## 1. Register the source

In [`app/sources.py`](../backend/app/sources.py). Every field is required.

```python
"ie_employment_permits": Source(
    id="ie_employment_permits",
    label="Ireland Employment Permits Statistics",
    publisher="DETE",
    country="IE",
    url="https://enterprise.gov.ie/...",
    cadence="Monthly, published in arrears.",
    means=(
        "This employer was granted employment permits in the period shown. "
        "It does not indicate current hiring policy."
    ),
),
```

`means` is **user-facing copy**, not a comment. It is one honest sentence about
what the data proves, and the UI shows it verbatim to stop people over-reading a
number. `test_service.py` fails if it is too short to be a real sentence.

The loader refuses records citing an unregistered source id, so this step cannot
be skipped.

## 2. Write the pipeline

Subclass [`Pipeline`](../backend/etl/base.py) in `etl/sources/<country>_<name>.py`:

```python
class IrishPermitsPipeline(Pipeline):
    source_id = "ie_employment_permits"
    country = "IE"

    def discover(self) -> list[tuple[str, date]]:
        """(url, published_date) pairs the publisher currently offers."""

    def parse(self, path: Path, published_date: date) -> Iterator[StatRecord]:
        """One downloaded file -> records."""
```

### The `StatRecord` contract

```python
StatRecord(
    company_name="ACME LIMITED",   # RAW legal name — do not normalise
    country="IE",
    metric="ie_permits_granted",
    value=42.0,
    year=2025,                     # None for current-status registers
    published_date=date(2025, 7, 1),
    source_id="ie_employment_permits",
    aliases=("Acme",),             # optional
    domains=("acme.ie",),          # optional, strongest matching signal
)
```

### Conventions

**Do not normalise `company_name`.** The loader applies
[`normalize()`](../backend/app/resolution/normalize.py), so normalisation stays
consistent across every source and changes in exactly one place. A pipeline that
lowercases or strips suffixes itself creates a source whose entities silently
fail to match everyone else's.

**Name metrics `<country>_<what>`,** lowercase, and never merge semantically
different figures. The clearest example is the US H-1B split: initial approvals
(new employment) and continuing approvals (extensions and transfers) are stored
separately because an employer with 400 continuing and 2 initial approvals is
maintaining a population rather than hiring — the exact distinction a candidate
needs, and one that summing destroys.

**Use `year=None` and a `1.0` flag for current-status registers.** The UK
register lists who currently holds a licence; there are no counts. Emitting a
fake count would invite the panel to render a meaningless number. Flag-shaped
metrics render as "Yes" instead.

**Use `find_column`, never exact header indexing.** These publishers rename
headers between releases without notice — "Employer (Petitioner) Name" became
"Employer Petitioner Name" between two USCIS files, and a pipeline keyed on the
exact string silently produced zero rows for a full release cycle.

```python
col_name = find_column(columns, "Employer (Petitioner) Name", "Employer Name", "Employer")
```

It matches case- and punctuation-insensitively, falls back to containment, and
raises with the available columns listed. **A loud failure at ingest is far
cheaper than stale data served as current.**

**Use `to_int` for counts.** These files use blanks, `-`, `N/A`, and thousands
separators interchangeably. It returns 0 for anything unparseable rather than
raising, so one malformed cell does not drop an otherwise-good employer.

**Aggregate before yielding** if one employer spans many rows (per occupation,
per province). The loader upserts on a natural key, so unaggregated rows mean
repeated writes to the same key.

**Watch for preamble rows** in Excel files. Publishers prefix workbooks with a
title and date, and the offset changes between releases. Detect the header row;
see [`ca_lmia.py`](../backend/etl/sources/ca_lmia.py).

## 3. Add fixtures and tests

Copy real rows — including the messy ones — into `backend/tests/fixtures/`:

- blank employer names
- `-`, `N/A`, and empty count cells
- thousands separators
- all-zero rows
- the same employer on several rows

Assert against them in `tests/test_etl_parsing.py`. These tests need no
database. ETL bugs are silent: a renamed column produces zero rows, the API
keeps serving cheerfully, and nobody notices until someone acts on a number that
was never right.

## 4. Register it in four places

| File | Change |
| --- | --- |
| [`etl/run.py`](../backend/etl/run.py) | Add to `PIPELINES` |
| [`app/service.py`](../backend/app/service.py) | Add to `SUPPORTED_COUNTRIES` |
| [`extension/src/lib/country.ts`](../extension/src/lib/country.ts) | Add to `COVERED_COUNTRIES`, and add a `DISPLAY_NAMES` entry |
| [`extension/src/content/panel.ts`](../extension/src/content/panel.ts) | Add your metrics to `METRIC_LABELS` |

Without the last one the panel shows raw metric keys.

## 5. Consider aliases

Fuzzy matching cannot bridge a brand name to a legal entity name — "Amazon" and
"AMAZON.COM SERVICES LLC" are not close under any string metric, and lowering
the thresholds until they were would start matching "Apple" to "Apple Bank for
Savings". Curated aliases are the correct fix.

Add common employers to [`seed/aliases.csv`](../backend/seed/aliases.csv) and
load them:

```bash
python -m etl.run seed-aliases --file seed/aliases.csv
```

Aliases must be loaded *after* the government data, since they attach to
existing company rows.

## 6. Schedule it

Match the publisher's own cadence — `Source.cadence` documents it. Running a
quarterly source daily just re-ingests identical rows. Loads are idempotent
(upsert on `company, country, year, metric, source`), so re-running a corrected
file updates in place rather than duplicating.

## Documenting it

Add a section to [data-sources.md](data-sources.md) covering the URL, publisher,
format, cadence, licence terms, what it proves, and — most importantly — what it
does **not** prove. Canada's list excluding employers whose name contains a
personal name is the kind of caveat that changes how the data should be read,
and it belongs in the docs and in `means`.
