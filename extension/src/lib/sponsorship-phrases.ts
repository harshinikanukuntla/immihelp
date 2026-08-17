/**
 * Feature 1b — sponsorship detection from the job posting's own text.
 *
 * This runs only where no government register covers the country, and its output
 * is always labelled "mentioned in this posting — not independently verified".
 *
 * ## Why this is not keyword matching
 *
 * "We do not offer visa sponsorship" and "We offer visa sponsorship" share every
 * keyword that matters. A presence check reports both as positive, which is the
 * worst possible failure here: it tells a visa-constrained candidate to spend an
 * application on a role that will reject them at the screening question.
 *
 * ## The model
 *
 * 1. Text is split into clauses. Negation does not cross a sentence, a semicolon,
 *    or a contrastive conjunction, so clause boundaries scope the whole analysis.
 * 2. Each clause is scanned for *anchors* — phrases that make the clause about
 *    work authorisation at all. Anchors carry a base polarity:
 *      - **offer** anchors ("sponsorship", "relocation package") are positive
 *        unless negated: "no visa sponsorship" → negative.
 *      - **requirement** anchors ("right to work", "work authorization") are
 *        negative unless negated: "right to work not required" → positive.
 *    Two anchor classes, rather than one keyword list, is what makes both of the
 *    brief's required cases come out right without special-casing either.
 * 3. Negation cues are searched in a token window around the anchor, bounded by
 *    intra-clause punctuation. A comma stops the scan, so the "cannot" in
 *    "Although we cannot offer relocation, visa sponsorship is available" does
 *    not bleed onto the sponsorship anchor.
 * 4. A short list of explicit multi-word patterns runs at a higher weight than
 *    any anchor, catching constructions whose negation sits too far from the
 *    anchor for a tight window ("Sponsorship, unfortunately, is not available").
 * 5. Signals are aggregated by weight; sponsorship-explicit language outranks
 *    the weak relocation proxy. Ties resolve to negative — over-claiming
 *    sponsorship is the more costly error.
 *
 * Interrogative clauses are ignored outright. "Will you now or in the future
 * require visa sponsorship?" is a screening question, not an offer, and it is one
 * of the most common sponsorship-adjacent sentences on the entire internet.
 */
import type { PostingSignal } from '../types/domain';

type AnchorKind = 'offer' | 'requirement';

interface Anchor {
  /** Lowercased token sequence to match. */
  tokens: string[];
  kind: AnchorKind;
  /** Higher weight wins during aggregation. */
  weight: number;
  /** Label recorded in `cues`, for tests and debugging. */
  id: string;
}

/**
 * Offer anchors read positive on their own; requirement anchors read negative on
 * their own. Weights: sponsorship-explicit language is 3, work-authorisation
 * language is 2, relocation is 1 — relocation is only ever a weak proxy and must
 * never outvote an explicit statement about sponsorship.
 */
