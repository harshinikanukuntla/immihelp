/**
 * Feature 2 — semantic resume-to-job-description matching.
 *
 * ## Where the work happens
 *
 * Embedding runs in an offscreen document using a quantised MiniLM model bundled
 * with the extension. The resume text never leaves the device, there is no
 * per-lookup backend cost, and the extension ships no remote code — all three
 * follow from the same decision.
 *
 * This module holds the parts that are pure functions: turning two vectors into
 * a score, and turning a score plus a term comparison into something a person
 * can act on. Those are the parts worth testing, and they are the parts a future
 * LLM-generated rationale would replace without touching the embedding path.
 *
 * ## The seam for a richer rationale
 *
 * `buildRationale` is the swap point. A pluggable backend (local Ollama, or a
 * hosted API, off by default) would implement the same signature and receive the
 * same inputs. Nothing above it in the call graph knows how the rationale was
 * produced, so adding one does not move the resume off-device — the caller
 * decides what, if anything, to send.
 */
import type { ResumeMatch } from '../types/domain';

/** Bundled model. Recorded alongside cached vectors so a model change invalidates them. */
export const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}

/**
 * Maps cosine similarity onto a 0–100 score.
 *
 * The rescaling is not cosmetic. Sentence-transformer cosine similarities for
 * two pieces of professional English are compressed into roughly 0.25–0.75 —
 * an unrelated resume and job description still score around 0.3 because they
 * share register and vocabulary. Showing the raw cosine as a percentage would
 * report "35% match" for a completely unrelated role, which reads as a weak
 * signal when it is really no signal at all.
 *
 * The floor and ceiling below are a calibration, not a measurement. They are
 * deliberately named constants so they can be re-derived if the bundled model
 * changes — a different model has a different similarity distribution and these
 * numbers would need to move with it.
 */
export const SIMILARITY_FLOOR = 0.25;
export const SIMILARITY_CEILING = 0.75;

export function scoreFromSimilarity(similarity: number): number {
  const clamped = Math.max(SIMILARITY_FLOOR, Math.min(SIMILARITY_CEILING, similarity));
  const ratio = (clamped - SIMILARITY_FLOOR) / (SIMILARITY_CEILING - SIMILARITY_FLOOR);
  return Math.round(ratio * 100);
}

export function bandFromScore(score: number): ResumeMatch['band'] {
  if (score >= 70) return 'strong';
  if (score >= 40) return 'moderate';
  return 'weak';
}

/** Words carrying no signal about fit. Kept small and generic on purpose. */
const STOPWORDS = new Set(
  ('a an the and or but if then than that this these those with without within for from to of in on ' +
    'at by as is are was were be been being have has had do does did will would can could should may ' +
    'might must you your our we us they their it its not no yes about into over under more most other ' +
    'some such only own same so too very just also across per via using use used work working works ' +
    'role roles team teams company companies year years experience experienced strong excellent good ' +
    'ability able help helps helping including include includes new great looking join joining ' +
    'candidate candidates applicant applicants position positions job jobs opportunity opportunities ' +
    'responsibilities requirements qualifications preferred required plus benefits salary apply')
    .split(' '),
);

/** Tokenises to comparable terms, keeping the punctuation that lives inside tech names. */
export function terms(text: string): string[] {
  const matches = text.toLowerCase().match(/[a-z][a-z0-9+#.\-/]*[a-z0-9+#]|[a-z]/g) ?? [];
  return matches
    .map((term) => term.replace(/^[.\-/]+|[.\-/]+$/g, ''))
    .filter((term) => term.length >= 2 && !STOPWORDS.has(term));
}

/**
 * Terms the posting emphasises that the resume never mentions.
 *
 * Frequency-weighted, because a requirement repeated through a job description
 * is load-bearing and one mentioned once in a "nice to have" list is not. This
 * is a lexical complement to the semantic score, not a second opinion on it:
 * the score says how close the documents are overall, the gaps say what to look
 * at if you want to close the distance.
 */
export function findGaps(resumeText: string, jobDescription: string, limit = 6): string[] {
  const resumeTerms = new Set(terms(resumeText));
  const frequency = new Map<string, number>();

  for (const term of terms(jobDescription)) {
    if (resumeTerms.has(term)) continue;
    frequency.set(term, (frequency.get(term) ?? 0) + 1);
  }

  return [...frequency.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([term]) => term);
}

/** Terms present in both, used to make the rationale concrete rather than generic. */
export function findOverlaps(resumeText: string, jobDescription: string, limit = 5): string[] {
  const resumeTerms = new Set(terms(resumeText));
  const frequency = new Map<string, number>();

  for (const term of terms(jobDescription)) {
    if (!resumeTerms.has(term)) continue;
    frequency.set(term, (frequency.get(term) ?? 0) + 1);
  }

  return [...frequency.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([term]) => term);
}

/**
 * Plain-language explanation of the score.
 *
 * Hedged on purpose. This is a similarity measurement between two documents, not
 * a prediction about a hiring outcome, and the copy should not let anyone
 * mistake it for one.
 */
export function buildRationale(
  band: ResumeMatch['band'],
  overlaps: string[],
  gaps: string[],
): string {
  const parts: string[] = [];

  const opening: Record<ResumeMatch['band'], string> = {
    strong: 'Your resume reads as closely related to this posting.',
    moderate: 'Your resume overlaps with this posting in places.',
    weak: 'Your resume and this posting have little language in common.',
  };
  parts.push(opening[band]);

  if (overlaps.length > 0) {
    parts.push(`Shared emphasis: ${overlaps.slice(0, 4).join(', ')}.`);
  }
  if (gaps.length > 0) {
    parts.push(`The posting stresses ${gaps.slice(0, 4).join(', ')}, which your resume does not mention.`);
  }

  parts.push('This compares wording, not qualifications.');
  return parts.join(' ');
}

/** Assembles the final result from two embeddings and the two source texts. */
export function buildMatch(
  resumeVector: number[],
  jobVector: number[],
  resumeText: string,
  jobDescription: string,
): ResumeMatch {
  const similarity = cosineSimilarity(resumeVector, jobVector);
  const score = scoreFromSimilarity(similarity);
  const band = bandFromScore(score);
  const gaps = findGaps(resumeText, jobDescription);
  const overlaps = findOverlaps(resumeText, jobDescription);

  return { score, band, rationale: buildRationale(band, overlaps, gaps), gaps };
}

/**
 * Truncates to roughly the model's context window.
 *
 * MiniLM truncates at 256 word pieces regardless, so feeding it a 4,000-word job
 * description silently embeds only the opening. Cutting explicitly, and from the
 * front where the substantive content usually sits, at least makes the behaviour
 * predictable.
 */
export function truncateForEmbedding(text: string, maxChars = 4000): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= maxChars ? collapsed : collapsed.slice(0, maxChars);
}
