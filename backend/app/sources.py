"""The registry of government data sources.

Every figure the API returns carries an entry from this table. There is no code
path that emits a number without provenance attached — the response schema makes
`sources` non-optional precisely so that adding a new dataset forces the author
to fill this in.

All sources here are public-domain or open-government-licensed. Terms and update
cadence are documented in docs/data-sources.md.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Source:
    id: str
    label: str
    #: Short publisher name used in the panel's "source:" line.
    publisher: str
    country: str
    url: str
    #: Human description of release cadence, shown in docs and the about page.
    cadence: str
    #: What the data actually proves, in one sentence. Used to write honest UI copy.
    means: str


SOURCES: dict[str, Source] = {
    "uscis_h1b_hub": Source(
        id="uscis_h1b_hub",
        label="USCIS H-1B Employer Data Hub",
        publisher="USCIS",
        country="US",
        url="https://www.uscis.gov/tools/reports-and-studies/h-1b-employer-data-hub",
        cadence="Annual, per federal fiscal year, typically released a few months after year end.",
        means=(
            "This employer filed H-1B petitions that USCIS approved or denied in the "
            "fiscal year shown. It does not indicate current hiring policy."
        ),
    ),
    "dol_oflc_perm": Source(
        id="dol_oflc_perm",
        label="DOL OFLC PERM Disclosure Data",
        publisher="US Department of Labor",
        country="US",
        url="https://www.dol.gov/agencies/eta/foreign-labor/performance",
        cadence="Quarterly, cumulative within each federal fiscal year.",
        means=(
            "This employer filed permanent labour certification applications, which "
            "is the first step of employment-based green card sponsorship."
        ),
    ),
    "dol_oflc_lca": Source(
        id="dol_oflc_lca",
        label="DOL OFLC LCA (H-1B) Disclosure Data",
        publisher="US Department of Labor",
        country="US",
        url="https://www.dol.gov/agencies/eta/foreign-labor/performance",
        cadence="Quarterly, cumulative within each federal fiscal year.",
        means=(
            "This employer filed Labour Condition Applications, a prerequisite to an "
            "H-1B petition. An LCA is filed earlier and more often than a petition, so "
            "these counts run higher than USCIS approval counts."
        ),
    ),
    "uk_sponsor_register": Source(
        id="uk_sponsor_register",
        label="UK Register of Licensed Sponsors: Workers",
        publisher="UKVI",
        country="GB",
        url="https://www.gov.uk/government/publications/register-of-licensed-sponsors-workers",
        cadence="Updated near-daily by the Home Office.",
        means=(
            "This organisation currently holds a licence to sponsor workers. Unlike "
            "the US sources, this is current licence status rather than a history of "
            "filings — but holding a licence is not a commitment to use it for any role."
        ),
    ),
    "esdc_lmia": Source(
        id="esdc_lmia",
        label="Canada Positive LMIA Employers List",
        publisher="ESDC",
        country="CA",
        url="https://open.canada.ca/data/en/dataset/90fed587-1364-4f33-a9ee-208181dc0b97",
        cadence="Quarterly.",
        means=(
            "This employer received at least one positive Labour Market Impact "
            "Assessment in the quarter shown. Employers whose legal name contains a "
            "personal name are excluded from the published list, so absence here is "
            "especially weak evidence."
        ),
    ),
}


def get_source(source_id: str) -> Source:
    try:
        return SOURCES[source_id]
    except KeyError as exc:  # pragma: no cover - guards against typos in ETL code
        raise KeyError(
            f"Unknown source id {source_id!r}. Register it in app/sources.py before "
            "emitting stats that reference it."
        ) from exc