const ANCHORS: Anchor[] = [
  // --- Offer anchors (base positive) -----------------------------------------
  { id: 'sponsorship', tokens: ['sponsorship'], kind: 'offer', weight: 3 },
  { id: 'sponsor', tokens: ['sponsor'], kind: 'offer', weight: 3 },
  { id: 'sponsors', tokens: ['sponsors'], kind: 'offer', weight: 3 },
  { id: 'sponsoring', tokens: ['sponsoring'], kind: 'offer', weight: 3 },
  { id: 'sponsored', tokens: ['sponsored'], kind: 'offer', weight: 3 },
  { id: 'visa-support', tokens: ['visa', 'support'], kind: 'offer', weight: 3 },
  { id: 'visa-assistance', tokens: ['visa', 'assistance'], kind: 'offer', weight: 3 },
  { id: 'relocation-package', tokens: ['relocation', 'package'], kind: 'offer', weight: 1 },
  { id: 'relocation-assistance', tokens: ['relocation', 'assistance'], kind: 'offer', weight: 1 },
  { id: 'relocation-support', tokens: ['relocation', 'support'], kind: 'offer', weight: 1 },
  { id: 'relocation', tokens: ['relocation'], kind: 'offer', weight: 1 },

  // --- Requirement anchors (base negative) -----------------------------------
  { id: 'right-to-work', tokens: ['right', 'to', 'work'], kind: 'requirement', weight: 2 },
  { id: 'authorized-to-work', tokens: ['authorized', 'to', 'work'], kind: 'requirement', weight: 2 },
  { id: 'authorised-to-work', tokens: ['authorised', 'to', 'work'], kind: 'requirement', weight: 2 },
  { id: 'work-authorization', tokens: ['work', 'authorization'], kind: 'requirement', weight: 2 },
  { id: 'work-authorisation', tokens: ['work', 'authorisation'], kind: 'requirement', weight: 2 },
  { id: 'eligible-to-work', tokens: ['eligible', 'to', 'work'], kind: 'requirement', weight: 2 },
  { id: 'entitled-to-work', tokens: ['entitled', 'to', 'work'], kind: 'requirement', weight: 2 },
  { id: 'work-permit', tokens: ['work', 'permit'], kind: 'requirement', weight: 2 },
  { id: 'existing-visa', tokens: ['existing', 'visa'], kind: 'requirement', weight: 2 },
  { id: 'valid-visa', tokens: ['valid', 'visa'], kind: 'requirement', weight: 2 },
];

/** Longest anchors first, so "work authorization" is never shadowed by a shorter overlap. */
const ANCHORS_BY_LENGTH = [...ANCHORS].sort((a, b) => b.tokens.length - a.tokens.length);

/**
 * Tokens that flip an anchor's base polarity when found in its window.
 * Contractions are listed literally because the tokenizer preserves apostrophes.
 */
const NEGATION_CUES = new Set([
  'not',
  "don't",
  "doesn't",
  "won't",
  "can't",
  "cannot",
  "isn't",
  "aren't",
  "wasn't",
  "weren't",
  "couldn't",
  'no',
  'never',
  'without',
  'unable',
  'ineligible',
  'unfortunately',
  'excluded',
  'denied',
  'lacking',
  'preclude',
  'precludes',
]);

/** Punctuation tokens that stop a negation scan inside a clause. */
const BARRIERS = new Set([',', ';', ':', '—', '–', '(', ')']);

const WINDOW_BACK = 5;
const WINDOW_FORWARD = 5;

/**
 * Explicit constructions whose negation sits further from the anchor than a tight
 * window can reach. These run at weight 4 so they outrank every anchor signal.
 *
 * Each pattern is anchored on sponsorship/work-authorisation vocabulary and uses a
 * bounded, non-greedy gap that cannot cross a sentence boundary.
 */
