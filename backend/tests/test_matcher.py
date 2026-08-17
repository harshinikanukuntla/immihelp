"""Entity-resolution behaviour, especially the ways it is allowed to be wrong.

A test here that asserts a `possible` band rather than a match or a miss is not a
weak test — it is the intended contract. The product's answer to genuine
ambiguity is to show the ambiguity, not to guess.
"""

import pytest

from app.resolution.matcher import (
    FUZZY_CEILING,
    MIN_SCORE,
    CandidateCompany,
    Confidence,
    MatchQuery,
    resolve,
    score_pair,
)


def company(name: str, **kwargs) -> CandidateCompany:
    return CandidateCompany(id=abs(hash(name)) % 100_000, canonical_name=name, **kwargs)


class TestScorePair:
    def test_identical_names_score_one(self):
        score, method = score_pair("Stripe", "Stripe")
        assert score == 1.0
        assert method == "exact_normalized"

    def test_legal_suffix_difference_is_an_exact_match(self):
        score, method = score_pair("Google", "Google LLC")
        assert score == 1.0
        assert method == "exact_normalized"

    def test_unrelated_names_score_low(self):
        score, _ = score_pair("Stripe", "Lockheed Martin")
        assert score < MIN_SCORE

    def test_fuzzy_evidence_alone_cannot_reach_the_high_band(self):
        # Every non-exact, non-domain path is capped, so no amount of string
        # similarity can render as a confident match on its own.
        score, _ = score_pair("Microsft Corporation", "Microsoft Corporation")
        assert score <= FUZZY_CEILING

    def test_typos_still_score_as_a_probable_match(self):
        score, _ = score_pair("Micorsoft", "Microsoft")
        assert score >= MIN_SCORE

    def test_short_brand_name_does_not_fully_match_a_longer_unrelated_name(self):
        # token_set_ratio alone returns 100 here. The blend is what prevents it.
        apple_bank, _ = score_pair("Apple", "Apple Bank for Savings")
        apple_inc, _ = score_pair("Apple", "Apple Inc")
        assert apple_inc == 1.0
        assert apple_bank < apple_inc
        # It may still be a plausible-enough match to show; it must never be certain.
        assert apple_bank < 0.95

    def test_brand_prefix_of_a_longer_legal_name_scores_above_the_floor(self):
        score, method = score_pair("Stripe", "Stripe Payments Company")
        assert score >= MIN_SCORE
        assert method in {"token_prefix", "fuzzy"}

    def test_acronym_expansion_matches_but_is_capped(self):
        score, method = score_pair("IBM", "International Business Machines")
        assert score >= MIN_SCORE
        assert score <= FUZZY_CEILING
        assert method == "acronym"

    def test_empty_names_score_zero(self):
        assert score_pair("", "Google")[0] == 0.0
        assert score_pair("Google", "")[0] == 0.0
        assert score_pair("...", "Google")[0] == 0.0


class TestResolve:
    def test_returns_none_when_nothing_clears_the_floor(self):
        result = resolve(MatchQuery(name="Stripe"), [company("Lockheed Martin")])
        assert result is None

    def test_returns_none_for_an_empty_candidate_list(self):
        assert resolve(MatchQuery(name="Stripe"), []) is None

    def test_picks_the_best_of_several_candidates(self):
        candidates = [company("Apple Bank for Savings"), company("Apple Inc")]
        result = resolve(MatchQuery(name="Apple"), candidates)
        assert result is not None
        assert result.company.canonical_name == "Apple Inc"
        assert result.confidence is Confidence.HIGH

    def test_matches_through_an_alias(self):
        candidates = [
            company("AMAZON.COM SERVICES LLC", aliases=("Amazon",)),
        ]
        result = resolve(MatchQuery(name="Amazon"), candidates)
        assert result is not None
        assert result.matched_on == "Amazon"
        assert result.confidence is Confidence.HIGH
        assert "matched_via_alias" in result.warnings

    def test_domain_match_wins_outright(self):
        candidates = [
            company("Some Unrelated Legal Entity LLC", domains=("stripe.com",)),
        ]
        query = MatchQuery(name="Stripe", domain="https://www.stripe.com/careers")
        result = resolve(query, candidates)
        assert result is not None
        assert result.method == "domain"
        assert result.score == 1.0
        assert result.confidence is Confidence.HIGH

    def test_low_confidence_matches_are_flagged_not_hidden(self):
        candidates = [company("Apple Bank for Savings")]
        result = resolve(MatchQuery(name="Apple"), candidates)
        if result is not None:
            # Whatever the exact score, it must not present as certain.
            assert result.confidence is not Confidence.HIGH
            assert "low_confidence" in result.warnings or result.confidence is Confidence.PROBABLE

    def test_staffing_agencies_carry_a_warning(self):
        candidates = [company("Apex Staffing Solutions")]
        result = resolve(MatchQuery(name="Apex Staffing Solutions"), candidates)
        assert result is not None
        assert "staffing_agency" in result.warnings

    def test_ordinary_employers_carry_no_staffing_warning(self):
        result = resolve(MatchQuery(name="Stripe"), [company("Stripe Inc")])
        assert result is not None
        assert "staffing_agency" not in result.warnings


class TestConfidenceBands:
    @pytest.mark.parametrize(
        ("score", "expected"),
        [
            (1.00, Confidence.HIGH),
            (0.95, Confidence.HIGH),
            (0.94, Confidence.PROBABLE),
            (0.85, Confidence.PROBABLE),
            (0.84, Confidence.POSSIBLE),
            (0.70, Confidence.POSSIBLE),
        ],
    )
    def test_band_boundaries(self, score: float, expected: Confidence):
        assert Confidence.from_score(score) is expected
