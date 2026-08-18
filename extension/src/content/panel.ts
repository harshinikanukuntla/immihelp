/**
 * Panel rendering.
 *
 * Built with explicit DOM calls rather than an HTML string. The panel displays
 * company names and job-description excerpts pulled from a third-party page; a
 * template-literal renderer would make an injection bug one careless
 * interpolation away, and `textContent` makes it structurally impossible.
 *
 * ## The distinctions this UI exists to preserve
 *
 * 1. **Verified vs. unverified.** Government-sourced results are green with a
 *    solid border and a check icon. Posting-text results are amber with a dashed
 *    border and an info icon. Different hue, different border style, different
 *    icon, different words — four channels, so no single-channel impairment
 *    collapses them.
 * 2. **No record vs. does not sponsor.** These render as different states with
 *    different copy. "No record found" says outright that it is not a negative
 *    signal, because a user glancing at a grey badge will otherwise read it as one.
 * 3. **Certain vs. possible.** A low-confidence entity match never renders as a
 *    fact. It gets the unverified treatment plus an explicit "verify
 *    independently" line and a report link.
 */
import type {
  PageContext,
  PostingSignal,
  ResumeAnalysis,
  SponsorshipRecord,
  SponsorshipVerdict,
} from '../types/domain';
import { countryLabel } from '../lib/country';
import { interviewLinks, referralLinks } from '../lib/deeplinks';
import { send } from '../lib/messages';
import tokensCss from '../design/tokens.css';
import panelCss from './panel.css';

export const PANEL_HOST_ID = 'sponsorscope-panel-host';

type Tone = 'verified' | 'unverified' | 'none' | 'negative';

/** Human-readable labels for the metric keys the ETL emits. */
const METRIC_LABELS: Record<string, string> = {
  h1b_initial_approvals: 'H-1B initial approvals',
  h1b_initial_denials: 'H-1B initial denials',
  h1b_continuing_approvals: 'H-1B continuing approvals',
  h1b_continuing_denials: 'H-1B continuing denials',
  perm_certified: 'PERM certifications',
  perm_denied: 'PERM denials',
  lmia_positive_positions: 'Positive LMIA positions',
  lmia_approved: 'Approved LMIAs',
  uk_licensed_sponsor: 'Licensed sponsor',
};

export class Panel {
  readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  private readonly container: HTMLElement;

  constructor() {
    this.host = document.createElement('div');
    this.host.id = PANEL_HOST_ID;
    // Shadow DOM in closed mode: the host page cannot reach into our tree, and
    // its stylesheet cannot reach in either.
    this.root = this.host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = `${tokensCss}\n${panelCss}`;
    this.root.append(style);

    this.container = el('div', { class: 'ss-root' });
    this.container.setAttribute('role', 'complementary');
    this.container.setAttribute('aria-label', 'SponsorScope visa sponsorship information');
    this.root.append(this.container);
  }

  /** Replaces the panel body. Called on every state change. */
  private replace(...children: Node[]): void {
    this.container.replaceChildren(...children);
  }

  renderLoading(context: PageContext): void {
    const section = el('div', { class: 'ss-section' });
    section.append(
      el('p', { class: 'ss-section-title' }, 'Checking sponsorship records'),
      el('div', { class: 'ss-skeleton', style: 'width: 60%' }),
      el('div', { class: 'ss-skeleton', style: 'width: 85%' }),
    );
    section.setAttribute('aria-busy', 'true');
    this.replace(this.header(context), section, disclaimer());
  }

  render(
    context: PageContext,
    verdict: SponsorshipVerdict,
    signal: PostingSignal | null,
    analysis: ResumeAnalysis | null,
    matchReason: string | undefined,
    showDeepLinks: boolean,
  ): void {
    const sections: Node[] = [this.header(context)];

    sections.push(this.sponsorshipSection(context, verdict, signal));

    // Posting-text detection is a fallback for countries no register covers. It
    // is also shown alongside a verified result when the posting says something
    // explicit, because "we do not sponsor for this role" is newer and more
    // specific than a filing history.
    if (signal && signal.polarity !== 'none') {
      sections.push(this.postingSignalSection(signal));
    }

    if (context.pageType === 'job_posting') {
      sections.push(this.resumeSection(analysis, matchReason));
    }

    if (showDeepLinks) sections.push(this.linksSection(context));
    sections.push(disclaimer());

    this.replace(...sections);
  }

