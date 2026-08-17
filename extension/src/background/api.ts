/**
 * Client for the sponsorship lookup API.
 *
 * The only outbound request the extension makes. It sends a company name, an
 * optional country, and an optional domain — all of which are already public
 * information visible on the page. It sends no identifier, no resume, no page
 * URL, and no cookie, and the server sets none.
 */
import type { SponsorshipVerdict } from '../types/domain';

const TIMEOUT_MS = 8000;

/** Version prefix so a breaking API change cannot be served to an old extension. */
const API_VERSION = 'v1';

export async function lookupCompany(
  baseUrl: string,
  name: string,
  country?: string,
  domain?: string,
): Promise<SponsorshipVerdict> {
  const url = new URL(`${API_VERSION}/company`, ensureTrailingSlash(baseUrl));
  url.searchParams.set('name', name);
  if (country) url.searchParams.set('country', country);
  if (domain) url.searchParams.set('domain', domain);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url.toString(), {
      method: 'GET',
      // No cookies in either direction; the API is anonymous by construction.
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });

    if (response.status === 429) {
      return {
        kind: 'error',
        message: 'The lookup service is rate limited right now. Try again in a minute.',
      };
    }
    if (!response.ok) {
      return { kind: 'error', message: `Lookup failed (${response.status}).` };
    }

    const payload = (await response.json()) as unknown;
    return parseVerdict(payload);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { kind: 'error', message: 'The lookup service did not respond in time.' };
    }
    return { kind: 'error', message: 'Could not reach the lookup service.' };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Validates the response shape before it reaches the renderer.
 *
 * A malformed or unexpected payload becomes an explicit error rather than a
 * half-rendered panel. Given that the panel's job is to state facts about
 * someone's immigration prospects, rendering whatever arrived is not acceptable.
 */
function parseVerdict(payload: unknown): SponsorshipVerdict {
  if (typeof payload !== 'object' || payload === null || !('kind' in payload)) {
    return { kind: 'error', message: 'The lookup service returned an unexpected response.' };
  }

  const verdict = payload as SponsorshipVerdict;
  switch (verdict.kind) {
    case 'verified':
      if (!verdict.match || !Array.isArray(verdict.records)) break;
      // Provenance is non-negotiable: a record with no source is not renderable.
      if (verdict.records.some((record) => !Array.isArray(record.sources) || record.sources.length === 0)) {
        return { kind: 'error', message: 'The lookup service returned data without a source.' };
      }
      return verdict;
    case 'no_record':
      if (typeof verdict.queriedName === 'string') return verdict;
      break;
    case 'does_not_sponsor':
      if (verdict.match && Array.isArray(verdict.sources)) return verdict;
      break;
    case 'error':
      return verdict;
  }

  return { kind: 'error', message: 'The lookup service returned an unexpected response.' };
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}
