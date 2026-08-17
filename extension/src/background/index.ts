/**
 * Service worker.
 *
 * Owns every side effect: network calls, persistent storage, and the offscreen
 * document that runs the embedding model. Content scripts send messages and
 * render what comes back — they hold no state and make no requests, so a job
 * board's CSP can never block us and the host page never sees our logic.
 */
import { lookupCompany } from './api';
import {
  MODEL_ID,
  buildMatch,
  truncateForEmbedding,
} from '../lib/resume-match';
import type { OffscreenResponse, Request, Response, Settings } from '../lib/messages';
import { mismatchReportUrl } from '../lib/deeplinks';
import {
  deleteResume,
  getCachedVerdict,
  getResume,
  getSettings,
  migrate,
  saveResume,
  saveResumeVector,
  setCachedVerdict,
  setSettings,
} from '../lib/storage';

const OFFSCREEN_PATH = 'offscreen.html';
const REPO = 'your-org/sponsorscope';

// Storage migrations run before anything reads storage. Both entry points matter:
// onInstalled covers upgrades, and the top-level call covers a worker respawn on
// a profile that upgraded while the browser was closed.
chrome.runtime.onInstalled.addListener(() => void migrate());
void migrate();

chrome.runtime.onMessage.addListener((message: Request, _sender, sendResponse) => {
  // Offscreen replies are addressed to the worker but handled by their own
  // sendMessage promise, not here.
  if ((message as { target?: string }).target === 'offscreen') return false;

  handle(message)
    .then(sendResponse)
    .catch((err: unknown) => {
      console.error('[SponsorScope] handler failed', message?.type, err);
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
    });

  return true; // Every handler is async.
});

async function handle(message: Request): Promise<Response> {
  switch (message.type) {
    case 'lookup_company':
      return handleLookup(message.name, message.country, message.domain);

    case 'match_resume':
      return handleResumeMatch(message.jobDescription);

    case 'get_resume_status': {
      const resume = await getResume();
      return {
        ok: true,
        type: 'get_resume_status',
        hasResume: resume !== null,
        updatedAt: resume?.updatedAt ?? null,
        chars: resume?.text.length ?? 0,
      };
    }

    case 'save_resume':
      await saveResume(message.text);
      return { ok: true, type: 'save_resume' };

    case 'delete_resume':
      await deleteResume();
      return { ok: true, type: 'delete_resume' };

    case 'get_settings':
      return { ok: true, type: 'get_settings', settings: await getSettings() };

    case 'set_settings': {
      const settings = await applySettings(message.patch);
      return { ok: true, type: 'set_settings', settings };
    }

    case 'open_url':
      // Opened rather than fetched. Third-party search pages load under the
      // user's own session, in a tab they can see — see lib/deeplinks.ts.
      await chrome.tabs.create({ url: message.url });
      return { ok: true, type: 'open_url' };

    case 'report_mismatch': {
      const url = mismatchReportUrl(
        REPO,
        message.context.company.name,
        message.matchedName,
        message.context.pageType,
      );
      await chrome.tabs.create({ url });
      return { ok: true, type: 'report_mismatch', url };
    }

    default:
      return { ok: false, error: 'Unknown request' };
  }
}

async function handleLookup(
  name: string,
  country: string | undefined,
  domain: string | undefined,
): Promise<Response> {
  const cached = await getCachedVerdict(name, country);
  if (cached) return { ok: true, type: 'lookup_company', verdict: cached, cached: true };

  const settings = await getSettings();
  const verdict = await lookupCompany(settings.apiBaseUrl, name, country, domain);
  await setCachedVerdict(name, country, verdict);

  return { ok: true, type: 'lookup_company', verdict, cached: false };
}

async function handleResumeMatch(jobDescription: string): Promise<Response> {
  const settings = await getSettings();
  if (!settings.resumeMatchEnabled) {
    return { ok: true, type: 'match_resume', match: null, reason: 'disabled' };
  }

  const resume = await getResume();
  if (!resume) {
    return { ok: true, type: 'match_resume', match: null, reason: 'no_resume' };
  }
  if (!jobDescription || jobDescription.trim().length < 200) {
    // Too little text to embed meaningfully; a score here would be noise.
    return { ok: true, type: 'match_resume', match: null, reason: 'no_description' };
  }

  try {
    // The resume is embedded once and cached. A model change invalidates it,
    // because vectors from different models are not comparable.
    const needsResumeVector = !resume.vector || resume.vectorModel !== MODEL_ID;
    const texts = needsResumeVector
      ? [truncateForEmbedding(resume.text), truncateForEmbedding(jobDescription)]
      : [truncateForEmbedding(jobDescription)];

    const vectors = await embed(texts);
    const resumeVector = needsResumeVector ? vectors[0] : resume.vector;
    const jobVector = needsResumeVector ? vectors[1] : vectors[0];

    if (!resumeVector || !jobVector) {
      return { ok: true, type: 'match_resume', match: null, reason: 'embedding_failed' };
    }
    if (needsResumeVector) {
      await saveResumeVector(resumeVector, MODEL_ID);
    }

    return {
      ok: true,
      type: 'match_resume',
      match: buildMatch(resumeVector, jobVector, resume.text, jobDescription),
    };
  } catch (err) {
    console.error('[SponsorScope] resume match failed', err);
    return { ok: true, type: 'match_resume', match: null, reason: 'embedding_failed' };
  }
}

// --- Offscreen document lifecycle -------------------------------------------

let creating: Promise<void> | null = null;

/**
 * Ensures exactly one offscreen document exists.
 *
 * `createDocument` throws if one already exists, and concurrent callers would
 * otherwise race — hence the shared promise. The existence check runs first
 * because the worker can be restarted while the document survives.
 */
async function ensureOffscreen(): Promise<void> {
  const existing = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (existing.length > 0) return;

  creating ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification:
        'Runs the bundled sentence-embedding model that scores the resume against the job description, entirely on-device.',
    })
    .finally(() => {
      creating = null;
    });

  await creating;
}

async function embed(texts: string[]): Promise<number[][]> {
  await ensureOffscreen();
  const response = (await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'embed',
    texts,
  })) as OffscreenResponse;

  if (!response?.ok || !('vectors' in response)) {
    throw new Error(response && 'error' in response ? response.error : 'Embedding failed');
  }
  return response.vectors;
}

/**
 * Applies a settings patch, clearing dependent caches when a change invalidates them.
 */
async function applySettings(patch: Partial<Settings>): Promise<Settings> {
  const previous = await getSettings();
  const next = await setSettings(patch);

  if (patch.apiBaseUrl && patch.apiBaseUrl !== previous.apiBaseUrl) {
    // Verdicts from one backend must not be attributed to another.
    const { clearCache } = await import('../lib/storage');
    await clearCache();
  }
  return next;
}
