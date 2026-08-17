/**
 * LinkedIn adapter.
 *
 * The DOM fixtures here are simplified, and passing these tests does not prove
 * the selectors match live LinkedIn — nothing short of running against the real
 * site does that. What these tests do protect is the adapter's *contract*: that
 * a missing element degrades instead of throwing, that a partially-rendered page
 * reports "not ready" rather than emitting a half-extracted context, and that
 * page keys distinguish postings on the search page where the path never changes.
 */
import { JSDOM } from 'jsdom';
import { beforeEach, describe, expect, it } from 'vitest';
import { linkedInAdapter } from '../src/adapters/linkedin';
import { cleanCompanyName, companyWebsite, jobKey } from '../src/adapters/linkedin';

function docFrom(html: string): Document {
  return new JSDOM(html).window.document;
}

const JOB_HTML = `
  <div class="job-details-jobs-unified-top-card__container--two-pane">
    <div class="job-details-jobs-unified-top-card__job-title"><h1>Senior Backend Engineer</h1></div>
    <div class="job-details-jobs-unified-top-card__company-name">
      <a href="/company/acme-corp/life/">Acme Corp</a>
    </div>
    <div class="job-details-jobs-unified-top-card__primary-description-container">
      San Francisco, CA · 2 days ago
    </div>
  </div>
  <div class="jobs-description__content">
    <div class="jobs-box__html-content">
      <p>We are hiring.</p>
      <ul><li>Go experience</li><li>Visa sponsorship available</li></ul>
    </div>
  </div>
`;

describe('detectPageType', () => {
  const cases: Array<[string, string | null]> = [
    ['https://www.linkedin.com/jobs/view/123456/', 'job_posting'],
    ['https://www.linkedin.com/jobs/search/?currentJobId=99', 'job_posting'],
    ['https://www.linkedin.com/jobs/collections/recommended/', 'job_posting'],
    ['https://www.linkedin.com/company/acme-corp/', 'company'],
    ['https://www.linkedin.com/feed/', null],
    ['https://www.linkedin.com/in/someone/', null],
  ];

  for (const [href, expected] of cases) {
    it(`${href} -> ${expected}`, () => {
      const url = new URL(href);
      expect(linkedInAdapter.detectPageType(url, docFrom(''))).toBe(expected);
    });
  }
});

describe('matches', () => {
  it('claims linkedin.com and nothing else', () => {
    expect(linkedInAdapter.matches(new URL('https://www.linkedin.com/jobs/view/1'))).toBe(true);
    expect(linkedInAdapter.matches(new URL('https://indeed.com/viewjob'))).toBe(false);
    // A lookalike host must not be claimed.
    expect(linkedInAdapter.matches(new URL('https://notlinkedin.com/jobs/view/1'))).toBe(false);
  });
});

describe('extract — job posting', () => {
  let doc: Document;
  beforeEach(() => {
    doc = docFrom(JOB_HTML);
  });

  it('pulls company, title, description, and country', () => {
    const url = new URL('https://www.linkedin.com/jobs/view/123456/');
    const context = linkedInAdapter.extract(url, doc);

    expect(context).not.toBeNull();
    expect(context!.company.name).toBe('Acme Corp');
    expect(context!.jobTitle).toBe('Senior Backend Engineer');
    expect(context!.country).toBe('US');
    expect(context!.jobDescription).toContain('Visa sponsorship available');
  });

  it('reads the company slug from the link already on the page', () => {
    const context = linkedInAdapter.extract(new URL('https://www.linkedin.com/jobs/view/1'), doc);
    expect(context!.company.slug).toBe('acme-corp');
  });

  it('preserves line structure in the description', () => {
    // The phrase scanner splits on line boundaries; flattening a bulleted list
    // merges unrelated clauses and defeats negation scoping.
    const context = linkedInAdapter.extract(new URL('https://www.linkedin.com/jobs/view/1'), doc);
    expect(context!.jobDescription).toContain('\n');
  });

  it('reports not-ready rather than half-extracted when the pane has not rendered', () => {
    const empty = docFrom('<div class="jobs-search-results-list"></div>');
    expect(linkedInAdapter.extract(new URL('https://www.linkedin.com/jobs/search/'), empty)).toBeNull();
  });

  it('still returns a context when only the description is missing', () => {
    const partial = docFrom(`
      <div class="job-details-jobs-unified-top-card__company-name">Acme Corp</div>
    `);
    const context = linkedInAdapter.extract(new URL('https://www.linkedin.com/jobs/view/1'), partial);
    expect(context).not.toBeNull();
    expect(context!.jobDescription).toBeUndefined();
  });
});

