/**
 * Content script entry point.
 *
 * ## Detecting navigation on a single-page app
 *
 * LinkedIn routes client-side: clicking a result in the jobs list swaps the
 * right-hand pane and rewrites the URL without any page load. A content script
 * that runs once at `document_idle` annotates the first posting and then goes
 * quiet forever.
 *
 * The obvious fix — monkey-patching `history.pushState` — **does not work here**,
 * and it is worth writing down why, because it looks like it should. Content
 * scripts run in an isolated JavaScript realm. Patching `history.pushState` in
 * that realm replaces *our* view of the function; LinkedIn's own bundle runs in
 * the page realm and calls the original. The patch never fires. Getting at the
 * page's `history` would mean injecting a script into the page realm, which adds
 * a remote-code-execution surface for no benefit.
 *
 * So navigation is detected by observing effects rather than intercepting calls:
 *
 * - a `MutationObserver` on the document, which fires when the pane swaps, and
 * - a `location.href` comparison on each batch of mutations, and
 * - `popstate`, which is a window event and does reach the isolated realm, for
 *   back/forward.
 *
 * Mutation callbacks are debounced because LinkedIn mutates the DOM constantly;
 * the work behind them is idempotent and keyed on the page context, so a
 * spurious wake-up costs one comparison and nothing else.
 *
 * ## Not double-injecting
 *
 * One `Panel` instance per frame, held in a module-level singleton, re-anchored
 * rather than recreated when the layout changes. `renderKey` short-circuits
 * re-renders for a page we have already drawn, which matters because the
 * observer fires far more often than the page actually changes.
 */
import { adapterFor } from '../adapters/registry';
import { diagnose } from '../adapters/linkedin';
import { guard, type JobBoardAdapter } from '../adapters/types';
import { Panel, PANEL_HOST_ID } from './panel';
import { detectSponsorshipSignal } from '../lib/sponsorship-phrases';
import { DEFAULT_SETTINGS, send, type Settings } from '../lib/messages';
import type { PageContext, PostingSignal, ResumeMatch } from '../types/domain';

const DEBOUNCE_MS = 400;
/** Extraction is retried while the SPA hydrates, then given up on. */
const MAX_EXTRACT_ATTEMPTS = 12;

let panel: Panel | null = null;
/** Context key currently rendered, so repeat mutations do not re-render. */
let renderKey: string | null = null;
/** Increments on every navigation; stale async work checks it and bails. */
let generation = 0;
let debounceTimer: number | undefined;
let attempts = 0;
/** Tracked separately from `attempts`: extraction succeeding and mounting failing
 *  are different faults with different fixes, and the logs say which. */
let anchorAttempts = 0;
let settings: Settings | null = null;

/**
 * Unconditional, so "did the content script run at all?" is answerable from the
 * console. Distinguishing that from "it ran and found nothing" was previously
 * impossible, and the two have completely different fixes.
 */
console.info(`[SponsorScope] content script loaded on ${location.pathname}`);

void start();

async function start(): Promise<void> {
  const response = await send({ type: 'get_settings' });

  if (response.ok) {
    settings = response.settings;
  } else {
    // Previously this returned, permanently disabling the panel with no log.
    // The service worker can be cold, mid-restart, or updating when a page
    // loads, and a transient messaging failure must not take the page out for
    // its whole lifetime. Defaults are safe: they are what a fresh install uses.
    console.warn(
      '[SponsorScope] could not read settings, continuing with defaults:',
      response.error,
    );
    settings = { ...DEFAULT_SETTINGS };
  }

  if (!settings.enabled) {
    console.info('[SponsorScope] panel disabled in settings');
    return;
  }

  observe();
  schedule();
}

function observe(): void {
  const observer = new MutationObserver(() => schedule());
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // Reaches the isolated realm because it is a window event, unlike pushState.
  window.addEventListener('popstate', () => {
    resetForNavigation();
    schedule();
  });
}

let lastHref = location.href;

function schedule(): void {
  if (location.href !== lastHref) {
    lastHref = location.href;
    resetForNavigation();
  }

  window.clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(() => void tick(), DEBOUNCE_MS);
}

function resetForNavigation(): void {
  renderKey = null;
  attempts = 0;
  anchorAttempts = 0;
  generation += 1;
}

