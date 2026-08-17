/**
 * LinkedIn adapter.
 *
 * ## About these selectors
 *
 * LinkedIn ships DOM changes continuously and without notice, and it serves
 * materially different markup to logged-in and logged-out visitors. Every field
 * below therefore lists several selectors, newest-known first, and falls through
 * to the older public-page classes. A field that resolves to nothing yields a
 * degraded panel — never a crash, and never a guess.
 *
 * **Selectors are the expected maintenance burden of this file.** When one
 * breaks, add the new selector to the front of the relevant list rather than
 * replacing the list; the old ones still serve users on cached or regional
 * variants. See docs/adding-a-job-board.md.
 */
import type { PageContext } from '../types/domain';
import { inferCountry } from '../lib/country';
import { safeBlockText, safeQuery, safeText, type JobBoardAdapter } from './types';

/**
 * Any path under /jobs/ is a candidate.
 *
 * Enumerating sub-paths (`/jobs/view/`, `/jobs/search/`, …) looks tighter but is
 * wrong: LinkedIn serves the same two-pane posting UI from several paths and
 * adds new ones. `/jobs/search-results/` renders an identical pane to
 * `/jobs/search/` and was missed entirely by the enumerated list. Matching the
 * section and letting `extract` decide whether a posting is actually present is
 * more robust and no broader in reach — the manifest still scopes the content
 * script to the jobs section.
 */
const JOB_PATHS = [/^\/jobs(\/|$)/];
const COMPANY_PATH = /^\/company\/([^/]+)/;

const SELECTORS = {
  jobTitle: [
    '.job-details-jobs-unified-top-card__job-title h1',
    '.job-details-jobs-unified-top-card__job-title',
    '.jobs-unified-top-card__job-title',
    '.top-card-layout__title',
    'h1.t-24',
  ],
  companyName: [
    '.job-details-jobs-unified-top-card__company-name a',
    '.job-details-jobs-unified-top-card__company-name',
    '.jobs-unified-top-card__company-name a',
    '.jobs-unified-top-card__company-name',
    '.topcard__org-name-link',
    '.top-card-layout__second-subline a',
  ],
  companyLink: [
    '.job-details-jobs-unified-top-card__company-name a',
    '.jobs-unified-top-card__company-name a',
    '.topcard__org-name-link',
  ],
  description: [
    '.jobs-description__content .jobs-box__html-content',
    '.jobs-description__content',
    '#job-details',
    '.jobs-box__html-content',
    '.description__text',
    '.show-more-less-html__markup',
  ],
  location: [
    '.job-details-jobs-unified-top-card__primary-description-container',
    '.jobs-unified-top-card__primary-description',
    '.jobs-unified-top-card__bullet',
    '.topcard__flavor--bullet',
    '.top-card-layout__second-subline',
  ],
  jobAnchor: [
    '.job-details-jobs-unified-top-card__container--two-pane',
    '.jobs-unified-top-card',
    '.jobs-details__main-content .jobs-box',
    '.top-card-layout',
  ],
  orgName: [
    '.org-top-card-summary__title',
    'h1.org-top-card-summary__title',
    '.top-card-layout__title',
  ],
  orgWebsite: [
    '.org-top-card-primary-actions a[href^="http"]:not([href*="linkedin.com"])',
    '.org-about-module__company-page-url a',
    'a.org-top-card-summary-info-list__info-item[href^="http"]',
  ],
  orgAnchor: ['.org-top-card', '.org-top-card-summary-info-list', '.scaffold-layout__main'],
} as const;

export const linkedInAdapter: JobBoardAdapter = {
  id: 'linkedin',
  label: 'LinkedIn',

  matches(url) {
    return url.hostname === 'www.linkedin.com' || url.hostname === 'linkedin.com';
  },

  detectPageType(url) {
    if (COMPANY_PATH.test(url.pathname)) return 'company';
    if (JOB_PATHS.some((pattern) => pattern.test(url.pathname))) return 'job_posting';
    return null;
  },

  extract(url, doc) {
    const pageType = this.detectPageType(url, doc);
    if (pageType === 'company') return extractCompanyPage(url, doc);
    if (pageType === 'job_posting') return extractJobPosting(url, doc);
    return null;
  },

  findPanelAnchor(pageType, doc) {
    const selectors = pageType === 'company' ? SELECTORS.orgAnchor : SELECTORS.jobAnchor;
    return safeQuery(doc, [...selectors]) ?? null;
  },
};

/**
 * Reports which selector groups currently match, for the console.
 *
 * Called only after extraction has failed repeatedly. Selector rot is the
 * expected failure mode of this file, and the difference between "the content
 * script never ran" and "it ran but every selector missed" is otherwise
 * invisible — both look like a page with no panel.
 */
