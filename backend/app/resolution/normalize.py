"""Company-name normalisation.

Government filings use registered legal names. Job boards use whatever the
employer typed into their profile. The gap between "Alphabet Inc." and "Google"
is the reason this module exists, and the reason it is tested rather than
inlined into the matcher.

Normalisation is deliberately *lossy in one direction only*: it strips noise that
never distinguishes two real companies (legal suffixes, punctuation, case) while
preserving every token that could. It must never merge two genuinely different
employers, because a false merge shows a candidate another company's sponsorship
history as if it were this one's.
"""

from __future__ import annotations

import re
import unicodedata

# Legal-entity suffixes across the jurisdictions we ingest. Stripped only when
# they appear at the *end* of a name: "Limited Brands" is a real company whose
# first token happens to be a suffix word, and "SAP SE" must not become "SAP S".
LEGAL_SUFFIXES: frozenset[str] = frozenset(
    {
        # US
        "inc", "incorporated", "llc", "llp", "lp", "corp", "corporation",
        "co", "company", "ltd", "limited", "pc", "pllc", "plc",
        # UK / IE
        "cic", "cio", "lbg",
        # DE / AT / CH
        "gmbh", "ag", "kg", "gmbh co kg", "mbh", "se",
        # FR / BE
        "sa", "sas", "sarl", "sasu", "eurl",
        # NL
        "bv", "nv",
        # ES / LATAM
        "sl", "slu", "sau", "srl",
        # IT
        "spa", "snc",
        # IN
        "pvt", "pvt ltd", "private limited",
        # Nordics
        "ab", "as", "asa", "oy", "oyj", "aps",
        # AU / NZ
        "pty", "pty ltd", "nz",
        # JP / KR / CN
        "kk", "kabushiki kaisha", "co ltd",
        # Generic organisational tails that carry no distinguishing signal on their own
        "holdings", "holding", "group", "international", "worldwide", "global",
        "enterprises", "ventures", "partners", "associates",
    }
)

# Tokens that indicate the employer of record is a staffing intermediary rather
# than the company the candidate would actually work for. These do not block a
# match, but the matcher records them so the API can warn the user — a staffing
# agency's H-1B volume says nothing about the client company's practice.
STAFFING_MARKERS: frozenset[str] = frozenset(
    {
        "staffing", "staffing solutions", "consultancy", "consultants",
        "consulting services", "resourcing", "recruitment", "recruiting",
        "talent solutions", "manpower", "outsourcing", "it services",
        "technologies solutions", "workforce",
    }
)

# Expansions applied before suffix stripping so "&" and "and" collapse to one form.
_AMPERSAND = re.compile(r"\s*&\s*")
_PUNCT = re.compile(r"[^\w\s]", flags=re.UNICODE)
_WHITESPACE = re.compile(r"\s+")

# Job boards routinely append these to the employer name.
_BOARD_NOISE = re.compile(
    r"\s*[\|\-–—]\s*(?:careers?|jobs?|hiring|we[' ]?re hiring|official)\s*$",
    flags=re.IGNORECASE,
)


def strip_accents(value: str) -> str:
    """Folds accented characters to ASCII so "Nestlé" and "Nestle" agree."""
    decomposed = unicodedata.normalize("NFKD", value)
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch))


def normalize(name: str) -> str:
    """Returns the comparison form of a company name.

    Lowercased, accent-folded, punctuation-stripped, legal suffixes removed, and
    whitespace collapsed. Returns an empty string for input that normalises away
    entirely, which the matcher treats as unmatchable rather than as a wildcard.
    """
    if not name:
        return ""

    value = _BOARD_NOISE.sub("", name)
    value = strip_accents(value).lower()
    value = _AMPERSAND.sub(" and ", value)
    value = _PUNCT.sub(" ", value)
    value = _WHITESPACE.sub(" ", value).strip()
    value = _collapse_initialisms(value)

    return _strip_trailing_suffixes(value)


def _collapse_initialisms(value: str) -> str:
    """Rejoins runs of single-letter tokens left behind by punctuation stripping.

    "Nestlé S.A." loses its dots and becomes the tokens ``nestle s a``, where the
    legal suffix is no longer recognisable as one. Collapsing consecutive
    single-character tokens restores ``nestle sa``, which handles every dotted
    abbreviation — S.A., L.L.C., B.V., P.L.C. — with one rule instead of an entry
    per spelling.

    Runs of length one are left alone, so "H and M" and "AT and T" are unaffected.
    """
    out: list[str] = []
    run: list[str] = []

    for token in value.split():
        if len(token) == 1:
            run.append(token)
            continue
        if len(run) > 1:
            out.append("".join(run))
        else:
            out.extend(run)
        run = []
        out.append(token)

    if len(run) > 1:
        out.append("".join(run))
    else:
        out.extend(run)

    return " ".join(out)


def _strip_trailing_suffixes(value: str) -> str:
    """Repeatedly removes trailing legal suffixes ("Foo Holdings Ltd" -> "foo").

    Stops before consuming the last remaining token, so a company literally named
    "Group" or "Limited" still normalises to something rather than nothing.
    """
    tokens = value.split()

    changed = True
    while changed and len(tokens) > 1:
        changed = False
        # Try the longest multi-word suffix first ("pvt ltd" before "ltd").
        for size in (3, 2, 1):
            if len(tokens) - size < 1:
                continue
            candidate = " ".join(tokens[-size:])
            if candidate in LEGAL_SUFFIXES:
                tokens = tokens[:-size]
                changed = True
                break

    return " ".join(tokens)


def tokens(name: str) -> list[str]:
    """Normalised token list, used for blocking and token-overlap scoring."""
    normalised = normalize(name)
    return normalised.split() if normalised else []


def is_staffing_agency(name: str) -> bool:
    """True if the name carries a staffing/consultancy marker.

    Used to attach a caveat to the result, never to suppress it — plenty of
    genuine employers have "Consulting" in their name.
    """
    normalised = normalize(name)
    return any(marker in normalised for marker in STAFFING_MARKERS)


def acronym(name: str) -> str:
    """Initials of the normalised tokens, for matching "IBM" to "International
    Business Machines". Only meaningful for multi-token names."""
    parts = tokens(name)
    if len(parts) < 2:
        return ""
    return "".join(part[0] for part in parts)