async function tick(): Promise<void> {
  const url = new URL(location.href);
  const adapter = adapterFor(url);
  if (!adapter) return removePanel();

  const pageType = guard('detectPageType', () => adapter.detectPageType(url, document));
  if (!pageType) return removePanel();

  const context = guard('extract', () => adapter.extract(url, document));
  if (!context) {
    // The pane may not have rendered yet. Retry a bounded number of times rather
    // than either giving up immediately or spinning forever on a changed DOM.
    if (attempts++ < MAX_EXTRACT_ATTEMPTS) {
      window.setTimeout(() => void tick(), DEBOUNCE_MS);
    } else if (attempts === MAX_EXTRACT_ATTEMPTS + 1) {
      // Repeated failure on a page we do claim means the site's DOM moved.
      // Print which selectors still match so the fix is a one-line edit rather
      // than an investigation — see docs/adding-a-job-board.md.
      reportSelectorRot(adapter, pageType);
    }
    return;
  }

  if (context.key === renderKey) {
    ensureAnchored(adapter.findPanelAnchor(context.pageType, document));
    return;
  }

  renderKey = context.key;
  attempts = 0;
  const localGeneration = ++generation;

  const anchor = guard('findPanelAnchor', () => adapter.findPanelAnchor(context.pageType, document));
  if (!anchor) {
    // Data without a place to put it. The layout container often mounts a frame
    // after the content, so retrying is right — but this retry used to be
    // unbounded and silent, spinning every 400ms forever with no way to tell it
    // apart from a page where nothing had run at all.
    renderKey = null;
    if (anchorAttempts++ < MAX_EXTRACT_ATTEMPTS) {
      window.setTimeout(() => void tick(), DEBOUNCE_MS);
    } else if (anchorAttempts === MAX_EXTRACT_ATTEMPTS + 1) {
      console.warn(
        `[SponsorScope] Read this ${context.pageType} successfully but found nowhere ` +
          `to mount the panel after ${MAX_EXTRACT_ATTEMPTS} attempts.`,
        { company: context.company.name },
      );
      if (adapter.id === 'linkedin') console.table(diagnose(document));
    }
    return;
  }
  anchorAttempts = 0;

  const view = ensurePanel();
  mount(view, anchor);
  view.renderLoading(context);

  await hydrate(view, context, localGeneration);
}

/** Runs the three independent lookups and renders once they settle. */
async function hydrate(view: Panel, context: PageContext, localGeneration: number): Promise<void> {
  const signal = detectPostingSignal(context);

  const [verdict, resume] = await Promise.all([
    lookupSponsorship(context),
    matchResume(context),
  ]);

  // The user navigated while we were waiting; this result belongs to a page that
  // is no longer on screen.
  if (localGeneration !== generation) return;

  view.render(
    context,
    verdict,
    signal,
    resume.match,
    resume.reason,
    settings?.deepLinksEnabled ?? true,
  );
}

function detectPostingSignal(context: PageContext): PostingSignal | null {
  if (!settings?.postingScanEnabled) return null;
  if (!context.jobDescription) return null;

  // Scanned on every posting, not only where no register covers the country.
  // Feature 1b exists for uncovered countries, but the posting's own words are
  // worth showing next to a register hit too: a filing history is years old,
  // while "we are not sponsoring for this role" is about this role, today. The
  // panel labels the two differently, so showing both cannot blur them.
  return guard('detectSponsorshipSignal', () =>
    detectSponsorshipSignal(context.jobDescription ?? ''),
  );
}

async function lookupSponsorship(context: PageContext) {
  const response = await send({
    type: 'lookup_company',
    name: context.company.name,
    country: context.country,
  });

  if (!response.ok) {
    return { kind: 'error' as const, message: 'Could not reach the lookup service.' };
  }
  return response.verdict;
}

async function matchResume(
  context: PageContext,
): Promise<{ match: ResumeMatch | null; reason?: string }> {
  if (context.pageType !== 'job_posting' || !context.jobDescription) {
    return { match: null, reason: 'no_description' };
  }

  const response = await send({
    type: 'match_resume',
    jobDescription: context.jobDescription,
    jobKey: context.key,
  });

  if (!response.ok) return { match: null, reason: 'embedding_failed' };
  return { match: response.match, reason: response.reason };
}

// --- Mounting ---------------------------------------------------------------

function ensurePanel(): Panel {
  panel ??= new Panel();
  return panel;
}

/** Inserts the panel after the anchor, moving it if the anchor changed. */
function mount(view: Panel, anchor: Element): void {
  if (view.host.previousElementSibling === anchor && view.host.isConnected) return;

  // A stray host from a previous layout would otherwise linger after LinkedIn
  // re-renders the container our panel was inside.
  for (const stale of document.querySelectorAll(`#${PANEL_HOST_ID}`)) {
    if (stale !== view.host) stale.remove();
  }

  anchor.insertAdjacentElement('afterend', view.host);
}

function ensureAnchored(anchor: Element | null): void {
  if (panel && anchor && !panel.host.isConnected) mount(panel, anchor);
}

function removePanel(): void {
  panel?.host.remove();
  renderKey = null;
}

/**
 * Prints a selector report when a page we claim yields nothing.
 *
 * Silence is the worst outcome here: a stale selector and a content script that
 * never injected look identical from the outside. This distinguishes them and
 * names the field that broke.
 */
function reportSelectorRot(adapter: JobBoardAdapter, pageType: PageContext['pageType']): void {
  console.warn(
    `[SponsorScope] Could not read this ${pageType} on ${adapter.label} after ` +
      `${MAX_EXTRACT_ATTEMPTS} attempts. The site's markup has probably changed.`,
  );
  if (adapter.id === 'linkedin') {
    console.table(diagnose(document));
    console.warn(
      '[SponsorScope] Add the current class name to the front of the failing ' +
        'group in src/adapters/linkedin.ts, then rebuild.',
    );
  }
}