  // --- Header ---------------------------------------------------------------

  private header(context: PageContext): HTMLElement {
    const header = el('div', { class: 'ss-header' });
    header.append(
      el('span', { class: 'ss-wordmark' }, 'SponsorScope'),
      el('span', { class: 'ss-company' }, context.company.name),
      el('div', { class: 'ss-header-spacer' }),
    );

    const settings = el('button', { class: 'ss-button ss-button--ghost', type: 'button' });
    settings.setAttribute('aria-label', 'Open SponsorScope settings');
    settings.append(icon('gear'), el('span', { class: 'ss-sr-only' }, 'Settings'));
    settings.addEventListener('click', () => {
      void send({ type: 'open_url', url: chrome.runtime.getURL('options.html') });
    });
    header.append(settings);

    return header;
  }

  // --- Sponsorship ----------------------------------------------------------

  private sponsorshipSection(
    context: PageContext,
    verdict: SponsorshipVerdict,
    signal: PostingSignal | null,
  ): HTMLElement {
    const section = el('div', { class: 'ss-section' });
    section.append(el('p', { class: 'ss-section-title' }, 'Sponsorship history'));

    switch (verdict.kind) {
      case 'verified':
        return this.renderVerified(section, context, verdict, signal);
      case 'no_record':
        return this.renderNoRecord(section, verdict);
      case 'does_not_sponsor':
        return this.renderDoesNotSponsor(section, verdict);
      case 'error':
        section.append(
          badge('none', 'info', 'Lookup unavailable'),
          el('p', { class: 'ss-meta' }, verdict.message),
        );
        return section;
    }
  }

  private renderVerified(
    section: HTMLElement,
    context: PageContext,
    verdict: Extract<SponsorshipVerdict, { kind: 'verified' }>,
    signal: PostingSignal | null,
  ): HTMLElement {
    const { match, records } = verdict;
    const isCertain = match.confidence === 'high' || match.confidence === 'probable';

    /**
     * The most important case in the whole panel: the company has filed before,
     * and *this posting* says it will not sponsor.
     *
     * History and this posting answer different questions. "Have they ever
     * sponsored?" is about the company. "Will they sponsor for this role?" is
     * about the job, and it is the one the reader is actually deciding on. When
     * the two disagree, the posting is more specific and more recent, so it
     * leads — and the filing history stays visible underneath as context rather
     * than being suppressed.
     */
    if (signal?.polarity === 'negative') {
      section.append(
        badge('negative', 'cross', 'This posting rules out sponsorship'),
        el(
          'p',
          { class: 'ss-body', style: 'margin-top: var(--ss-space-sm)' },
          'The posting states that sponsorship is not available for this role. That is ' +
            'more specific and more recent than the filing history below, so treat it ' +
            'as the answer for this job.',
        ),
        el(
          'p',
          { class: 'ss-meta' },
          `${match.canonicalName} has sponsored in the past — ${describeHistory(records)} — ` +
            'which may still make them worth approaching about other roles.',
        ),
      );
    }


    // A possible-only match is never dressed as a verified fact, even though the
    // underlying figures are genuinely government-sourced. The uncertainty is
    // about *which company they describe*, which is the part that matters.
    if (signal?.polarity !== 'negative') {
      section.append(
        isCertain
          ? badge('verified', 'check', 'Found in government records')
          : badge('unverified', 'info', 'Possible match — verify independently'),
      );
    }

    if (match.canonicalName.toLowerCase() !== match.queriedName.toLowerCase()) {
      section.append(
        el(
          'p',
          { class: 'ss-meta' },
          `Matched “${match.queriedName}” to “${match.canonicalName}”.`,
        ),
      );
    }

    if (!isCertain) {
      section.append(
        el(
          'p',
          { class: 'ss-meta' },
          'The name on this posting does not clearly match a single filing entity. ' +
            'The figures below may describe a different company.',
        ),
      );
    }

    if (match.warnings.includes('staffing_agency')) {
      section.append(
        el(
          'p',
          { class: 'ss-meta' },
          'This looks like a staffing or consulting firm. Its sponsorship volume ' +
            'describes the agency, not the client company you would work with.',
        ),
      );
    }

    for (const record of records) {
      section.append(this.recordBlock(record));
    }

    section.append(this.reportRow(context, match.canonicalName));
    return section;
  }

