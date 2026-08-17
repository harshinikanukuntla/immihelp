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
  /**
   * The right-hand pane on the two-pane layouts. Everything else is looked up
   * *inside* this, so a `/company/` link in a left-rail result card cannot be
   * mistaken for the company of the posting currently open.
   */
  detailsRoot: [
    // Ordered widest-first: the pane, then the layout, then the page's main
    // region. A narrow root (the top card alone) would exclude the description.
    '[class*="jobs-search__job-details"]',
    '[class*="jobs-details"]',
    '.job-view-layout',
    'main',
  ],
  jobTitle: [
    '.job-details-jobs-unified-top-card__job-title h1',
    '.job-details-jobs-unified-top-card__job-title',
    '.jobs-unified-top-card__job-title',
    '.top-card-layout__title',
    '[class*="job-title"] h1',
    '[class*="job-title"]',
    'h1.t-24',
  ],
  companyName: [
    '.job-details-jobs-unified-top-card__company-name a',
    '.job-details-jobs-unified-top-card__company-name',
    '.jobs-unified-top-card__company-name a',
    '.jobs-unified-top-card__company-name',
    '.topcard__org-name-link',
    '.top-card-layout__second-subline a',
    '[class*="company-name"] a',
    '[class*="company-name"]',
  ],
  companyLink: [
    '.job-details-jobs-unified-top-card__company-name a',
    '.jobs-unified-top-card__company-name a',
    '.topcard__org-name-link',
    '[class*="company-name"] a[href*="/company/"]',
  ],
  description: [
    '.jobs-description__content .jobs-box__html-content',
    '.jobs-description__content',
    '#job-details',
    '.jobs-box__html-content',
    '.description__text',
    '.show-more-less-html__markup',
    '[class*="jobs-description"]',
    '[class*="job-details"] [class*="html-content"]',
  ],
  location: [
    '.job-details-jobs-unified-top-card__primary-description-container',
    '.jobs-unified-top-card__primary-description',
    '.jobs-unified-top-card__bullet',
    '.topcard__flavor--bullet',
    '.top-card-layout__second-subline',
    '[class*="primary-description"]',
    '[class*="tvm__text"]',
  ],
  jobAnchor: [
    '.job-details-jobs-unified-top-card__container--two-pane',
    '.jobs-unified-top-card',
    '.jobs-details__main-content .jobs-box',
    '.top-card-layout',
    '[class*="job-details-jobs-unified-top-card"]',
    '[class*="jobs-unified-top-card"]',
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
    return safeQuery(doc, [...selectors]) ?? structuralAnchor(pageType, doc);
  },
};

/**
 * Anchor derived from a field we already located, for when no named container
 * matches.
 *
 * Walks up from the heading to the outermost element that is still inside the
 * details pane, which is the top card in every layout LinkedIn has shipped.
 * Without this the panel had data and nowhere to put it — and the old code
 * responded by retrying forever, silently.
 */
function structuralAnchor(
  pageType: PageContext['pageType'],
  doc: Document,
): Element | null {
  const root = detailsRoot(doc);
  const seed =
    pageType === 'company'
      ? safeQuery(doc, [...SELECTORS.orgName]) ?? safeQuery(doc, ['h1'])
      : safeQuery(root, [...SELECTORS.jobTitle]) ?? safeQuery(root, ['h1']);

  if (!seed) return null;
  if (root === (doc as ParentNode)) return seed.parentElement ?? seed;

  let node: Element = seed;
  while (node.parentElement && node.parentElement !== root && node.parentElement !== doc.body) {
    node = node.parentElement;
  }
  return node;
}

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

/**
 * The right-hand details pane, or the document if the layout is single-pane.
 *
 * Scoping matters on `/jobs/search-results/`: the left rail is full of result
 * cards that also link to `/company/`, so an unscoped structural lookup would
 * happily return the company of whatever job happens to be first in the list.
 */
function detailsRoot(doc: Document): ParentNode {
  return safeQuery(doc, [...SELECTORS.detailsRoot]) ?? doc;
}

/**
 * Company name without relying on a class name.
 *
 * LinkedIn's BEM classes are cosmetic and churn constantly — every named
 * selector above missed on a live page while the markup was perfectly readable.
 * A link to `/company/<slug>` inside the details pane is *semantic*: it is what
 * the element is for, not what it looks like this quarter, and it survives
 * restyling.
 */
function structuralCompany(doc: Document): { name: string; slug?: string } | undefined {
  const root = detailsRoot(doc);

  let links: Element[] = [];
  try {
    links = [...root.querySelectorAll('a[href*="/company/"]')];
  } catch {
    return undefined;
  }

  for (const link of links) {
    const text = (link.textContent ?? '').replace(/\s+/g, ' ').trim();
    // Skip "See all jobs", logo links, and other chrome that points at the
    // company but carries no name.
    if (!text || text.length > 120) continue;

    const href = link.getAttribute('href') ?? '';
    let slug: string | undefined;
    try {
      slug = COMPANY_PATH.exec(new URL(href, 'https://www.linkedin.com').pathname)?.[1];
    } catch {
      slug = undefined;
    }
    return { name: text, slug };
  }

  return undefined;
}

/** Longest text block in the details pane, used when no description selector hits. */
function structuralDescription(doc: Document): string | undefined {
  const root = detailsRoot(doc);

  let blocks: Element[] = [];
  try {
    blocks = [...root.querySelectorAll('article, section, div')];
  } catch {
    return undefined;
  }

  let best: { element: Element; length: number } | null = null;
  for (const element of blocks) {
    // Only consider leaf-ish containers, or every ancestor wins by containing
    // its children's text.
    if (element.querySelector('article, section') !== null) continue;
    const length = (element.textContent ?? '').trim().length;
    if (length > (best?.length ?? 0)) best = { element, length };
  }

  // A real job description is long. Anything short is navigation chrome.
  if (!best || best.length < 400) return undefined;

  const text = (best.element as HTMLElement).innerText ?? best.element.textContent ?? '';
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

function extractJobPosting(url: URL, doc: Document): PageContext | null {
  const root = detailsRoot(doc);

  /**
   * Named selectors are already specific to the details pane, so they are tried
   * scoped and then document-wide. Scoping exists to protect the *structural*
   * lookup from the left rail; applying it to precise selectors only creates a
   * way to miss an element that happens to be the scope root itself.
   */
  const named = (selectors: readonly string[]) =>
    safeText(root, [...selectors]) ?? safeText(doc, [...selectors]);

  // Named first — precise when they work. Structural is the safety net for when
  // LinkedIn restyles, which it does often.
  const structural = structuralCompany(doc);
  const companyName = named(SELECTORS.companyName) ?? structural?.name;

  // On the search and collections pages the right-hand pane renders after the
  // list. No company name yet means "not ready", not "not a job page" — the
  // caller retries on the next mutation.
  if (!companyName) return null;

  const jobDescription =
    safeBlockText(doc, [...SELECTORS.description]) ?? structuralDescription(doc);
  const jobTitle = named(SELECTORS.jobTitle) ?? safeText(root, ['h1']) ?? safeText(doc, ['h1']);
  const location = named(SELECTORS.location);

  return {
    board: 'linkedin',
    pageType: 'job_posting',
    company: {
      name: cleanCompanyName(companyName),
      slug: companySlugFromLink(doc) ?? structural?.slug,
    },
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
