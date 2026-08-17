"""Entity resolution between job-board company names and government filings."""

from .matcher import CandidateCompany, Confidence, MatchQuery, MatchResult, resolve, score_pair
from .normalize import is_staffing_agency, normalize, tokens

__all__ = [
    "CandidateCompany",
    "Confidence",
    "MatchQuery",
    "MatchResult",
    "is_staffing_agency",
    "normalize",
    "resolve",
    "score_pair",
    "tokens",
]
