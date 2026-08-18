/**
 * ATS-style keyword analysis.
 *
 * ## What an ATS actually does, and why this is not the semantic score
 *
 * An Applicant Tracking System is the software an employer uses to store and
 * filter applications. When people say "ATS score" they mean something
 * mechanical: the posting names some skills, the system checks which of them
 * appear in your resume, and ranks you by how many matched. It is closer to
 * Ctrl-F than to understanding.
 *
 * That mechanical quality is exactly why it belongs here, and why it replaces
 * the semantic similarity number as the headline figure:
 *
 * - **It is deterministic.** The same resume and the same posting always produce
 *   the same number. The semantic score did not have this property in practice,
 *   and a fit score that changes when you refresh the page is worse than no
 *   score, because it teaches you not to trust the tool.
 * - **It is explainable.** "72%" means "you matched 18 of the 25 terms this
 *   posting emphasises, and here are the 7 you missed." A cosine similarity of
 *   0.61 means nothing to anyone.
 * - **The advice is arithmetic, not opinion.** "Adding Kubernetes takes you from
 *   72% to 78%" is computed by adding that term's weight to the numerator. It is
 *   a fact about the scoring function, not a guess.
 *
 * The semantic score is kept alongside, because keyword matching is genuinely
 * blind to meaning — it cannot tell that "built distributed systems" answers a
 * requirement for "scalable backend architecture". The two measure different
 * things and disagreeing is informative.
 *
 * ## What this is not
 *
 * It is not the employer's real ATS. Every vendor scores differently and none
 * publish their algorithm. This is a reasonable model of the common behaviour,
 * and the UI says so.
 */

/** Words that appear in every job posting and predict nothing about fit. */
const STOPWORDS = new Set(
  (
    'a an the and or but if then than that this these those with without within for from to of in ' +
    'on at by as is are was were be been being have has had do does did will would can could should ' +
    'may might must you your our we us they their it its not no yes about into over under more most ' +
    'other some such only own same so too very just also across per via using use used work working ' +
    'works role roles team teams company companies year years experience experienced strong excellent ' +
    'good ability able help helps helping including include includes new great looking join joining ' +
    'candidate candidates applicant applicants position positions job jobs opportunity opportunities ' +
    'responsibilities requirements qualifications preferred required plus benefits salary apply ' +
    'who what when where how why all any each both few many much need needs will well like ' +
    'you\'ll we\'re it\'s day days week weeks month months time times end ensure ensuring across ' +
    'while during between through here there make makes making take takes look looks based upon ' +
    'etc eg ie inc llc ltd corp'
  ).split(' '),
);

/**
 * Sections whose contents are the actual requirements.
 *
 * A term repeated in the requirements list matters more than one mentioned once
 * in the company boilerplate, so terms found after these headings are weighted
 * up. This is a rough proxy for what a recruiter is actually screening on.
 */
const REQUIREMENT_HEADINGS =
  /\b(requirements?|qualifications?|what you.{0,3}ll (?:need|bring|do)|who you are|must have|we.{0,3}re looking for|skills?|about you|basic qualifications?|minimum qualifications?)\b/i;

const REQUIREMENT_WEIGHT = 2;
const BODY_WEIGHT = 1;

/** Terms shorter than this are noise unless they look like a technology. */
const MIN_TERM_LENGTH = 2;

export interface KeywordGap {
  term: string;
  /** Total weight this term contributes to the score. */
  weight: number;
  /** How many times the posting mentions it. */
  occurrences: number;
  /** True if it appeared under a requirements-style heading. */
  inRequirements: boolean;
}

export interface Suggestion {
  term: string;
  /** Score if this term alone were added, holding everything else constant. */
  projectedScore: number;
  /** Percentage points gained. */
  gain: number;
  inRequirements: boolean;
}

