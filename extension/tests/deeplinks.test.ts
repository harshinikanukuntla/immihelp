/**
 * Deep links.
 *
 * The property worth protecting here is that this module only ever *builds*
 * URLs. If someone later adds a fetch to it, the boundary described in the
 * module docstring is gone and the project is scraping third-party sites.
 */
import { describe, expect, it } from 'vitest';
import {
  REFERRAL_ROLES,
  companyPeopleUrl,
  globalPeopleUrl,
  interviewLinks,
  leadershipPageCandidates,
  mismatchReportUrl,
  personSearchUrl,
  referralLinks,
} from '../src/lib/deeplinks';

const recruiter = REFERRAL_ROLES[0];

describe('companyPeopleUrl', () => {
  it('targets the company’s own People tab', () => {
    const url = new URL(companyPeopleUrl('stripe', recruiter));
    expect(url.hostname).toBe('www.linkedin.com');
    expect(url.pathname).toBe('/company/stripe/people/');
    expect(url.searchParams.get('keywords')).toBe('technical recruiter');
  });

  it('escapes slugs so a crafted slug cannot alter the path', () => {
    const url = new URL(companyPeopleUrl('foo/bar?x=1', recruiter));
    expect(url.pathname).toBe('/company/foo%2Fbar%3Fx%3D1/people/');
  });
});

describe('globalPeopleUrl', () => {
  it('falls back to a keyword search across LinkedIn', () => {
    const url = new URL(globalPeopleUrl('Acme Corp', recruiter));
    expect(url.pathname).toBe('/search/results/people/');
    expect(url.searchParams.get('keywords')).toBe('Acme Corp technical recruiter');
  });
});

describe('referralLinks', () => {
  it('is company-scoped when a slug is available', () => {
    const { links, scoped } = referralLinks('Stripe', 'stripe');
    expect(scoped).toBe(true);
    expect(links).toHaveLength(REFERRAL_ROLES.length);
    expect(links.every((link) => link.url.includes('/company/stripe/people/'))).toBe(true);
  });

  it('reports the unscoped fallback so the UI can warn that it is noisier', () => {
    const { links, scoped } = referralLinks('Stripe', undefined);
    expect(scoped).toBe(false);
    expect(links.every((link) => link.url.includes('/search/results/people/'))).toBe(true);
  });
});

describe('interviewLinks', () => {
  it('builds search links rather than content URLs', () => {
    const links = interviewLinks('Acme Corp');
    expect(links).toHaveLength(3);
    for (const link of links) {
      expect(() => new URL(link.url)).not.toThrow();
    }
  });

  it('scopes the Blind link with a site: search, since Blind has no API', () => {
    const blind = interviewLinks('Acme Corp').find((l) => l.label.includes('Blind'));
    const query = new URL(blind!.url).searchParams.get('q');
    expect(query).toContain('site:teamblind.com');
    expect(query).toContain('"Acme Corp"');
  });

  it('quotes the company name so multi-word names are not split', () => {
    const web = interviewLinks('Acme Corp').at(-1)!;
    expect(new URL(web.url).searchParams.get('q')).toContain('"Acme Corp"');
  });

  it('notes that Glassdoor may gate its interview pages', () => {
    const glassdoor = interviewLinks('Acme').find((l) => l.label.includes('Glassdoor'));
    expect(glassdoor?.note).toBeTruthy();
  });
});

describe('leadershipPageCandidates', () => {
  it('targets the employer’s own domain, never LinkedIn', () => {
    const urls = leadershipPageCandidates('acme.com');
    expect(urls.every((url) => new URL(url).hostname === 'acme.com')).toBe(true);
    expect(urls.some((url) => url.includes('linkedin'))).toBe(false);
  });
});

describe('personSearchUrl', () => {
  it('searches LinkedIn for a named person at a company', () => {
    const url = new URL(personSearchUrl('Jane Doe', 'Acme'));
    expect(url.searchParams.get('keywords')).toBe('Jane Doe Acme');
  });
});

describe('mismatchReportUrl', () => {
  it('pre-fills a GitHub issue with both names', () => {
    const url = new URL(mismatchReportUrl('org/repo', 'Apple', 'Apple Bank for Savings', 'job_posting'));
    expect(url.hostname).toBe('github.com');
    expect(url.pathname).toBe('/org/repo/issues/new');
    expect(url.searchParams.get('title')).toContain('Apple');
    expect(url.searchParams.get('title')).toContain('Apple Bank for Savings');
  });

  it('says in the body that no page contents are included', () => {
    const url = new URL(mismatchReportUrl('org/repo', 'A', 'B', 'job_posting'));
    expect(url.searchParams.get('body')).toContain('No page contents or personal data');
  });
});
