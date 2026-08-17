"""Entity resolution between job-board company names and government filings.

This is the highest-risk subsystem in the project. A wrong match does not fail
loudly — it renders a confident panel showing another company's sponsorship
history, and a candidate makes an immigration-relevant decision on it. Everything
here is built around making that outcome rare and, when it can't be ruled out,
visible.

## The design

* **Score, then band.** Nothing returns a bare boolean. Every match carries a
  0..1 score which the API maps to `high` / `probable` / `possible`, and the
  extension renders `possible` as "verify independently" rather than as a fact.
* **Aliases are first-class.** "Amazon" and "AMAZON.COM SERVICES LLC" are not
  close under any string metric. The fix is curated and ETL-derived aliases, not
  a looser threshold — loosening thresholds is how you match "Apple" to
  "Apple Bank for Savings".
* **Blending, not `token_set_ratio` alone.** `token_set_ratio("apple",
  "apple bank")` is 100, because it scores the intersection. Blending it with
  `token_sort_ratio`, which punishes unmatched tokens, is what stops short brand
  names from matching every longer name that contains them.
* **Only exact-normalised and domain matches can reach `high`.** Fuzzy evidence
  alone is capped below the top band, by construction rather than by tuning.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum

from rapidfuzz import fuzz

from .normalize import acronym, is_staffing_agency, normalize, tokens

# Band thresholds. Anything below MIN_SCORE is not a match at all and must be
# reported as "no record found" rather than as a weak positive.
HIGH_THRESHOLD = 0.95
PROBABLE_THRESHOLD = 0.85
MIN_SCORE = 0.70

# Fuzzy string evidence alone never reaches `high`. Reaching the top band
# requires an exact normalised name or a domain match.
FUZZY_CEILING = 0.94


class Confidence(StrEnum):
    HIGH = "high"
    PROBABLE = "probable"
    POSSIBLE = "possible"

    @classmethod
    def from_score(cls, score: float) -> Confidence:
        if score >= HIGH_THRESHOLD:
            return cls.HIGH
        if score >= PROBABLE_THRESHOLD:
            return cls.PROBABLE
        return cls.POSSIBLE


@dataclass(frozen=True)
class CandidateCompany:
    """A company as it exists in our database, with every name we know it by."""

    id: int
    canonical_name: str
    aliases: tuple[str, ...] = ()
    domains: tuple[str, ...] = ()
    country: str | None = None

    def all_names(self) -> tuple[str, ...]:
        return (self.canonical_name, *self.aliases)


@dataclass(frozen=True)
class MatchQuery:
    """What the extension asked about."""

    name: str
    domain: str | None = None
    country: str | None = None


@dataclass
class MatchResult:
    company: CandidateCompany
    score: float
    confidence: Confidence
    #: Which name (canonical or alias) produced the score, for the "matched X → Y" line.
    matched_on: str
    #: How the score was reached. Surfaced in the API response for debuggability.
    method: str
    #: Non-blocking caveats the UI should show alongside the result.
    warnings: list[str] = field(default_factory=list)


def score_pair(query_name: str, candidate_name: str) -> tuple[float, str]:
    """Scores one name pair, returning the score and the method that produced it.

    The blend is the important part. `token_set_ratio` is generous by design — it
    ignores tokens that appear in only one string — which makes it excellent at
    seeing through legal suffixes and terrible at distinguishing "Apple" from
    "Apple Bank". `token_sort_ratio` penalises exactly those unmatched tokens.
    Weighting the strict metric slightly higher keeps short brand names from
    sweeping up every longer name they are a substring of.
    """
    q_norm = normalize(query_name)
    c_norm = normalize(candidate_name)

    if not q_norm or not c_norm:
        return 0.0, "empty"

    if q_norm == c_norm:
        return 1.0, "exact_normalized"

    generous = max(
        fuzz.token_set_ratio(q_norm, c_norm),
        fuzz.WRatio(q_norm, c_norm),
    ) / 100.0
    strict = fuzz.token_sort_ratio(q_norm, c_norm) / 100.0
    score = 0.45 * generous + 0.55 * strict
    method = "fuzzy"

    # A short brand name that is a leading subsequence of a longer legal name is a
    # common and usually-correct pattern ("Stripe" -> "Stripe Payments Inc"), but
    # it is also how "Apple" reaches "Apple Bank". Worth a bonus, never enough on
    # its own to clear the fuzzy ceiling.
    q_tokens, c_tokens = tokens(query_name), tokens(candidate_name)
    if _is_token_prefix(q_tokens, c_tokens) or _is_token_prefix(c_tokens, q_tokens):
        score += 0.10
        method = "token_prefix"

    # "IBM" vs "International Business Machines". Genuinely useful, and genuinely
    # ambiguous — three-letter acronyms collide constantly, so this is capped low.
    if _acronym_match(query_name, candidate_name):
        score = max(score, 0.86)
        method = "acronym"

    return min(score, FUZZY_CEILING), method


def _is_token_prefix(short: list[str], long: list[str]) -> bool:
    """True if `short` is a non-empty, strictly shorter leading run of `long`."""
    if not short or len(short) >= len(long):
        return False
    return long[: len(short)] == short


def _acronym_match(a: str, b: str) -> bool:
    a_norm, b_norm = normalize(a), normalize(b)
    # Only meaningful when one side is a single compact token and the other expands.
    return bool(
        (acronym(b) and a_norm == acronym(b) and len(a_norm) >= 2)
        or (acronym(a) and b_norm == acronym(a) and len(b_norm) >= 2)
    )


def resolve(query: MatchQuery, candidates: list[CandidateCompany]) -> MatchResult | None:
    """Picks the best candidate for a query, or None if nothing clears MIN_SCORE.

    `candidates` is expected to be a blocked shortlist (see
    `app.resolution.repository`), not the whole table — this function is O(n) in
    the candidate count and is called on the request path.
    """
    query_domain = _clean_domain(query.domain)
    best: MatchResult | None = None

    for candidate in candidates:
        # A domain match is the strongest evidence available: employers control
        # their own domain, and it is not subject to naming drift at all.
        if query_domain and query_domain in {_clean_domain(d) for d in candidate.domains}:
            result = MatchResult(
                company=candidate,
                score=1.0,
                confidence=Confidence.HIGH,
                matched_on=candidate.canonical_name,
                method="domain",
            )
            _attach_warnings(result, query)
            return result

        for name in candidate.all_names():
            score, method = score_pair(query.name, name)
            if best is None or score > best.score:
                best = MatchResult(
                    company=candidate,
                    score=score,
                    confidence=Confidence.from_score(score),
                    matched_on=name,
                    method=method,
                )

    if best is None or best.score < MIN_SCORE:
        return None

    best.confidence = Confidence.from_score(best.score)
    _attach_warnings(best, query)
    return best


def _attach_warnings(result: MatchResult, query: MatchQuery) -> None:
    """Adds non-blocking caveats.

    Staffing agencies are the important one. A consultancy's H-1B volume is real
    data about the consultancy, and says nothing about the client the candidate
    would actually sit with — presenting it without that caveat is misleading even
    when the entity match itself is perfect.
    """
    if is_staffing_agency(result.company.canonical_name) or is_staffing_agency(query.name):
        result.warnings.append("staffing_agency")

    if result.matched_on.lower() != result.company.canonical_name.lower():
        result.warnings.append("matched_via_alias")

    if result.confidence is Confidence.POSSIBLE:
        result.warnings.append("low_confidence")


def _clean_domain(domain: str | None) -> str | None:
    """Reduces a domain to its registrable form for comparison."""
    if not domain:
        return None
    value = domain.strip().lower()
    value = value.removeprefix("https://").removeprefix("http://")
    value = value.removeprefix("www.")
    return value.split("/")[0] or None