export interface AtsAnalysis {
  /** 0–100. Deterministic for a given (resume, posting) pair. */
  score: number;
  band: 'strong' | 'moderate' | 'weak';
  /** Terms the posting emphasises that the resume already covers. */
  matched: string[];
  /** Terms the posting emphasises that the resume never mentions, ranked. */
  missing: KeywordGap[];
  /** The highest-impact additions, with the exact score each would produce. */
  suggestions: Suggestion[];
  /** How many weighted terms were considered. */
  totalTerms: number;
  matchedTerms: number;
  /** Denominator and numerator of the score, kept so projections are exact. */
  totalWeight: number;
  matchedWeight: number;
  summary: string;
}

/**
 * Splits text into comparable terms.
 *
 * Keeps the punctuation that lives inside technology names, so "node.js",
 * "c++", "ci/cd", and "h-1b" survive as single terms rather than being shredded
 * into meaningless fragments.
 */
export function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[a-z][a-z0-9+#./-]*[a-z0-9+#]|[a-z]+/g) ?? [];
  return matches
    .map((term) => term.replace(/^[.\-/]+|[.\-/]+$/g, ''))
    .filter((term) => term.length >= MIN_TERM_LENGTH);
}

/** Single words plus adjacent pairs, so "machine learning" is one term, not two. */
function candidateTerms(tokens: string[]): string[] {
  const terms: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const word = tokens[i]!;
    if (!STOPWORDS.has(word)) terms.push(word);

    const next = tokens[i + 1];
    // A bigram is only meaningful if neither half is filler.
    if (next && !STOPWORDS.has(word) && !STOPWORDS.has(next)) {
      terms.push(`${word} ${next}`);
    }
  }

  return terms;
}

/**
 * Builds the weighted vocabulary the posting is screening on.
 *
 * Weight combines how often a term appears with whether it appears under a
 * requirements heading. Both are proxies for "how much the employer cares".
 */
function postingVocabulary(jobDescription: string): Map<string, KeywordGap> {
  const vocabulary = new Map<string, KeywordGap>();
  const lines = jobDescription.split('\n');

  let inRequirements = false;
  for (const line of lines) {
    if (REQUIREMENT_HEADINGS.test(line)) inRequirements = true;
    // A short all-caps or title-case line that is not a requirements heading
    // usually starts a different section.
    else if (/^[A-Z][^.!?]{0,60}:?$/.test(line.trim()) && line.trim().length < 60) {
      inRequirements = false;
    }

    for (const term of candidateTerms(tokenize(line))) {
      const existing = vocabulary.get(term);
      if (existing) {
        existing.occurrences += 1;
        existing.inRequirements ||= inRequirements;
      } else {
        vocabulary.set(term, {
          term,
          weight: 0,
          occurrences: 1,
          inRequirements,
        });
      }
    }
  }

  for (const entry of vocabulary.values()) {
    entry.weight =
      entry.occurrences * (entry.inRequirements ? REQUIREMENT_WEIGHT : BODY_WEIGHT);
  }

  return vocabulary;
}

/**
 * Drops terms too rare or too generic to be worth scoring against.
 *
 * Without this the denominator fills with words mentioned once in the company's
 * mission statement, and the score measures prose overlap rather than fit.
 */
function significantTerms(vocabulary: Map<string, KeywordGap>): KeywordGap[] {
  const entries = [...vocabulary.values()];

  const worthwhile = entries.filter(
    (entry) => entry.occurrences >= 2 || entry.inRequirements || entry.term.includes(' '),
  );

  return worthwhile
    .sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term))
    // A posting screens on a few dozen things, not hundreds. Capping keeps the
    // denominator stable and the missing list actionable.
    .slice(0, 40);
}

/** The resume, prepared once so every term lookup is a set membership test. */
interface ResumeIndex {
  tokens: Set<string>;
  bigrams: Set<string>;
  raw: string;
}

function indexResume(resumeText: string): ResumeIndex {
  const tokens = tokenize(resumeText);
  const bigrams = new Set<string>();

  for (let i = 0; i < tokens.length - 1; i++) {
    bigrams.add(`${tokens[i]} ${tokens[i + 1]}`);
  }

  return { tokens: new Set(tokens), bigrams, raw: resumeText.toLowerCase() };
}

