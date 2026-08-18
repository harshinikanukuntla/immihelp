/**
 * ATS keyword analysis.
 *
 * The first requirement is determinism. A fit score that changes when you
 * refresh the page is worse than no score — it teaches the user not to trust
 * anything the panel says, including the sponsorship data, which is the part
 * that actually matters.
 */
import { describe, expect, it } from 'vitest';
import { analyzeAts, projectedScoreWithAll, tokenize } from '../src/lib/ats';

const JD = [
  'About the job',
  'We are building a distributed data platform used by large enterprises.',
  '',
  'Requirements:',
  '- 5+ years building backend services in Go',
  '- Strong experience with Kubernetes and Kubernetes operators',
  '- Experience with Kafka and event driven architecture',
  '- Familiarity with Terraform and infrastructure as code',
  '- Postgres and database design',
].join('\n');

const RESUME = [
  'Senior Backend Engineer',
  'Built backend services in Go and Python for a payments platform.',
  'Designed Postgres schemas and optimised queries.',
  'Worked with Kafka for event streaming.',
].join('\n');

describe('determinism', () => {
  it('produces the same score for the same inputs, every time', () => {
    const runs = Array.from({ length: 20 }, () => analyzeAts(RESUME, JD).score);
    expect(new Set(runs).size).toBe(1);
  });

  it('produces the same suggestions in the same order', () => {
    const a = analyzeAts(RESUME, JD).suggestions.map((s) => s.term);
    const b = analyzeAts(RESUME, JD).suggestions.map((s) => s.term);
    expect(a).toEqual(b);
  });

  it('breaks weight ties alphabetically rather than by insertion order', () => {
    // Without a deterministic tiebreak, equal-weight terms could reorder between
    // runs and the "top 5" list would visibly churn.
    const analysis = analyzeAts('nothing relevant here', 'alpha alpha beta beta gamma gamma');
    const sorted = [...analysis.missing].sort(
      (x, y) => y.weight - x.weight || x.term.localeCompare(y.term),
    );
    expect(analysis.missing).toEqual(sorted);
  });
});

describe('scoring', () => {
  it('rewards terms the resume covers', () => {
    const analysis = analyzeAts(RESUME, JD);
    expect(analysis.matched).toContain('go');
    expect(analysis.matched).toContain('kafka');
    expect(analysis.matched).toContain('postgres');
  });

  it('reports terms the resume never mentions', () => {
    const terms = analyzeAts(RESUME, JD).missing.map((gap) => gap.term);
    expect(terms).toContain('kubernetes');
    expect(terms).toContain('terraform');
  });

  it('scores an empty resume at zero', () => {
    expect(analyzeAts('', JD).score).toBe(0);
  });

  it('scores a resume containing the whole posting at 100', () => {
    expect(analyzeAts(JD, JD).score).toBe(100);
  });

  it('handles a posting with no usable content', () => {
    const analysis = analyzeAts(RESUME, '');
    expect(analysis.score).toBe(0);
    expect(analysis.totalTerms).toBe(0);
    expect(analysis.summary).toContain('not have enough detail');
  });

  it('weights requirements more heavily than boilerplate', () => {
    const inRequirements = analyzeAts(
      'unrelated',
      'About us\nWe love culture.\nRequirements:\n- Rust\n- Rust',
    );
    const inBody = analyzeAts('unrelated', 'About us\nWe sometimes use Rust. Rust is nice.');

    const a = inRequirements.missing.find((g) => g.term === 'rust');
    const b = inBody.missing.find((g) => g.term === 'rust');
    expect(a!.weight).toBeGreaterThan(b!.weight);
    expect(a!.inRequirements).toBe(true);
  });
});

describe('term matching', () => {
  it('does not let a substring satisfy a different technology', () => {
    // The classic false positive: "javascript" must not satisfy "java".
    const analysis = analyzeAts('I write javascript', 'Requirements:\n- java\n- java');
    expect(analysis.missing.map((g) => g.term)).toContain('java');
  });

  it('lets a longer phrase in the resume satisfy a multi-word requirement', () => {
    const analysis = analyzeAts(
      'Senior machine learning engineer',
      'Requirements:\n- machine learning\n- machine learning',
    );
    expect(analysis.matched).toContain('machine learning');
  });

  it('keeps punctuation inside technology names', () => {
    expect(tokenize('We use Node.js, C++, and CI/CD')).toEqual(
      expect.arrayContaining(['node.js', 'c++', 'ci/cd']),
    );
  });

  it('ignores filler words entirely', () => {
    const terms = analyzeAts('x', JD).missing.map((g) => g.term);
    expect(terms).not.toContain('the');
    expect(terms).not.toContain('experience');
    expect(terms).not.toContain('requirements');
  });
});

describe('suggestions', () => {
  it('returns at most five', () => {
    expect(analyzeAts('x', JD).suggestions.length).toBeLessThanOrEqual(5);
  });

  it('ranks the highest-impact missing term first', () => {
    const suggestions = analyzeAts(RESUME, JD).suggestions;
    for (let i = 1; i < suggestions.length; i++) {
      expect(suggestions[i - 1]!.gain).toBeGreaterThanOrEqual(suggestions[i]!.gain);
    }
  });

  it('projects a score that is arithmetic, not an estimate', () => {
    const analysis = analyzeAts(RESUME, JD);
    const first = analysis.suggestions[0]!;
    const gap = analysis.missing.find((g) => g.term === first.term)!;

    const expected = Math.round(
      ((analysis.matchedWeight + gap.weight) / analysis.totalWeight) * 100,
    );
    expect(first.projectedScore).toBe(expected);
    expect(first.gain).toBe(expected - analysis.score);
  });

  it('does not overstate the ceiling by summing individual gains', () => {
    // All suggestions share one denominator, so the combined score is not the
    // score plus the sum of the gains.
    const analysis = analyzeAts(RESUME, JD);
    const naive = analysis.score + analysis.suggestions.reduce((s, x) => s + x.gain, 0);
    const actual = projectedScoreWithAll(analysis);

    expect(actual).toBeGreaterThanOrEqual(analysis.score);
    expect(actual).toBeLessThanOrEqual(100);
    if (analysis.suggestions.length > 1) expect(actual).toBeLessThanOrEqual(naive);
  });

  it('offers nothing to add when everything is already covered', () => {
    expect(analyzeAts(JD, JD).suggestions).toEqual([]);
  });
});

describe('summary', () => {
  it('states the ratio behind the score rather than just the number', () => {
    const analysis = analyzeAts(RESUME, JD);
    expect(analysis.summary).toContain(`${analysis.matchedTerms}`);
    expect(analysis.summary).toContain(`${analysis.totalTerms}`);
  });

  it('says it is not any particular employer’s system', () => {
    expect(analyzeAts(RESUME, JD).summary).toContain('not any specific employer');
  });
});
