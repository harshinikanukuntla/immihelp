/**
 * Resume matching — the parts that are pure functions.
 *
 * The embedding itself is the model's job and is not tested here. What is tested
 * is everything around it: the similarity-to-score calibration (which decides
 * whether "no signal" is displayed as 35% or as 0%), and the gap/overlap
 * analysis that makes the rationale specific.
 */
import { describe, expect, it } from 'vitest';
import {
  SIMILARITY_CEILING,
  SIMILARITY_FLOOR,
  bandFromScore,
  buildMatch,
  buildRationale,
  cosineSimilarity,
  findGaps,
  findOverlaps,
  scoreFromSimilarity,
  terms,
  truncateForEmbedding,
} from '../src/lib/resume-match';

describe('cosineSimilarity', () => {
  it('is 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });

  it('is 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('is -1 for opposed vectors', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it('is scale invariant', () => {
    expect(cosineSimilarity([1, 2], [10, 20])).toBeCloseTo(1);
  });

  it('returns 0 rather than NaN for a zero vector', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it('returns 0 for mismatched lengths instead of reading past the end', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

describe('scoreFromSimilarity', () => {
  it('reports no signal as zero, not as a middling percentage', () => {
    // Two unrelated pieces of professional English still score ~0.3 cosine.
    // Showing that as "30% match" would read as a weak positive; it is not.
    expect(scoreFromSimilarity(SIMILARITY_FLOOR)).toBe(0);
    expect(scoreFromSimilarity(0.1)).toBe(0);
    expect(scoreFromSimilarity(-1)).toBe(0);
  });

  it('saturates at the ceiling', () => {
    expect(scoreFromSimilarity(SIMILARITY_CEILING)).toBe(100);
    expect(scoreFromSimilarity(0.99)).toBe(100);
  });

  it('is monotonic between the floor and the ceiling', () => {
    const midpoint = (SIMILARITY_FLOOR + SIMILARITY_CEILING) / 2;
    expect(scoreFromSimilarity(midpoint)).toBe(50);
    expect(scoreFromSimilarity(0.4)).toBeLessThan(scoreFromSimilarity(0.6));
  });
});

describe('bandFromScore', () => {
  it('maps scores onto the three bands', () => {
    expect(bandFromScore(100)).toBe('strong');
    expect(bandFromScore(70)).toBe('strong');
    expect(bandFromScore(69)).toBe('moderate');
    expect(bandFromScore(40)).toBe('moderate');
    expect(bandFromScore(39)).toBe('weak');
    expect(bandFromScore(0)).toBe('weak');
  });
});

describe('terms', () => {
  it('keeps the punctuation inside technology names', () => {
    const result = terms('We use C++, C#, .NET and Node.js');
    expect(result).toContain('c++');
    expect(result).toContain('c#');
    expect(result).toContain('node.js');
  });

  it('drops filler that says nothing about fit', () => {
    const result = terms('The candidate will have strong experience in the role');
    expect(result).not.toContain('the');
    expect(result).not.toContain('experience');
    expect(result).not.toContain('candidate');
  });
});

describe('findGaps', () => {
  it('surfaces repeated requirements the resume never mentions', () => {
    const resume = 'Backend engineer. Python, Django, Postgres. Built REST APIs.';
    const jd = 'Kubernetes experience required. You will operate Kubernetes clusters and tune Kubernetes autoscaling.';
    expect(findGaps(resume, jd)).toContain('kubernetes');
  });

  it('ignores terms mentioned only once, which are usually nice-to-haves', () => {
    const resume = 'Python developer.';
    const jd = 'Python role. Occasional Fortran maintenance.';
    expect(findGaps(resume, jd)).not.toContain('fortran');
  });

  it('never lists something the resume already covers', () => {
    const resume = 'Kubernetes, Kubernetes, Kubernetes.';
    const jd = 'Kubernetes required. Kubernetes daily. Kubernetes everywhere.';
    expect(findGaps(resume, jd)).not.toContain('kubernetes');
  });

  it('respects the limit', () => {
    const jd = Array.from({ length: 30 }, (_, i) => `tech${i} tech${i}`).join(' ');
    expect(findGaps('nothing relevant', jd, 4)).toHaveLength(4);
  });
});

describe('findOverlaps', () => {
  it('finds shared emphasis', () => {
    const resume = 'Senior Go engineer with Kafka and gRPC experience.';
    const jd = 'You will write Go services. Go, Kafka, and gRPC are our stack. Go matters most.';
    const overlaps = findOverlaps(resume, jd);
    expect(overlaps).toContain('go');
    expect(overlaps[0]).toBe('go'); // Most frequent first.
  });
});

describe('buildRationale', () => {
  it('states what it is comparing so the number is not overread', () => {
    const rationale = buildRationale('strong', ['go'], ['kubernetes']);
    expect(rationale).toContain('compares wording, not qualifications');
  });

  it('names the shared and missing terms rather than staying generic', () => {
    const rationale = buildRationale('moderate', ['python'], ['terraform']);
    expect(rationale).toContain('python');
    expect(rationale).toContain('terraform');
  });

  it('works with no overlaps and no gaps', () => {
    expect(buildRationale('weak', [], [])).toBeTruthy();
  });
});

describe('buildMatch', () => {
  it('assembles a complete result', () => {
    const vector = [1, 0, 0];
    const match = buildMatch(
      vector,
      vector,
      'Go engineer with Kafka experience.',
      'Go engineer. Kafka. Kafka. Terraform. Terraform.',
    );

    expect(match.score).toBe(100);
    expect(match.band).toBe('strong');
    expect(match.gaps).toContain('terraform');
    expect(match.rationale.length).toBeGreaterThan(0);
  });

  it('scores unrelated vectors at zero', () => {
    const match = buildMatch([1, 0], [0, 1], 'resume text', 'job description');
    expect(match.score).toBe(0);
    expect(match.band).toBe('weak');
  });
});

describe('truncateForEmbedding', () => {
  it('collapses whitespace', () => {
    expect(truncateForEmbedding('a\n\n  b\t c')).toBe('a b c');
  });

  it('cuts to the limit', () => {
    expect(truncateForEmbedding('x'.repeat(5000), 100)).toHaveLength(100);
  });

  it('leaves short text alone', () => {
    expect(truncateForEmbedding('short', 100)).toBe('short');
  });
});