  private recordBlock(record: SponsorshipRecord): HTMLElement {
    const block = el('div');
    const yearRange = formatYears(record.years);

    block.append(
      el(
        'p',
        { class: 'ss-headline', style: 'margin-top: var(--ss-space-md)' },
        yearRange
          ? `${countryLabel(record.country)} · ${yearRange}`
          : countryLabel(record.country),
      ),
    );

    const metrics = el('ul', { class: 'ss-metrics' });
    for (const [key, value] of Object.entries(record.metrics)) {
      const item = el('li', { class: 'ss-metric' });
      // The UK register is a status flag, not a count; rendering "1" would be
      // meaningless, so flag-shaped metrics get words instead of a number.
      const isFlag = key === 'uk_licensed_sponsor';
      item.append(
        el('div', { class: 'ss-metric-value' }, isFlag ? 'Yes' : formatNumber(value)),
        el('div', { class: 'ss-metric-label' }, METRIC_LABELS[key] ?? key),
      );
      metrics.append(item);
    }
    block.append(metrics);

    // Provenance is mandatory on every figure, never a tooltip or a footnote.
    for (const source of record.sources) {
      const line = el('p', { class: 'ss-source' });
      line.append(document.createTextNode(`As of ${formatDate(source.publishedDate)} · source: `));
      const link = el('a', {
        href: source.url,
        target: '_blank',
        rel: 'noopener noreferrer',
      }, source.publisher);
      line.append(link, document.createTextNode(` (${source.label})`));
      block.append(line);
    }

    return block;
  }

  private renderNoRecord(
    section: HTMLElement,
    verdict: Extract<SponsorshipVerdict, { kind: 'no_record' }>,
  ): HTMLElement {
    section.append(badge('none', 'search', 'No record found'));
    section.append(
      el(
        'p',
        { class: 'ss-body', style: 'margin-top: var(--ss-space-sm)' },
        `We could not find “${verdict.queriedName}” in the registers we hold` +
          (verdict.countriesChecked.length > 0
            ? ` (${verdict.countriesChecked.map(countryLabel).join(', ')}).`
            : '.'),
      ),
    );
    // The single most important sentence in the whole panel.
    section.append(
      el(
        'p',
        { class: 'ss-meta' },
        'This is not a sign that they do not sponsor. Small employers, recent ' +
          'sponsors, and companies filing under a parent or subsidiary name are ' +
          'routinely absent from these datasets.',
      ),
    );
    return section;
  }

  private renderDoesNotSponsor(
    section: HTMLElement,
    verdict: Extract<SponsorshipVerdict, { kind: 'does_not_sponsor' }>,
  ): HTMLElement {
    section.append(badge('negative', 'cross', 'Record indicates no sponsorship'));
    section.append(el('p', { class: 'ss-body' }, verdict.note));
    for (const source of verdict.sources) {
      section.append(
        el(
          'p',
          { class: 'ss-source' },
          `As of ${formatDate(source.publishedDate)} · source: ${source.publisher}`,
        ),
      );
    }
    return section;
  }

  private reportRow(context: PageContext, matchedName: string): HTMLElement {
    const row = el('p', { class: 'ss-meta' });
    const button = el('button', { class: 'ss-button ss-button--ghost', type: 'button' },
      'This doesn’t look like the right company');
    button.addEventListener('click', () => {
      void send({ type: 'report_mismatch', context, matchedName });
    });
    row.append(button);
    return row;
  }

  // --- Feature 1b -----------------------------------------------------------

  private postingSignalSection(signal: PostingSignal): HTMLElement {
    const section = el('div', { class: 'ss-section' });
    section.append(el('p', { class: 'ss-section-title' }, 'What this posting says'));

    section.append(
      signal.polarity === 'positive'
        ? badge('unverified', 'info', 'Sponsorship mentioned — not independently verified')
        : badge('unverified', 'info', 'Posting appears to rule out sponsorship'),
    );

    section.append(
      el(
        'p',
        { class: 'ss-meta' },
        signal.polarity === 'positive'
          ? 'Taken from the posting’s own wording. We have not confirmed this against any register.'
          : 'Taken from the posting’s own wording. Read the full description before ruling the role out.',
      ),
    );

    // Quote the source text rather than paraphrasing it, so the user can judge
    // our reading for themselves.
    for (const quote of signal.evidence) {
      section.append(el('blockquote', { class: 'ss-quote' }, `“${quote}”`));
    }

    return section;
  }

