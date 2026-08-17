"""Normalisation must strip noise without merging distinct employers.

The asymmetry matters: over-stripping causes false merges, which surface as
another company's sponsorship history shown under this company's name.
"""

from app.resolution.normalize import (
    acronym,
    is_staffing_agency,
    normalize,
    strip_accents,
    tokens,
)


class TestNormalize:
    def test_lowercases_and_collapses_whitespace(self):
        assert normalize("  Acme   Systems  ") == "acme systems"

    def test_strips_trailing_legal_suffix(self):
        assert normalize("Google LLC") == "google"
        assert normalize("Stripe, Inc.") == "stripe"
        assert normalize("Deutsche Bank AG") == "deutsche bank"
        assert normalize("Infosys Pvt Ltd") == "infosys"

    def test_strips_stacked_suffixes(self):
        assert normalize("Example Holdings Limited") == "example"
        assert normalize("Foo Group PLC") == "foo"

    def test_does_not_strip_a_suffix_word_that_leads_the_name(self):
        # "Limited Brands" is a real retailer; stripping its first token would
        # merge it with anything else that normalises to "brands".
        assert normalize("Limited Brands") == "limited brands"

    def test_never_strips_the_last_remaining_token(self):
        assert normalize("Group") == "group"
        assert normalize("Limited") == "limited"

    def test_folds_accents(self):
        assert normalize("Nestlé S.A.") == normalize("Nestle SA")

    def test_collapses_dotted_initialisms_so_suffixes_are_recognisable(self):
        # Punctuation stripping turns "L.L.C." into three single-letter tokens;
        # without recombining them the legal suffix survives into the comparison.
        assert normalize("Acme L.L.C.") == "acme"
        assert normalize("Acme B.V.") == "acme"
        assert normalize("Acme P.L.C.") == "acme"

    def test_does_not_merge_isolated_single_letter_tokens(self):
        # A lone single-letter token is meaningful; only runs are initialisms.
        assert normalize("H and M") == "h and m"
        assert normalize("AT&T") == "at and t"

    def test_normalises_ampersand_to_and(self):
        assert normalize("Johnson & Johnson") == normalize("Johnson and Johnson")

    def test_strips_job_board_decoration(self):
        assert normalize("Shopify | Careers") == "shopify"
        assert normalize("Acme - Hiring") == "acme"

    def test_empty_input_yields_empty_output(self):
        assert normalize("") == ""
        assert normalize("   ") == ""
        assert normalize("...") == ""

    def test_distinct_companies_stay_distinct(self):
        # The failure this whole module exists to prevent.
        assert normalize("Apple Inc") != normalize("Apple Bank for Savings")
        assert normalize("Delta Air Lines") != normalize("Delta Dental")


class TestStripAccents:
    def test_removes_combining_marks(self):
        assert strip_accents("Zürich") == "Zurich"
        assert strip_accents("São Paulo") == "Sao Paulo"


class TestTokens:
    def test_returns_normalised_tokens(self):
        assert tokens("Acme Systems, Inc.") == ["acme", "systems"]

    def test_empty_name_yields_no_tokens(self):
        assert tokens("") == []


class TestAcronym:
    def test_builds_initials_from_multi_token_names(self):
        assert acronym("International Business Machines") == "ibm"

    def test_single_token_names_have_no_acronym(self):
        assert acronym("Google") == ""


class TestStaffingDetection:
    def test_flags_staffing_intermediaries(self):
        assert is_staffing_agency("Apex Staffing Solutions")
        assert is_staffing_agency("Global IT Services LLC")
        assert is_staffing_agency("TechCorp Recruitment")

    def test_does_not_flag_ordinary_employers(self):
        assert not is_staffing_agency("Stripe")
        assert not is_staffing_agency("Deutsche Bank AG")