const HARD_PATTERNS: Array<{ id: string; re: RegExp; polarity: 'positive' | 'negative' }> = [
  // --- Negative ---------------------------------------------------------------
  {
    id: 'hard:sponsorship-not-available',
    re: /\bsponsorship\b[^.!?\n]{0,40}?\b(?:is|are|will\s+be|can\s+be)?\s*not\s+(?:be\s+)?(?:available|offered|provided|possible|considered|supported)\b/i,
    polarity: 'negative',
  },
  {
    id: 'hard:without-sponsorship',
    re: /\bwithout\s+(?:the\s+)?(?:need|requirement)?\s*(?:for|of)?\s*(?:visa\s+|employer\s+|company\s+)?sponsorship\b/i,
    polarity: 'negative',
  },
  {
    id: 'hard:unable-to-sponsor',
    re: /\b(?:unable|not\s+able|not\s+in\s+a\s+position|do\s+not\s+intend)\s+to\s+(?:offer|provide|support|sponsor)\b/i,
    polarity: 'negative',
  },
  {
    id: 'hard:do-not-sponsor',
    re: /\b(?:do|does|will|can)\s+not\b[^.!?\n]{0,30}?\bsponsor(?:ship)?\b/i,
    polarity: 'negative',
  },
  {
    id: 'hard:no-sponsorship',
    re: /\bno\s+(?:visa\s+|employment\s+|employer\s+)?sponsorship\b/i,
    polarity: 'negative',
  },
  {
    id: 'hard:must-already-hold',
    re: /\bmust\s+(?:already\s+)?(?:have|possess|hold|be)\b[^.!?\n]{0,50}?\b(?:right\s+to\s+work|work\s+authorization|work\s+authorisation|work\s+permit|valid\s+visa|existing\s+visa)\b/i,
    polarity: 'negative',
  },
  {
    id: 'hard:requiring-sponsorship-not-considered',
    re: /\b(?:requiring|require|requires|needing)\s+(?:visa\s+)?sponsorship\b[^.!?\n]{0,40}?\b(?:not|cannot|won't|will\s+not|unable)\b/i,
    polarity: 'negative',
  },

  // --- Positive ---------------------------------------------------------------
  {
    id: 'hard:sponsorship-available',
    re: /\b(?:visa\s+|employment\s+|employer\s+)?sponsorship\b[^.!?\n]{0,30}?\b(?:is|are|will\s+be)?\s*(?:available|offered|provided|possible|supported)\b/i,
    polarity: 'positive',
  },
  {
    id: 'hard:willing-to-sponsor',
    re: /\b(?:open|happy|willing|able|prepared|glad)\s+to\s+sponsor(?:ing)?\b/i,
    polarity: 'positive',
  },
  {
    id: 'hard:we-sponsor',
    re: /\b(?:we|our\s+(?:company|team)|the\s+company|employer)\s+(?:do\s+|does\s+|can\s+|will\s+|regularly\s+)?sponsors?\b(?!\s+(?:events|conferences|meetups))/i,
    polarity: 'positive',
  },
  {
    id: 'hard:rtw-not-required',
    re: /\b(?:right\s+to\s+work|work\s+authorization|work\s+authorisation|work\s+permit)\b[^.!?\n]{0,25}?\bnot\s+(?:be\s+)?(?:required|necessary|needed)\b/i,
    polarity: 'positive',
  },
  {
    id: 'hard:will-assist-permit',
    re: /\b(?:obtain|provide|arrange|assist\s+with|help\s+with|support\s+with)\s+(?:a\s+|the\s+|your\s+)?(?:work\s+permit|work\s+visa|visa)\b/i,
    polarity: 'positive',
  },
];

interface Clause {
  /** Original text, preserved for display as evidence. Never paraphrased. */
  original: string;
  lower: string;
  interrogative: boolean;
}

/**
 * Splits text into negation-scoping clauses.
 *
 * Boundaries are sentence terminators, newlines, semicolons, and contrastive
 * conjunctions preceded by a comma. Plain commas are deliberately *not*
 * boundaries — splitting "Sponsorship, unfortunately, is not available" into
 * three fragments would strand the anchor in a clause with no negation at all.
 * Commas still act as barriers inside the negation window (see `BARRIERS`).
 */
export function splitClauses(text: string): Clause[] {
  const clauses: Clause[] = [];
  // Capture the terminator so interrogatives can be identified and dropped.
  const sentences = text.split(/(?<=[.!?])\s+|\n+/);

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;
    const interrogative = /\?\s*$/.test(trimmed);

    for (const part of trimmed.split(/;|,\s+(?:but|however|although|though|whereas|while)\b/i)) {
      const piece = part.trim();
      if (piece.length < 3) continue;
      clauses.push({ original: piece, lower: piece.toLowerCase(), interrogative });
    }
  }
  return clauses;
}

/**
 * Tokenizes a clause into words plus the punctuation marks that act as negation
 * barriers. Hyphens and apostrophes stay inside words so "h-1b" and "doesn't"
 * survive as single tokens.
 */
