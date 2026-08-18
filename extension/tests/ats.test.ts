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

/**
 * Regression cases from a real posting.
 *
 * The tool shipped a "Top 5 additions" list reading: marketplace, re, ll,
 * pricing, small. Two separate faults — `re` and `ll` are contraction fragments
 * from "we're" and "you'll", and `small` was admitted purely for being frequent.
 * Neither is something a person could add to a resume.
 */
describe('junk that must never be suggested', () => {
  const REAL_POSTING = [
    'About the job',
    "We're a marketplace for small businesses, and you'll help us grow.",
    "We're small, we move fast, and we're proud of it.",
    'Small teams. Small batches. Small businesses.',
    "You'll work on pricing. You'll own pricing. Pricing is core.",
    '',
    'Requirements:',
    '- 5+ years of experience with Python and distributed systems',
    '- Experience with marketplace pricing models',
    '- Strong knowledge of SQL',
  ].join('\n');

  const terms = () => analyzeAts('Java developer', REAL_POSTING).missing.map((g) => g.term);

  it('never suggests contraction fragments', () => {
    expect(terms()).not.toContain('re');
    expect(terms()).not.toContain('ll');
    expect(terms()).not.toContain('ve');
  });

  it('never suggests an adjective, however often it is repeated', () => {
    // "small" appears six times above and is still not a requirement.
    expect(terms()).not.toContain('small');
  });

  it('does not admit a term for frequency alone', () => {
    const noRequirements = 'Widget widget widget. Widget widget. We love widgets.';
    expect(analyzeAts('nothing', noRequirements).missing.map((g) => g.term)).not.toContain('widget');
  });

  it('still finds the genuine skills in the same posting', () => {
    const found = terms();
    expect(found).toContain('python');
    expect(found).toContain('sql');
  });

  it('keeps a domain term that appears in a requirements bullet', () => {
    // "pricing" is a real requirement for this role — it is named in the
    // requirements, not merely repeated in the prose.
    expect(terms()).toContain('pricing');
  });
});

describe('tokenizer handles contractions', () => {
  it('does not shatter contractions into fragments', () => {
    expect(tokenize("we're hiring")).toEqual(['we', 'hiring']);
    expect(tokenize("you'll build")).toEqual(['you', 'build']);
    expect(tokenize("don't need")).toEqual(['do', 'need']);
  });

  it('handles curly apostrophes', () => {
    expect(tokenize('we’re hiring')).toEqual(['we', 'hiring']);
  });
});

describe('evidence is required, and recorded', () => {
  it('admits a known skill anywhere in the posting', () => {
    const analysis = analyzeAts('nothing', 'We use Kubernetes heavily across the platform.');
    const gap = analysis.missing.find((g) => g.term === 'kubernetes');
    expect(gap?.evidence).toBe('lexicon');
  });

  it('admits an unknown term when a requirement frame introduces it', () => {
    // The lexicon cannot know every field; the frame is what generalises.
    const analysis = analyzeAts('nothing', 'Requirements:\n- Experience with hydroponic irrigation');
    expect(analysis.missing.map((g) => g.term)).toContain('hydroponic irrigation');
  });

  it('weights a requirements-section skill above a body mention', () => {
    const inReq = analyzeAts('x', 'Requirements:\n- Experience with Rust').missing[0]!;
    const inBody = analyzeAts('x', 'Our stack happens to include Rust.').missing[0]!;
    expect(inReq.weight).toBeGreaterThan(inBody.weight);
  });
});

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
    expect(analysis.summary).toContain('does not name enough specific skills');
  });

  it('declines to score a posting that names too few skills', () => {
    // Better to say so than to report a percentage derived from two terms.
    const vague = 'We are looking for a motivated self-starter to join our team.';
    expect(analyzeAts(RESUME, vague).summary).toContain('does not name enough specific skills');
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

  it('computes the combined ceiling over one shared denominator', () => {
    // All five suggestions share a denominator, so the combined figure is a
    // single larger numerator rather than five independent jumps. Asserting the
    // arithmetic directly, because comparing against the summed gains is not a
    // reliable invariant once each gain has been rounded to a whole percent.
    const analysis = analyzeAts(RESUME, JD);

    const suggestedWeight = analysis.suggestions.reduce((sum, suggestion) => {
      const gap = analysis.missing.find((entry) => entry.term === suggestion.term)!;
      return sum + gap.weight;
    }, 0);
    const expected = Math.round(
      ((analysis.matchedWeight + suggestedWeight) / analysis.totalWeight) * 100,
    );

    expect(projectedScoreWithAll(analysis)).toBe(expected);
    expect(projectedScoreWithAll(analysis)).toBeLessThanOrEqual(100);
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