/**
 * True if the resume covers a term.
 *
 * Phrases are checked against the resume's own bigrams *and* its raw text. The
 * bigram check matters because both sides drop filler when forming phrases:
 * "building a distributed platform" yields the term "building distributed", and
 * a raw substring search for that phrase would never match the text it came
 * from. Raw containment is kept as well, so a resume saying "machine learning
 * engineer" still satisfies "machine learning".
 *
 * Single words use exact token matching, never substrings — otherwise
 * "javascript" would satisfy a requirement for "java", which is the classic
 * keyword-matching false positive.
 */
function resumeCovers(term: string, resume: ResumeIndex): boolean {
  if (term.includes(' ')) return resume.bigrams.has(term) || resume.raw.includes(term);
  return resume.tokens.has(term);
}

export function analyzeAts(resumeText: string, jobDescription: string): AtsAnalysis {
  const vocabulary = postingVocabulary(jobDescription);
  const terms = significantTerms(vocabulary);

  const resume = indexResume(resumeText);

  const matched: KeywordGap[] = [];
  const missing: KeywordGap[] = [];

  for (const entry of terms) {
    if (resumeCovers(entry.term, resume)) matched.push(entry);
    else missing.push(entry);
  }

  const totalWeight = terms.reduce((sum, entry) => sum + entry.weight, 0);
  const matchedWeight = matched.reduce((sum, entry) => sum + entry.weight, 0);
  const score = totalWeight === 0 ? 0 : Math.round((matchedWeight / totalWeight) * 100);

  // Each suggestion's projected score is the real arithmetic: what the score
  // becomes if that term's weight moves from the missing pile to the matched
  // pile. Nothing here is estimated.
  const suggestions: Suggestion[] = missing.slice(0, 5).map((entry) => {
    const projected =
      totalWeight === 0 ? 0 : Math.round(((matchedWeight + entry.weight) / totalWeight) * 100);
    return {
      term: entry.term,
      projectedScore: projected,
      gain: projected - score,
      inRequirements: entry.inRequirements,
    };
  });

  return {
    score,
    band: score >= 70 ? 'strong' : score >= 45 ? 'moderate' : 'weak',
    matched: matched.map((entry) => entry.term),
    missing,
    suggestions,
    totalTerms: terms.length,
    matchedTerms: matched.length,
    totalWeight,
    matchedWeight,
    summary: buildSummary(score, matched.length, terms.length, suggestions),
  };
}

function buildSummary(
  score: number,
  matchedCount: number,
  totalCount: number,
  suggestions: Suggestion[],
): string {
  if (totalCount === 0) {
    return 'This posting does not have enough detail to compare against.';
  }

  const parts = [
    `Your resume covers ${matchedCount} of the ${totalCount} terms this posting emphasises (${score}%).`,
  ];

  if (suggestions.length > 0) {
    const best = suggestions[0]!;
    parts.push(
      `Adding “${best.term}” alone would take it to ${best.projectedScore}%.`,
    );
  }

  const ceiling = suggestions.length > 0 ? suggestions.at(-1)!.projectedScore : score;
  if (suggestions.length > 1 && ceiling > score) {
    parts.push('Covering all five suggestions below would raise it further.');
  }

  parts.push('This models common keyword screening, not any specific employer’s system.');
  return parts.join(' ');
}

/**
 * Score if every suggested term were added at once.
 *
 * Not the sum of the individual gains: all five share one denominator, so adding
 * five terms is a single larger numerator, not five independent jumps. Showing
 * the summed per-term gains would overstate the ceiling.
 */
export function projectedScoreWithAll(analysis: AtsAnalysis): number {
  if (analysis.totalWeight === 0) return analysis.score;

  const suggestedWeight = analysis.suggestions.reduce((sum, suggestion) => {
    const gap = analysis.missing.find((entry) => entry.term === suggestion.term);
    return sum + (gap?.weight ?? 0);
  }, 0);

  return Math.round(
    ((analysis.matchedWeight + suggestedWeight) / analysis.totalWeight) * 100,
  );
}