  // --- Feature 2 ------------------------------------------------------------

  private resumeSection(
    analysis: ResumeAnalysis | null,
    reason: string | undefined,
  ): HTMLElement {
    const section = el('div', { class: 'ss-section' });
    section.append(el('p', { class: 'ss-section-title' }, 'Resume match'));

    if (!analysis) {
      section.append(el('p', { class: 'ss-body' }, resumeEmptyCopy(reason)));
      if (reason === 'no_resume') {
        const button = el('button', { class: 'ss-link', type: 'button' }, 'Add your resume');
        button.addEventListener('click', () => {
          void send({ type: 'open_url', url: chrome.runtime.getURL('options.html') });
        });
        section.append(el('p', { class: 'ss-meta' }, button));
      }
      return section;
    }

    const { ats, semantic } = analysis;

    const row = el('div', { class: 'ss-score-row' });
    row.append(
      el('span', { class: 'ss-score' }, `${ats.score}%`),
      el(
        'span',
        { class: 'ss-score-suffix' },
        `keyword match · ${ats.matchedTerms} of ${ats.totalTerms} terms`,
      ),
    );
    section.append(row);

    const meter = el('div', { class: 'ss-meter' });
    meter.setAttribute('role', 'meter');
    meter.setAttribute('aria-valuenow', String(ats.score));
    meter.setAttribute('aria-valuemin', '0');
    meter.setAttribute('aria-valuemax', '100');
    meter.setAttribute('aria-label', 'Keyword match against this job description');
    meter.append(el('div', { class: 'ss-meter-fill', style: `width: ${ats.score}%` }));
    section.append(meter);

    section.append(el('p', { class: 'ss-body' }, ats.summary));

    // The headline of this section: concrete, ranked, with the exact resulting
    // score. Each projection is arithmetic over the scoring function, not a guess.
    if (ats.suggestions.length > 0) {
      section.append(
        el(
          'p',
          { class: 'ss-section-title', style: 'margin-top: var(--ss-space-md)' },
          `Top ${ats.suggestions.length} additions`,
        ),
      );

      const list = el('ol', { class: 'ss-suggestions' });
      for (const suggestion of ats.suggestions) {
        const item = el('li', { class: 'ss-suggestion' });
        item.append(
          el('span', { class: 'ss-suggestion-term' }, suggestion.term),
          el(
            'span',
            { class: 'ss-suggestion-gain' },
            `${ats.score}% → ${suggestion.projectedScore}%`,
          ),
        );
        if (suggestion.inRequirements) {
          item.append(el('span', { class: 'ss-suggestion-tag' }, 'in requirements'));
        }
        list.append(item);
      }
      section.append(list);

      if (ats.projectedAll > ats.score) {
        section.append(
          el(
            'p',
            { class: 'ss-meta' },
            `Covering all ${ats.suggestions.length} would put you at about ${ats.projectedAll}%. ` +
              'Only add what is genuinely true of your experience.',
          ),
        );
      }
    }

    // Shown second and smaller: it measures something real that keyword matching
    // cannot see, but it is a fuzzy number and should not compete with the
    // explainable one for attention.
    if (semantic) {
      section.append(
        el(
          'p',
          { class: 'ss-meta' },
          `Semantic similarity: ${semantic.score}/100 (${semantic.band}). ` +
            'This reads meaning rather than exact words, so it can credit experience ' +
            'you described differently.',
        ),
      );
    }

    section.append(
      el(
        'p',
        { class: 'ss-meta' },
        'Computed on your device; your resume is never uploaded. This models common ' +
          'keyword screening, not any specific employer’s system.',
      ),
    );
    return section;
  }

  // --- Features 3 and 4 -----------------------------------------------------

  private linksSection(context: PageContext): HTMLElement {
    const section = el('div', { class: 'ss-section' });
    const name = context.company.name;

    section.append(el('p', { class: 'ss-section-title' }, 'Interview process'));
    section.append(linkList(interviewLinks(name)));

    const { links, scoped } = referralLinks(name, context.company.slug);
    section.append(
      el('p', { class: 'ss-section-title', style: 'margin-top: var(--ss-space-lg)' }, 'Find a referral'),
    );
    section.append(linkList(links));
    if (!scoped) {
      section.append(
        el(
          'p',
          { class: 'ss-meta' },
          'No LinkedIn company page in context, so these search the whole of LinkedIn ' +
            'by keyword and will be noisier than a company-scoped search.',
        ),
      );
    }

    section.append(
      el('p', { class: 'ss-meta' }, 'Links open in a new tab. We never search on your behalf.'),
    );
    return section;
  }
}