describe('extract — company page', () => {
  it('reads the rendered organisation name', () => {
    const doc = docFrom('<h1 class="org-top-card-summary__title">Acme Corporation</h1>');
    const context = linkedInAdapter.extract(new URL('https://www.linkedin.com/company/acme-corp/'), doc);

    expect(context!.pageType).toBe('company');
    expect(context!.company.name).toBe('Acme Corporation');
    expect(context!.company.slug).toBe('acme-corp');
  });

  it('falls back to the slug before the top card hydrates', () => {
    const context = linkedInAdapter.extract(
      new URL('https://www.linkedin.com/company/acme-corp/'),
      docFrom('<div></div>'),
    );
    expect(context!.company.name).toBe('Acme Corp');
  });
});

describe('findPanelAnchor', () => {
  it('finds the job top card', () => {
    expect(linkedInAdapter.findPanelAnchor('job_posting', docFrom(JOB_HTML))).not.toBeNull();
  });

  it('returns null rather than throwing when no anchor exists', () => {
    expect(linkedInAdapter.findPanelAnchor('job_posting', docFrom('<div></div>'))).toBeNull();
  });
});

describe('cleanCompanyName', () => {
  it('strips follower counts and separators LinkedIn appends', () => {
    expect(cleanCompanyName('Acme Corp · 12,345 followers')).toBe('Acme Corp');
    expect(cleanCompanyName('Acme Corp 500 employees')).toBe('Acme Corp');
  });

  it('collapses the duplicated-name rendering', () => {
    expect(cleanCompanyName('Stripe Stripe')).toBe('Stripe');
    expect(cleanCompanyName('Acme Corp Acme Corp')).toBe('Acme Corp');
  });

  it('leaves a genuine repeated word alone', () => {
    // "Foo Foo Bar" is not a doubling; only an exact halves match is collapsed.
    expect(cleanCompanyName('Foo Foo Bar')).toBe('Foo Foo Bar');
  });

  it('collapses whitespace', () => {
    expect(cleanCompanyName('  Acme   Corp  ')).toBe('Acme Corp');
  });
});

describe('companyWebsite', () => {
  it('reads the outbound link', () => {
    const doc = docFrom(
      '<div class="org-about-module__company-page-url"><a href="https://acme.com/">acme.com</a></div>',
    );
    expect(companyWebsite(doc)).toBe('acme.com');
  });

  it('unwraps LinkedIn’s outbound redirector', () => {
    const doc = docFrom(
      '<div class="org-about-module__company-page-url">' +
        '<a href="https://www.linkedin.com/redir/redirect?url=https%3A%2F%2Facme.com">acme.com</a></div>',
    );
    expect(companyWebsite(doc)).toBe('acme.com');
  });

  it('returns undefined when there is no link', () => {
    expect(companyWebsite(docFrom('<div></div>'))).toBeUndefined();
  });
});

describe('jobKey', () => {
  it('distinguishes postings on the search page, where the path never changes', () => {
    const a = jobKey(new URL('https://www.linkedin.com/jobs/search/?currentJobId=1'), 'Acme');
    const b = jobKey(new URL('https://www.linkedin.com/jobs/search/?currentJobId=2'), 'Acme');
    expect(a).not.toBe(b);
  });

  it('uses the path id on a direct posting URL', () => {
    expect(jobKey(new URL('https://www.linkedin.com/jobs/view/98765/'), 'Acme')).toBe(
      'linkedin:job:98765',
    );
  });

  it('is stable across query noise on the same posting', () => {
    const a = jobKey(new URL('https://www.linkedin.com/jobs/view/1?refId=abc'), 'Acme');
    const b = jobKey(new URL('https://www.linkedin.com/jobs/view/1?refId=xyz&trk=q'), 'Acme');
    expect(a).toBe(b);
  });
});