export function diagnose(doc: Document): Record<string, string> {
  const report: Record<string, string> = {};

  for (const [field, selectors] of Object.entries(SELECTORS)) {
    const hit = [...selectors].find((selector) => {
      try {
        return doc.querySelector(selector) !== null;
      } catch {
        return false;
      }
    });
    report[field] = hit ? `matched: ${hit}` : `NO MATCH (tried ${selectors.length})`;
  }

  return report;
}

function extractJobPosting(url: URL, doc: Document): PageContext | null {
  const companyName = safeText(doc, [...SELECTORS.companyName]);
  // On the search and collections pages the right-hand pane renders after the
  // list. No company name yet means "not ready", not "not a job page" — the
  // caller retries on the next mutation.
  if (!companyName) return null;

  const jobDescription = safeBlockText(doc, [...SELECTORS.description]);
  const jobTitle = safeText(doc, [...SELECTORS.jobTitle]);
  const location = safeText(doc, [...SELECTORS.location]);

  return {
    board: 'linkedin',
    pageType: 'job_posting',
    company: { name: cleanCompanyName(companyName), slug: companySlugFromLink(doc) },
    jobDescription,
    jobTitle,
    country: inferCountry(location),
    key: jobKey(url, companyName),
  };
}

function extractCompanyPage(url: URL, doc: Document): PageContext | null {
  const slug = COMPANY_PATH.exec(url.pathname)?.[1];
  if (!slug) return null;

  // Prefer the rendered organisation name; fall back to a de-slugged form so the
  // panel still works before the top card hydrates.
  const name = safeText(doc, [...SELECTORS.orgName]) ?? deslugify(slug);

  return {
    board: 'linkedin',
    pageType: 'company',
    company: { name: cleanCompanyName(name), slug },
    key: `linkedin:company:${slug}`,
  };
}

/**
 * Reads the company slug out of the link LinkedIn already rendered on the page.
 *
 * This is reading a page the user is looking at, which is the only kind of data
 * access this project does on a job board. Nothing here fetches, searches, or
 * navigates on the user's behalf.
 */
function companySlugFromLink(doc: Document): string | undefined {
  const link = safeQuery(doc, [...SELECTORS.companyLink]) as HTMLAnchorElement | undefined;
  const href = link?.getAttribute('href');
  if (!href) return undefined;
  try {
    const parsed = new URL(href, 'https://www.linkedin.com');
    return COMPANY_PATH.exec(parsed.pathname)?.[1];
  } catch {
    return undefined;
  }
}

/**
 * Reads the employer's own website from their LinkedIn company page.
 *
 * Their own site is fair game to fetch normally (Feature 4's leadership-page
 * lookup); LinkedIn is not. This only reads the link LinkedIn has already
 * rendered — it does not follow it.
 */
export function companyWebsite(doc: Document): string | undefined {
  const link = safeQuery(doc, [...SELECTORS.orgWebsite]) as HTMLAnchorElement | undefined;
  const href = link?.getAttribute('href');
  if (!href) return undefined;
  try {
    const parsed = new URL(href);
    // LinkedIn wraps outbound links in a redirector; unwrap when it does.
    if (parsed.hostname.endsWith('linkedin.com')) {
      const target = parsed.searchParams.get('url');
      return target ? new URL(target).hostname : undefined;
    }
    return parsed.hostname;
  } catch {
    return undefined;
  }
}

/**
 * Strips the decoration LinkedIn appends to employer names.
 *
 * The company-name node often contains a trailing follower count or a verified
 * badge's text, and on some layouts the name is duplicated ("Stripe Stripe").
 */
export function cleanCompanyName(raw: string): string {
  let name = raw.replace(/\s+/g, ' ').trim();
  name = name.replace(/\s*·.*$/, '');
  name = name.replace(/\s*\d[\d,.]*\s*(followers?|employees?).*$/i, '');
  name = name.replace(/\s*\(verified\)\s*$/i, '');

  // Collapse an exact doubling: "Stripe Stripe" -> "Stripe".
  const halves = name.split(' ');
  if (halves.length % 2 === 0) {
    const mid = halves.length / 2;
    const first = halves.slice(0, mid).join(' ');
    const second = halves.slice(mid).join(' ');
    if (first === second) name = first;
  }

  return name.trim();
}

/** "acme-corp" -> "Acme Corp", used only until the real name renders. */
function deslugify(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/**
 * Stable identity for a rendered posting.
 *
 * On /jobs/search the posting id lives in the `currentJobId` query parameter and
 * the path never changes as the user clicks through results, so the path alone
 * would make every posting look like the same page and suppress re-rendering.
 */
export function jobKey(url: URL, companyName: string): string {
  const currentJobId = url.searchParams.get('currentJobId');
  const viewId = /^\/jobs\/view\/(\d+)/.exec(url.pathname)?.[1];
  const id = currentJobId ?? viewId ?? companyName;
  return `linkedin:job:${id}`;
}
