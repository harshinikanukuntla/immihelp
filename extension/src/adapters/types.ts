/**
 * The per-site adapter contract.
 *
 * Adding a job board means adding one module that implements this interface and
 * registering it — nothing in `src/content`, `src/background`, or `src/lib`
 * should ever need to know a site's name. See docs/adding-a-job-board.md.
 *
 * Adapters must be defensive. Job boards change their DOM without warning, and a
 * thrown selector error inside a content script takes the whole panel down. Every
 * extraction runs through `safeQuery`/`safeText` below, which log and return
 * undefined rather than throwing. A partially-extracted page renders a degraded
 * panel; it never renders wrong data and never crashes the host page.
 */
import type { PageContext } from '../types/domain';

export interface JobBoardAdapter {
  /** Stable id, used in cache keys and logs. */
  readonly id: string;
  /** Human-readable, shown in the panel footer. */
  readonly label: string;

  /** True if this adapter handles the given URL. Must be cheap and side-effect free. */
  matches(url: URL): boolean;

  /** Which kind of page this is, or null if it is a page we do not annotate. */
  detectPageType(url: URL, doc: Document): PageContext['pageType'] | null;

  /**
   * Pulls the company name, description, and related fields out of the DOM.
   *
   * Returns null when the page has not finished rendering the fields we need —
   * the caller retries on the next mutation rather than treating this as failure.
   */
  extract(url: URL, doc: Document): PageContext | null;

  /**
   * The element the panel is inserted after, or null if the anchor is not in the
   * DOM yet. Kept separate from `extract` because on single-page apps the data
   * and the layout container often appear on different frames.
   */
  findPanelAnchor(pageType: PageContext['pageType'], doc: Document): Element | null;
}

/** Namespaced console prefix so our logs are filterable in a noisy host page. */
const LOG = '[SponsorScope]';

/**
 * Runs a selector, swallowing any error. A broken or invalid selector after a site
 * redesign logs once and yields undefined instead of throwing into the content script.
 */
export function safeQuery(root: ParentNode, selectors: string[]): Element | undefined {
  for (const selector of selectors) {
    try {
      const el = root.querySelector(selector);
      if (el) return el;
    } catch (err) {
      console.debug(LOG, 'invalid selector', selector, err);
    }
  }
  return undefined;
}

/** Trimmed, whitespace-collapsed text for the first selector that hits. */
export function safeText(root: ParentNode, selectors: string[]): string | undefined {
  const el = safeQuery(root, selectors);
  if (!el) return undefined;
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  return text.length > 0 ? text : undefined;
}

/**
 * Like `safeText` but preserves line structure, which matters for job descriptions:
 * the phrase scanner splits on sentence and line boundaries, and collapsing a
 * bulleted list into one line merges unrelated clauses and defeats negation scoping.
 */
export function safeBlockText(root: ParentNode, selectors: string[]): string | undefined {
  const el = safeQuery(root, selectors);
  if (!el) return undefined;
  const text = (el as HTMLElement).innerText ?? el.textContent ?? '';
  const normalised = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
  return normalised.length > 0 ? normalised : undefined;
}

/** Wraps an adapter call so one misbehaving site module cannot break the content script. */
export function guard<T>(label: string, fn: () => T): T | null {
  try {
    return fn();
  } catch (err) {
    console.debug(LOG, `adapter step failed: ${label}`, err);
    return null;
  }
}
