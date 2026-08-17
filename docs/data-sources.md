# Data sources

Every figure SponsorScope displays comes from one of the datasets below, and
every figure is displayed with its source and publication date attached. The
response schema makes provenance non-optional precisely so that adding a source
forces someone to fill this in.

This document is also the reference for **what each dataset can and cannot
prove**. The one-sentence `means` field in
[`app/sources.py`](../backend/app/sources.py) is the user-facing version of each
section here, and the UI shows it verbatim.

---

## United States

### USCIS H-1B Employer Data Hub

- **URL:** https://www.uscis.gov/tools/reports-and-studies/h-1b-employer-data-hub
- **Publisher:** U.S. Citizenship and Immigration Services
- **Format:** CSV, one file per federal fiscal year
- **Cadence:** Annual, released a few months after the fiscal year ends
- **Terms:** U.S. federal government work, public domain
- **Source id:** `uscis_h1b_hub`

Petition counts split four ways: initial approvals, initial denials, continuing
approvals, continuing denials.

**The initial/continuing split is the important part and is never summed.**
"Initial" means new employment — a fresh H-1B, or a change of employer.
"Continuing" means extensions, amendments, and transfers for people the employer
already has. An employer with 400 continuing and 2 initial approvals is
maintaining an existing population, not hiring new H-1B workers, and those two
situations look identical if you add the numbers together.

**What it proves:** this employer filed petitions that USCIS decided in that
fiscal year.

**What it does not prove:** current policy. The data lags by a year or more, and
sponsorship decisions are frequently made per team and per role.

### DOL OFLC PERM disclosures

- **URL:** https://www.dol.gov/agencies/eta/foreign-labor/performance
- **Publisher:** U.S. Department of Labor, Office of Foreign Labor Certification
- **Format:** Excel, cumulative within each fiscal year
- **Cadence:** Quarterly
- **Terms:** U.S. federal government work, public domain
- **Source id:** `dol_oflc_perm`
- **Status:** registered as a source; the pipeline is not yet written

PERM is the labour certification step of employment-based permanent residence.
An employer filing PERM is sponsoring green cards, which is a stronger and
longer commitment than an H-1B.

### DOL OFLC LCA disclosures

- **URL:** https://www.dol.gov/agencies/eta/foreign-labor/performance
- **Publisher:** U.S. Department of Labor, Office of Foreign Labor Certification
- **Format:** Excel, cumulative within each fiscal year
- **Cadence:** Quarterly
- **Terms:** U.S. federal government work, public domain
- **Source id:** `dol_oflc_lca`
- **Status:** registered as a source; the pipeline is not yet written

A Labour Condition Application is a prerequisite to an H-1B petition. LCAs are
filed earlier, and more of them are filed than are used, so **LCA counts run
higher than USCIS petition counts for the same employer**. They are not
interchangeable and must never be added together or presented as the same
number. They are stored under distinct metric names for this reason.

---

## United Kingdom

### Register of Licensed Sponsors: Workers

- **URL:** https://www.gov.uk/government/publications/register-of-licensed-sponsors-workers
- **Publisher:** UK Visas and Immigration, Home Office
- **Format:** CSV
- **Cadence:** Updated near-daily
- **Terms:** Open Government Licence v3.0
- **Source id:** `uk_sponsor_register`

**Structurally different from the US data, and the difference changes the UI.**
This is a snapshot of who currently holds a sponsor licence. There are no counts
and no years — an organisation is on the list or it is not.

That makes it stronger evidence in one way (it is current, not a historical
filing record) and weaker in another (a licence is *permission* to sponsor, not
a commitment to sponsor for any particular role). It is stored as a
`uk_licensed_sponsor` flag with `year=None`, and the panel renders flag-shaped
metrics as "Yes" rather than as the meaningless number `1`.

The pipeline filters to routes that can sponsor a skilled worker. An
organisation licensed only for the Creative Worker route cannot sponsor an
ordinary engineering role, and listing them would be a false positive.

One organisation appears once per licensed route, so rows are collapsed to one
record per organisation.

---

## Canada

### Positive LMIA Employers List

- **URL:** https://open.canada.ca/data/en/dataset/90fed587-1364-4f33-a9ee-208181dc0b97
- **Publisher:** Employment and Social Development Canada
- **Format:** Excel, by NOC occupation code and province
- **Cadence:** Quarterly
- **Terms:** Open Government Licence – Canada
- **Source id:** `esdc_lmia`

**This dataset has an exclusion that makes absence unusually weak evidence:
employers whose legal name contains a personal name are not published.** A large
number of small Canadian employers sponsor and never appear here at all. The
`means` copy says so, and the panel's "no record found" state says so.

An LMIA is granted per position and per quarter, so summing positions across
quarters produces a volume signal, not a headcount. The metric is named
`lmia_positive_positions` to keep anyone from reading it as employees.

The published workbooks carry a variable number of title and preamble rows above
the real header, so the pipeline detects the header row rather than assuming
`header=0` — reading with a fixed offset silently produces a frame whose column
names are the report title.

---

## Everywhere else

No open government register of sponsoring employers is known for other
countries. Those postings fall back to
[posting-text detection](../extension/src/lib/sponsorship-phrases.ts), which is
always labelled "mentioned in this posting — not independently verified" and is
visually distinct from government-sourced results.

---

## Rules that apply to every source

**Absence is not a negative finding.** `no_record` and `does_not_sponsor` are
separate variants of a tagged union, not one nullable count, so no client can
render one as the other. Companies are missing from these datasets for many
mundane reasons: they are small, they sponsored recently enough not to appear
yet, they file under a parent or subsidiary legal name, or (in Canada) their
name contains a personal name.

**Nothing here supports a `does_not_sponsor` verdict.** None of these publishers
release "this employer does not sponsor". The variant exists so the contract is
complete and the rendering path is written, but no current pipeline emits it.

**Every figure shows its as-of date.** The `--published` argument to the ETL is
the date the *publisher* released the file, not the date it was ingested.
Getting it wrong misrepresents how current the data is, which is the specific
failure this whole provenance apparatus exists to prevent.

**Staleness is externally visible.** `GET /v1/health` reports the most recent
successful ingest per source. A pipeline that silently stops does not raise an
error — it just serves increasingly old data as though it were current.

**Entity resolution is the weak link, not the data.** These datasets are
accurate about the legal entities they name. The hard part is deciding that the
"Acme" on a job board is the "ACME HOLDINGS INTERNATIONAL LLC" in the filing.
See [`app/resolution/matcher.py`](../backend/app/resolution/matcher.py).

---

## Adding a source

See [adding-a-country.md](adding-a-country.md). Register it in
`app/sources.py` first — the loader refuses records citing an unknown source id,
so provenance cannot be skipped.
