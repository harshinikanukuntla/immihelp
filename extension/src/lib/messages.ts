/**
 * The message protocol between content scripts, the service worker, and the
 * offscreen document.
 *
 * Content scripts stay thin on purpose: they read the DOM and render, and every
 * network call and every piece of persistent state lives behind these messages
 * in the service worker. That keeps host-page context free of API keys, cache
 * logic, and the embedding model, and it means a job board's CSP can never block
 * our network access.
 */
import type { PageContext, ResumeMatch, SponsorshipVerdict } from '../types/domain';

export type Request =
  | { type: 'lookup_company'; name: string; country?: string; domain?: string }
  | { type: 'match_resume'; jobDescription: string; jobKey: string }
  | { type: 'get_resume_status' }
  | { type: 'save_resume'; text: string }
  | { type: 'delete_resume' }
  | { type: 'get_settings' }
  | { type: 'set_settings'; patch: Partial<Settings> }
  | { type: 'open_url'; url: string }
  | { type: 'report_mismatch'; context: PageContext; matchedName: string };

export type Response =
  | { ok: true; type: 'lookup_company'; verdict: SponsorshipVerdict; cached: boolean }
  | { ok: true; type: 'match_resume'; match: ResumeMatch | null; reason?: string }
  | { ok: true; type: 'get_resume_status'; hasResume: boolean; updatedAt: number | null; chars: number }
  | { ok: true; type: 'save_resume' }
  | { ok: true; type: 'delete_resume' }
  | { ok: true; type: 'get_settings'; settings: Settings }
  | { ok: true; type: 'set_settings'; settings: Settings }
  | { ok: true; type: 'open_url' }
  | { ok: true; type: 'report_mismatch'; url: string }
  | { ok: false; error: string };

export interface Settings {
  /** Base URL of the lookup API. Overridable so anyone can self-host. */
  apiBaseUrl: string;
  /** Master switch for the injected panel. */
  enabled: boolean;
  /** Feature 2 — off until the user provides a resume. */
  resumeMatchEnabled: boolean;
  /** Feature 3/4 — deep links out to third-party search pages. */
  deepLinksEnabled: boolean;
  /** Feature 1b — scan the posting text where no register covers the country. */
  postingScanEnabled: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  apiBaseUrl: 'https://api.sponsorscope.dev',
  enabled: true,
  resumeMatchEnabled: true,
  deepLinksEnabled: true,
  postingScanEnabled: true,
};

/** Typed wrapper around `chrome.runtime.sendMessage`. */
export async function send<T extends Request['type']>(
  request: Extract<Request, { type: T }>,
): Promise<Extract<Response, { ok: true; type: T }> | Extract<Response, { ok: false }>> {
  try {
    return await chrome.runtime.sendMessage(request);
  } catch (err) {
    // The service worker can be torn down mid-flight; surface it as a normal
    // error rather than an unhandled rejection inside the host page.
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Messages exchanged with the offscreen document that hosts the embedding model. */
export type OffscreenRequest =
  | { target: 'offscreen'; type: 'embed'; texts: string[] }
  | { target: 'offscreen'; type: 'ping' };

export type OffscreenResponse =
  | { ok: true; vectors: number[][] }
  | { ok: true; pong: true }
  | { ok: false; error: string };
