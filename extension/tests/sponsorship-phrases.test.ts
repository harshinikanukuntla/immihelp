/**
 * The brief calls out one specific failure mode: "we sponsor visas" and "we do
 * not sponsor visas" must not both read as positive. That pair is the first two
 * cases below, and the rest of this file is the surrounding minefield — the
 * phrasings real job descriptions actually use.
 *
 * Every case here is written from language observed in the wild rather than
 * invented to fit the implementation. When a new false positive turns up, add
 * the sentence here first, then fix the detector.
 */
import { describe, expect, it } from 'vitest';
import { detectSponsorshipSignal, splitClauses, tokenize } from '../src/lib/sponsorship-phrases';

const polarityOf = (text: string) => detectSponsorshipSignal(text).polarity;

describe('detectSponsorshipSignal — the required pair', () => {
  it('reads a plain offer as positive', () => {
    expect(polarityOf('We sponsor visas for exceptional candidates.')).toBe('positive');
  });

  it('reads the negated form of the same sentence as negative', () => {
    expect(polarityOf('We do not sponsor visas for this role.')).toBe('negative');
  });
});

describe('offer language reads positive', () => {
  const positives = [
    'Visa sponsorship available.',
    'Visa sponsorship is available for this position.',
    'We are open to sponsoring the right candidate.',
    'We are happy to sponsor candidates who need it.',
    'Employment sponsorship is offered for this role.',
    'Relocation package provided.',
    'We provide relocation assistance and visa support.',
    'This role is eligible for visa sponsorship.',
    'Right to work is not required — we will handle the paperwork.',
    'We will assist with your work permit application.',
    'Our company regularly sponsors H-1B and O-1 petitions.',
  ];

  for (const text of positives) {
    it(`positive: ${text}`, () => {
      expect(polarityOf(text)).toBe('positive');
    });
  }
});

describe('refusal language reads negative', () => {
  const negatives = [
    'Visa sponsorship is not available for this position.',
    'No visa sponsorship.',
    'We are unable to offer visa sponsorship at this time.',
    'We are not able to provide sponsorship for this role.',
    'Applicants must have existing right to work in the United Kingdom.',
    'You must already possess valid work authorization.',
    'Candidates must be legally authorized to work in the US without sponsorship.',
    'Applicants requiring sponsorship will not be considered.',
    'This position is not eligible for employment sponsorship.',
    'Sponsorship, unfortunately, is not available for this opening.',
    'Please note we cannot sponsor work visas.',
    'Candidates requiring visa sponsorship now or in the future cannot be considered.',
  ];

  for (const text of negatives) {
    it(`negative: ${text}`, () => {
      expect(polarityOf(text)).toBe('negative');
    });
  }
});

describe('postings that say nothing about work authorisation', () => {
  const silent = [
    'We are looking for a senior backend engineer with five years of Go experience.',
    'Responsibilities include mentoring junior engineers and owning service reliability.',
    '',
    '   ',
  ];

  for (const text of silent) {
    it(`none: ${JSON.stringify(text.slice(0, 40))}`, () => {
      expect(polarityOf(text)).toBe('none');
    });
  }

  it('returns no evidence when nothing matched', () => {
    const result = detectSponsorshipSignal('We use TypeScript, Go, and Postgres.');
    expect(result.evidence).toEqual([]);
    expect(result.cues).toEqual([]);
  });
});

describe('screening questions are not offers', () => {
  it('ignores the standard application-form question', () => {
    expect(
      polarityOf('Will you now or in the future require visa sponsorship for employment?'),
    ).toBe('none');
  });

  it('ignores the question but still reads a real statement in the same posting', () => {
    const text = [
      'Do you now or in the future require sponsorship?',
      'We are unable to provide visa sponsorship for this role.',
    ].join('\n');
    expect(polarityOf(text)).toBe('negative');
  });
});