export function tokenize(lower: string): string[] {
  return lower.match(/[a-z0-9][a-z0-9'’\-]*|[,;:—–()]/g) ?? [];
}

/** True if a negation cue sits within the anchor's window, without crossing a barrier. */
function isNegated(tokens: string[], start: number, end: number): boolean {
  for (let i = start - 1; i >= Math.max(0, start - WINDOW_BACK); i--) {
    const token = tokens[i];
    if (token === undefined || BARRIERS.has(token)) break;
    if (NEGATION_CUES.has(normaliseApostrophes(token))) return true;
  }
  for (let i = end + 1; i <= Math.min(tokens.length - 1, end + WINDOW_FORWARD); i++) {
    const token = tokens[i];
    if (token === undefined || BARRIERS.has(token)) break;
    if (NEGATION_CUES.has(normaliseApostrophes(token))) return true;
  }
  return false;
}

/** Curly apostrophes appear constantly in pasted job descriptions. */
function normaliseApostrophes(token: string): string {
  return token.replace(/’/g, "'");
}

interface Signal {
  polarity: 'positive' | 'negative';
  weight: number;
  cue: string;
  evidence: string;
}

function matchAnchorsInClause(clause: Clause): Signal[] {
  const tokens = tokenize(clause.lower);
  const signals: Signal[] = [];
  /** Token indices already claimed by a longer anchor. */
  const consumed = new Set<number>();

  for (const anchor of ANCHORS_BY_LENGTH) {
    for (let i = 0; i + anchor.tokens.length <= tokens.length; i++) {
      let hit = true;
      for (let j = 0; j < anchor.tokens.length; j++) {
        if (tokens[i + j] !== anchor.tokens[j] || consumed.has(i + j)) {
          hit = false;
          break;
        }
      }
      if (!hit) continue;

      const end = i + anchor.tokens.length - 1;
      for (let j = i; j <= end; j++) consumed.add(j);

      const negated = isNegated(tokens, i, end);
      const base = anchor.kind === 'offer' ? 'positive' : 'negative';
      const polarity: 'positive' | 'negative' = negated
        ? base === 'positive'
          ? 'negative'
          : 'positive'
        : base;

      signals.push({
        polarity,
        weight: anchor.weight,
        cue: `${anchor.id}${negated ? ':negated' : ''}`,
        evidence: clause.original,
      });
    }
  }
  return signals;
}

function matchHardPatterns(clause: Clause): Signal[] {
  const signals: Signal[] = [];
  for (const pattern of HARD_PATTERNS) {
    if (pattern.re.test(clause.original)) {
      signals.push({
        polarity: pattern.polarity,
        weight: 4,
        cue: pattern.id,
        evidence: clause.original,
      });
    }
  }
  return signals;
}

/**
 * Scans a job description for sponsorship statements.
 *
 * Returns `polarity: 'none'` when the posting simply does not discuss work
 * authorisation, which is the common case and must never be rendered as a
 * negative signal.
 */
export function detectSponsorshipSignal(jobDescription: string): PostingSignal {
  if (!jobDescription || jobDescription.trim().length === 0) {
    return { polarity: 'none', evidence: [], cues: [] };
  }

  const signals: Signal[] = [];
  for (const clause of splitClauses(jobDescription)) {
    // Screening questions ("Will you now or in the future require sponsorship?")
    // mention sponsorship without offering or refusing it.
    if (clause.interrogative) continue;
    signals.push(...matchHardPatterns(clause), ...matchAnchorsInClause(clause));
  }

  if (signals.length === 0) {
    return { polarity: 'none', evidence: [], cues: [] };
  }

  const maxWeight = Math.max(...signals.map((s) => s.weight));
  const decisive = signals.filter((s) => s.weight === maxWeight);

  // Ties resolve to negative. Telling someone sponsorship is available when it is
  // not costs them an application and a rejection; the reverse costs them a
  // maybe. Given who uses this, we take the conservative side.
  const polarity = decisive.some((s) => s.polarity === 'negative') ? 'negative' : 'positive';

  const winning = decisive.filter((s) => s.polarity === polarity);
  return {
    polarity,
    evidence: dedupe(winning.map((s) => s.evidence)).slice(0, 3),
    cues: dedupe(winning.map((s) => s.cue)),
  };
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
