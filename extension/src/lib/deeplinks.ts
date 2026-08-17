/**
 * Features 3 and 4 — deep links out to other sites' own search pages.
 *
 * ## What this module does not do
 *
 * It builds URLs. It does not fetch them, does not parse their results, and does
 * not aggregate anything. Every link opens in a new tab under the user's own
 * session, and the user chooses whether to click. That boundary is the whole
 * point: Glassdoor's interview data is behind a gated API and Blind has none, so
 * the honest version of "show me interview info" is a well-formed link, not a
 * scraper.
 *
 * The single exception is the employer's *own* website (see
 * `leadershipPageCandidates`), which is fetched normally and only after the user
 * grants host permission for that domain.
 *
 * ## A caveat on the LinkedIn URLs
 *
 * LinkedIn changes its search query parameters periodically, and the shapes below
 * reflect the scheme as documented at time of writing rather than a scheme
 * verified against a live logged-in session. Before release, run one search
 * manually on LinkedIn, copy the resulting URL, and reconcile it with
 * `PEOPLE_SEARCH_PARAM` and `companyPeopleUrl` below. This is called out in
 * README.md's roadmap as a pre-release checklist item.
 */

/** Roles worth reaching out to, in the order most job seekers want them. */
export const REFERRAL_ROLES = [
  { id: 'recruiter', label: 'Technical recruiter', keywords: 'technical recruiter' },
  { id: 'em', label: 'Engineering manager', keywords: 'engineering manager' },
  { id: 'director', label: 'Director of engineering', keywords: 'director of engineering' },
  { id: 'peer', label: 'Senior software engineer', keywords: 'senior software engineer' },
] as const;

export type ReferralRole = (typeof REFERRAL_ROLES)[number];

/** The query parameter LinkedIn's people search reads. Verify before release. */
const PEOPLE_SEARCH_PARAM = 'keywords';

export interface DeepLink {
  label: string;
  url: string;
  /** Shown as a caveat under the link when the link is known to be noisy. */
  note?: string;
}

/**
 * Company-scoped people search, for when we know the LinkedIn company slug.
 *
 * The slug is read out of the page the user is already on — see
 * `companySlugFromLink` in the LinkedIn adapter.
 */
export function companyPeopleUrl(slug: string, role: ReferralRole): string {
  const url = new URL(`https://www.linkedin.com/company/${encodeURIComponent(slug)}/people/`);
  url.searchParams.set(PEOPLE_SEARCH_PARAM, role.keywords);
  return url.toString();
}

/**
 * Global people search, used when there is no company page in context.
 *
 * Materially noisier than the company-scoped version: LinkedIn's company filter
 * needs a numeric company id we do not have, so this matches the company name as
 * free text and will return people who merely mention the company. The UI says so.
 */
export function globalPeopleUrl(companyName: string, role: ReferralRole): string {
  const url = new URL('https://www.linkedin.com/search/results/people/');
  url.searchParams.set(PEOPLE_SEARCH_PARAM, `${companyName} ${role.keywords}`);
  return url.toString();
}

export function referralLinks(
  companyName: string,
  slug: string | undefined,
): { links: DeepLink[]; scoped: boolean } {
  const scoped = Boolean(slug);
  const links = REFERRAL_ROLES.map((role) => ({
    label: role.label,
    url: slug ? companyPeopleUrl(slug, role) : globalPeopleUrl(companyName, role),
  }));

  return { links, scoped };
}

/** Feature 3 — interview process. Three links, no aggregation. */
export function interviewLinks(companyName: string): DeepLink[] {
  const quoted = `"${companyName}"`;
  return [
    {
      label: 'Glassdoor interviews',
      url: `https://www.glassdoor.com/Search/results.htm?keyword=${encodeURIComponent(companyName)}`,
      note: 'Opens Glassdoor’s own company search. Interview pages may require a Glassdoor account.',
    },
    {
      label: 'Blind discussions',
      url: googleSiteSearch('teamblind.com', `${quoted} interview`),
    },
    {
      label: 'Interview write-ups on the web',
      url: googleSearch(`${quoted} interview process questions`),
    },
  ];
}

function googleSiteSearch(site: string, query: string): string {
  return googleSearch(`site:${site} ${query}`);
}

function googleSearch(query: string): string {
  const url = new URL('https://www.google.com/search');
  url.searchParams.set('q', query);
  return url.toString();
}

/**
 * Likely paths for an employer's own leadership page.
 *
 * Their site, not LinkedIn's, so an ordinary fetch is appropriate — but only
 * after `chrome.permissions.request` grants access to that specific origin, which
 * the UI asks for explicitly rather than taking a blanket all-hosts permission
 * up front.
 */
export function leadershipPageCandidates(domain: string): string[] {
  const paths = ['/team', '/about/team', '/leadership', '/about/leadership', '/about', '/company/team'];
  return paths.map((path) => `https://${domain}${path}`);
}

/** Searches LinkedIn for a named person at a company, from the employer's own site. */
export function personSearchUrl(personName: string, companyName: string): string {
  const url = new URL('https://www.linkedin.com/search/results/people/');
  url.searchParams.set(PEOPLE_SEARCH_PARAM, `${personName} ${companyName}`);
  return url.toString();
}

/**
 * Pre-filled GitHub issue for a wrong entity match.
 *
 * A link rather than an endpoint, deliberately: a report form on our backend
 * would mean accepting user-submitted content tied to a browsing context, which
 * is exactly the kind of data this project promises not to hold. The report goes
 * to a public issue tracker, and the user sees everything in it before sending.
 */
export function mismatchReportUrl(
  repo: string,
  queriedName: string,
  matchedName: string,
  pageUrl: string,
): string {
  const url = new URL(`https://github.com/${repo}/issues/new`);
  url.searchParams.set('labels', 'entity-resolution');
  url.searchParams.set('title', `Wrong match: "${queriedName}" → "${matchedName}"`);
  url.searchParams.set(
    'body',
    [
      '**Company name on the job board:** ' + queriedName,
      '**Name we matched it to:** ' + matchedName,
      '**Page type:** ' + (pageUrl.includes('/company/') ? 'company page' : 'job posting'),
      '',
      '**What is wrong:**',
      '<!-- e.g. this is a different company, or a subsidiary, or a staffing agency -->',
      '',
      '---',
      '_Reported from the SponsorScope extension. No page contents or personal data are included._',
    ].join('\n'),
  );
  return url.toString();
}