describe('negation scoping across clause boundaries', () => {
  it('does not let a negation leak across a sentence boundary', () => {
    const text = 'We cannot offer relocation. Visa sponsorship is available.';
    expect(polarityOf(text)).toBe('positive');
  });

  it('does not let a negation leak past a comma onto a later anchor', () => {
    const text = 'Although we cannot offer relocation, visa sponsorship is available.';
    expect(polarityOf(text)).toBe('positive');
  });

  it('does not let a negation leak past a semicolon', () => {
    const text = 'Relocation is not offered; we do sponsor visas.';
    expect(polarityOf(text)).toBe('positive');
  });

  it('keeps a negation attached to its own anchor', () => {
    const text = 'You must have the right to work in the UK; we are unable to offer sponsorship.';
    expect(polarityOf(text)).toBe('negative');
  });
});

describe('weighting: sponsorship language outranks the relocation proxy', () => {
  it('an explicit offer beats a relocation refusal', () => {
    expect(polarityOf('Relocation is not provided, but we do sponsor visas.')).toBe('positive');
  });

  it('an explicit refusal beats a relocation offer', () => {
    expect(
      polarityOf('A generous relocation package is provided. We do not sponsor work visas.'),
    ).toBe('negative');
  });

  it('relocation alone is enough for a weak positive', () => {
    expect(polarityOf('Relocation package provided for international hires.')).toBe('positive');
  });
});

describe('ties resolve conservatively', () => {
  it('prefers negative when equal-weight signals disagree', () => {
    // Both anchors are sponsorship-explicit (weight 3), one each way.
    const text = 'We sponsor H-1B transfers. We do not sponsor new H-1B petitions.';
    expect(polarityOf(text)).toBe('negative');
  });
});

describe('evidence and cues', () => {
  it('quotes the matched clause verbatim rather than paraphrasing', () => {
    const result = detectSponsorshipSignal(
      'Great benefits. Visa sponsorship is available for this role. Apply today.',
    );
    expect(result.polarity).toBe('positive');
    expect(result.evidence).toContain('Visa sponsorship is available for this role.');
  });

  it('caps evidence at three clauses so the panel cannot be flooded', () => {
    const text = Array.from(
      { length: 8 },
      (_, i) => `Visa sponsorship is available for role ${i}.`,
    ).join(' ');
    expect(detectSponsorshipSignal(text).evidence.length).toBeLessThanOrEqual(3);
  });

  it('records which cue fired', () => {
    const result = detectSponsorshipSignal('We are unable to offer visa sponsorship.');
    expect(result.cues.some((c) => c.startsWith('hard:'))).toBe(true);
  });
});

describe('real-world formatting survives extraction', () => {
  it('handles curly apostrophes', () => {
    expect(polarityOf('We don’t sponsor visas for this position.')).toBe('negative');
  });

  it('handles a bulleted requirements list', () => {
    const text = [
      'Requirements:',
      '- 5+ years of experience with distributed systems',
      '- Must be authorized to work in the United States without sponsorship',
      '- Strong written communication',
    ].join('\n');
    expect(polarityOf(text)).toBe('negative');
  });

  it('handles an all-caps notice', () => {
    expect(polarityOf('PLEASE NOTE: VISA SPONSORSHIP IS NOT AVAILABLE.')).toBe('negative');
  });
});

describe('splitClauses', () => {
  it('splits on sentence terminators and newlines', () => {
    const clauses = splitClauses('One. Two!\nThree?');
    expect(clauses.map((c) => c.original)).toEqual(['One.', 'Two!', 'Three?']);
  });

  it('marks interrogative clauses', () => {
    const clauses = splitClauses('Do we sponsor?');
    expect(clauses[0]?.interrogative).toBe(true);
  });

  it('splits on a comma only when a contrastive conjunction follows', () => {
    expect(splitClauses('Red, green, and blue.')).toHaveLength(1);
    expect(splitClauses('Red is out, but blue is fine.')).toHaveLength(2);
  });
});

describe('tokenize', () => {
  it('keeps hyphenated visa classes intact', () => {
    expect(tokenize('we sponsor h-1b visas')).toEqual(['we', 'sponsor', 'h-1b', 'visas']);
  });

  it('emits punctuation barriers as their own tokens', () => {
    expect(tokenize('sponsorship, however')).toEqual(['sponsorship', ',', 'however']);
  });
});
