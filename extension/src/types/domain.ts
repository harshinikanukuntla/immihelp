/**
 * Domain types shared by the content scripts, the service worker, and the
 * options page. These mirror the backend's response schema (`backend/app/schemas.py`);
 * see docs/adding-a-country.md for the contract both sides agree on.
 */

/** ISO 3166-1 alpha-2, plus a sentinel for postings we could not localise. */
export type CountryCode = string;

/** Which government register a figure came from. */
export type SourceId = 'uscis_h1b_hub' | 'dol_oflc_perm' | 'dol_oflc_lca' | 'uk_sponsor_register' | 'esdc_lmia';

export interface SourceAttribution {
  id: SourceId;
  /** Human-readable, shown verbatim in the panel: "USCIS H-1B Employer Data Hub". */
  label: string;
  /** Publisher shorthand used in the "source:" line: "USCIS", "UKVI", "ESDC". */
  publisher: string;
  /** ISO date the underlying dataset was published by its publisher. */
  publishedDate: string;
  url: string;
}

/**
 * Confidence band for the entity-resolution match between the company name as it
 * appears on the job board and the legal name in government filings.
 *
 * This distinction is the single highest-impact failure mode in the product: a
 * subsidiary, staffing agency, or differing legal entity name can silently
 * produce a confident-looking wrong answer. The band is always surfaced in the UI.
 */
export type MatchConfidence = 'high' | 'probable' | 'possible';

export interface CompanyMatch {
  /** Canonical legal name as it appears in the government data. */
  canonicalName: string;
  /** The name we were given from the job board, echoed back for the "we matched X → Y" line. */
  queriedName: string;
  /** 0..1. Bands: >=0.95 high, >=0.85 probable, >=0.70 possible. Below 0.70 is not returned. */
  score: number;
  confidence: MatchConfidence;
  /** How the match was reached: "exact_normalized", "domain", "token_prefix", "acronym", "fuzzy". */
  method: string;
  /**
   * Non-blocking caveats the panel renders alongside the figures:
   * `staffing_agency`, `matched_via_alias`, `low_confidence`.
   */
  warnings: string[];
}

/** One country's sponsorship picture for a matched company. */
export interface SponsorshipRecord {
  country: CountryCode;
  /**
   * Aggregate counts keyed by metric. Metric names are country-specific and
   * documented in docs/data-sources.md — e.g. `h1b_initial_approvals`,
   * `perm_certified`, `lmia_positive_positions`.
   */
  metrics: Record<string, number>;
  /** Fiscal or calendar years covered, ascending. */
  years: number[];
  sources: SourceAttribution[];
}

/**
 * The four states the sponsorship panel can be in.
 *
 * `no_record` and `does_not_sponsor` are deliberately separate variants rather
 * than one nullable field. Absence of a filing is not evidence of a policy, and
 * collapsing them would make the UI imply otherwise.
 */
export type SponsorshipVerdict =
  | { kind: 'verified'; match: CompanyMatch; records: SponsorshipRecord[] }
  | { kind: 'no_record'; queriedName: string; countriesChecked: CountryCode[] }
  | { kind: 'does_not_sponsor'; match: CompanyMatch; sources: SourceAttribution[]; note: string }
  | { kind: 'error'; message: string };

/** Result of the on-page phrase scan (Feature 1b). Never presented as verified. */
export interface PostingSignal {
  /** `positive` = the posting states sponsorship is available. */
  polarity: 'positive' | 'negative' | 'none';
  /** The matched sentence, trimmed, for display as evidence. Never fabricated. */
  evidence: string[];
  /** Which cue fired, for debugging and for the test suite. */
  cues: string[];
}

/**
 * Result of a resume comparison. Both scores are computed on-device.
 *
 * Two numbers because they measure different things and their disagreement is
 * informative. `ats` is deterministic keyword coverage — what screening software
 * checks. `semantic` is meaning-level similarity — it can see that "built
 * distributed systems" answers "scalable backend architecture", which keyword
 * matching cannot.
 */
export interface ResumeAnalysis {
  ats: AtsResult;
  semantic: ResumeMatch | null;
}

export interface AtsResult {
  score: number;
  band: 'strong' | 'moderate' | 'weak';
  matched: string[];
  missing: Array<{ term: string; weight: number; occurrences: number; inRequirements: boolean }>;
  suggestions: Array<{
    term: string;
    projectedScore: number;
    gain: number;
    inRequirements: boolean;
  }>;
  totalTerms: number;
  matchedTerms: number;
  /** Score if every suggestion were addressed. Not the sum of the gains. */
  projectedAll: number;
  summary: string;
}

/** On-device resume-to-JD similarity (Feature 2). Never leaves the machine. */
export interface ResumeMatch {
  /** 0..100, derived from cosine similarity — see lib/resume-match.ts for the mapping. */
  score: number;
  band: 'strong' | 'moderate' | 'weak';
  /** Plain-language rationale. Locally generated in v1. */
  rationale: string;
  /** Terms present in the JD with no near-equivalent in the resume. */
  gaps: string[];
}

/** What an adapter extracts from a page. */
export interface PageContext {
  board: string;
  pageType: 'job_posting' | 'company';
  company: { name: string; /** LinkedIn company slug, when the page gives us one. */ slug?: string };
  /** Full job description text. Absent on company pages. */
  jobDescription?: string;
  jobTitle?: string;
  /** Best-effort country for the posting, used to pick which registers to check. */
  country?: CountryCode;
  /** Stable key for caching and for de-duplicating re-renders on SPA navigation. */
  key: string;
}