// --- Building blocks --------------------------------------------------------

function linkList(links: Array<{ label: string; url: string; note?: string }>): HTMLElement {
  const list = el('ul', { class: 'ss-links' });
  for (const link of links) {
    const item = el('li');
    const anchor = el(
      'a',
      { class: 'ss-link', href: link.url, target: '_blank', rel: 'noopener noreferrer' },
      link.label,
    );
    if (link.note) anchor.title = link.note;
    item.append(anchor);
    list.append(item);
  }
  return list;
}

/**
 * A status badge. Colour is one of four channels here, never the only one —
 * the icon, the border style, and the label all carry the same distinction.
 */
function badge(tone: Tone, iconName: IconName, label: string): HTMLElement {
  const element = el('span', { class: `ss-badge ss-badge--${tone}` });
  element.append(icon(iconName), document.createTextNode(label));
  return element;
}

function disclaimer(): HTMLElement {
  return el(
    'div',
    { class: 'ss-disclaimer' },
    'Informational signals from public government data. Not legal or immigration ' +
      'advice, and not a guarantee of current company policy.',
  );
}

type IconName = 'check' | 'info' | 'search' | 'cross' | 'gear';

const ICON_PATHS: Record<IconName, string> = {
  check: 'M20 6 9 17l-5-5',
  info: 'M12 16v-4M12 8h.01M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18Z',
  search: 'M21 21l-4.35-4.35M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16Z',
  cross: 'M18 6 6 18M6 6l12 12',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z',
};

function icon(name: IconName): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  // Decorative: the adjacent text label is the accessible name.
  svg.setAttribute('aria-hidden', 'true');

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICON_PATHS[name]);
  svg.append(path);
  return svg;
}

/**
 * Creates an element with attributes and children.
 *
 * String children become text nodes via `textContent`, so company names and
 * job-description excerpts from a third-party page are never parsed as markup.
 */
function el(
  tag: string,
  attrs: Record<string, string> = {},
  ...children: Array<string | Node>
): HTMLElement {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    element.setAttribute(key, value);
  }
  for (const child of children) {
    element.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return element;
}

function resumeEmptyCopy(reason: string | undefined): string {
  switch (reason) {
    case 'no_resume':
      return 'Add your resume to see how closely it matches this posting. It stays on your device.';
    case 'no_description':
      return 'This posting does not have enough description text to compare against.';
    case 'disabled':
      return 'Resume matching is turned off in settings.';
    case 'embedding_failed':
      return 'The on-device model could not run here. Try reloading the page.';
    default:
      return 'Resume matching is unavailable for this posting.';
  }
}

function formatNumber(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function formatDate(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * One clause summarising a filing history, for the conflict case.
 *
 * Answers "when did they last file, and roughly how much?" — the two things
 * that decide whether a past sponsor is still worth approaching.
 */
export function describeHistory(records: SponsorshipRecord[]): string {
  const years = records.flatMap((record) => record.years);
  const latest = years.length > 0 ? Math.max(...years) : null;

  const total = records.reduce((sum, record) => {
    for (const [metric, value] of Object.entries(record.metrics)) {
      // Approvals only: denials and status flags are not volume.
      if (metric.includes('approval') || metric.includes('certified') || metric.includes('positions')) {
        sum += value;
      }
    }
    return sum;
  }, 0);

  if (latest === null) return 'they hold a current sponsor licence';
  if (total <= 0) return `they last appear in the data for ${latest}`;
  return `about ${Math.round(total).toLocaleString()} approvals, most recently in ${latest}`;
}

/** "2021–2024" for a contiguous run, "2019, 2021" otherwise, "" when unknown. */
export function formatYears(years: number[]): string {
  if (years.length === 0) return '';
  if (years.length === 1) return String(years[0]);

  const sorted = [...years].sort((a, b) => a - b);
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const contiguous = sorted.every((year, index) => year === first + index);

  return contiguous ? `${first}–${last}` : sorted.join(', ');
}
