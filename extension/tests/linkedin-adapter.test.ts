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
import { detectSponsorshipSignal } from '../src/lib/sponsorship-phrases';

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
    // LinkedIn serves the same two-pane UI from this path. Missing it meant the
    // panel never appeared for anyone browsing job recommendations.
    ['https://www.linkedin.com/jobs/search-results/?currentJobId=99', 'job_posting'],
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

/**
 * The class names above are cosmetic and LinkedIn churns them. On a live page
 * every single named selector missed while the markup was perfectly readable —
 * so extraction also has a structural path that keys on what elements *are*
 * (a link to /company/<slug>, an h1, the longest text block) rather than what
 * they are currently called.
 *
 * These fixtures deliberately contain no recognisable SponsorScope selector.
 */
describe('extract — structural fallback when every class name has changed', () => {
  const RESTYLED = `
    <main>
      <div class="jobs-search__job-details--wrapper">
        <div class="xyz-9f2a">
          <h1 class="abc-1234">Technical Lead Manager</h1>
          <div class="def-5678"><a href="/company/instabase/">Instabase</a></div>
          <span class="ghi-9012">San Francisco, CA · Reposted 4 days ago</span>
        </div>
        <div class="jkl-3456">
          <p>At Instabase, we are democratizing access to AI innovation for any
          organization solving unstructured data problems. We work with some of the
          largest and most complex organizations in the world, and our investors
          include Greylock, Andreessen Horowitz, and Index Ventures. You will lead a
          team of engineers building the platform. Visa sponsorship available for
          exceptional candidates. We are looking for someone with deep distributed
          systems experience and a track record of shipping.</p>
        </div>
      </div>
    </main>
  `;

  const url = new URL('https://www.linkedin.com/jobs/search-results/?currentJobId=4435306847');

  it('finds the company from the /company/ link rather than a class name', () => {
    const context = linkedInAdapter.extract(url, docFrom(RESTYLED));
    expect(context).not.toBeNull();
    expect(context!.company.name).toBe('Instabase');
    expect(context!.company.slug).toBe('instabase');
  });

  it('finds the title from the h1', () => {
    expect(linkedInAdapter.extract(url, docFrom(RESTYLED))!.jobTitle).toBe(
      'Technical Lead Manager',
    );
  });

  it('finds the description as the longest text block', () => {
    const description = linkedInAdapter.extract(url, docFrom(RESTYLED))!.jobDescription;
    expect(description).toContain('Visa sponsorship available');
  });

  it('feeds the phrase detector well enough to produce a signal', () => {
    // End to end through the piece users actually read.
    const context = linkedInAdapter.extract(url, docFrom(RESTYLED))!;
    expect(detectSponsorshipSignal(context.jobDescription!).polarity).toBe('positive');
  });

  it('still finds somewhere to mount the panel', () => {
    // Extraction succeeding with no anchor used to spin silently forever.
    expect(linkedInAdapter.findPanelAnchor('job_posting', docFrom(RESTYLED))).not.toBeNull();
  });

  it('mounts even when the pane contains no heading at all', () => {
    // Observed on a live page: the details pane had no h1, so seeding the
    // anchor from a heading produced "read the posting, nowhere to put it".
    const headless = docFrom(`
      <main>
        <div class="wrapper">
          <span><a href="/company/axon/">Axon</a></span>
          <p>${'Long description text. '.repeat(40)}</p>
        </div>
      </main>
    `);
    const context = linkedInAdapter.extract(url, headless);
    expect(context!.company.name).toBe('Axon');
    expect(linkedInAdapter.findPanelAnchor('job_posting', headless)).not.toBeNull();
  });

  it('does not climb all the way to the page layout when mounting', () => {
    // Walking up to the outermost element inside the root put the panel at the
    // bottom of the page whenever the root fell back to <main>.
    const deep = docFrom(`
      <main>
        <div class="layout">
          <div class="left-rail"></div>
          <div class="pane"><div class="card"><span><a href="/company/axon/">Axon</a></span></div></div>
        </div>
      </main>
    `);
    const anchor = linkedInAdapter.findPanelAnchor('job_posting', deep);
    expect(anchor).not.toBeNull();
    expect(anchor!.className).not.toBe('layout');
  });

  it('ignores /company/ links in the left rail results list', () => {
    // The results list is full of other companies. Picking the first match in
    // the document would attribute the wrong employer to the open posting.
    const withRail = docFrom(`
      <main>
        <ul class="results">
          <li><a href="/company/runpod/">Runpod</a></li>
          <li><a href="/company/liatrio/">Liatrio</a></li>
        </ul>
        <div class="jobs-search__job-details--wrapper">
          <h1>Technical Lead Manager</h1>
          <div><a href="/company/instabase/">Instabase</a></div>
        </div>
      </main>
    `);
    expect(linkedInAdapter.extract(url, withRail)!.company.name).toBe('Instabase');
  });

  it('does not mistake navigation chrome for a description', () => {
    const sparse = docFrom(`
      <main>
        <div class="jobs-search__job-details--wrapper">
          <h1>Some Role</h1>
          <div><a href="/company/acme/">Acme</a></div>
          <div><a href="#">See all jobs</a></div>
        </div>
      </main>
    `);
    expect(linkedInAdapter.extract(url, sparse)!.jobDescription).toBeUndefined();
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
