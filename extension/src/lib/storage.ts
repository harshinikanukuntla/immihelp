/**
 * Local storage, split into three namespaces with independent schema versions.
 *
 * ## Why the namespaces are separate
 *
 * The resume and the API cache have completely different value profiles. The
 * cache is disposable — throwing it away costs one network round trip. The
 * resume is user-entered data that may have taken real effort to paste in, and
 * silently discarding it on an extension update would be a genuinely bad
 * experience. So a cache schema bump wipes the cache and leaves the resume
 * untouched, which a single shared version counter could not express.
 *
 * ## Nothing here ever leaves the device
 *
 * The resume text and its embedding live in `chrome.storage.local` only. The
 * backend has no endpoint that accepts them. See docs/privacy.md.
 */
import { DEFAULT_SETTINGS, type Settings } from './messages';
import type { SponsorshipVerdict } from '../types/domain';

const CACHE_NAMESPACE = 'cache';
const RESUME_NAMESPACE = 'resume';
const SETTINGS_NAMESPACE = 'settings';

/** Bump when the shape of a cached verdict changes. Wipes the cache; keeps the resume. */
const CACHE_SCHEMA_VERSION = 1;
/** Bump when the stored resume shape changes. Migrations live in `migrateResume`. */
const RESUME_SCHEMA_VERSION = 1;
const SETTINGS_SCHEMA_VERSION = 1;

const VERSION_KEYS = {
  cache: `${CACHE_NAMESPACE}:__version`,
  resume: `${RESUME_NAMESPACE}:__version`,
  settings: `${SETTINGS_NAMESPACE}:__version`,
} as const;

/** Entries older than this are re-fetched. Government data moves quarterly at best. */
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7;
/** Keeps `chrome.storage.local` well under its quota without any bookkeeping. */
const MAX_CACHE_ENTRIES = 500;

interface CacheEntry {
  verdict: SponsorshipVerdict;
  storedAt: number;
}

export interface StoredResume {
  text: string;
  /** Cached embedding, so the resume is embedded once rather than per page load. */
  vector: number[] | null;
  /** Model that produced `vector`; a model change invalidates it. */
  vectorModel: string | null;
  updatedAt: number;
}

/**
 * Runs pending migrations. Called once on service-worker startup and on
 * `chrome.runtime.onInstalled`.
 *
 * Reading old-schema data is the crash risk here, so this runs before anything
 * else touches storage, and every step is defensive: a migration that throws
 * discards that namespace rather than leaving the extension unable to start.
 */
export async function migrate(): Promise<void> {
  await migrateNamespace(VERSION_KEYS.cache, CACHE_SCHEMA_VERSION, async () => {
    await clearNamespace(CACHE_NAMESPACE);
  });

  await migrateNamespace(VERSION_KEYS.resume, RESUME_SCHEMA_VERSION, async (from) => {
    await migrateResume(from);
  });

  await migrateNamespace(VERSION_KEYS.settings, SETTINGS_SCHEMA_VERSION, async () => {
    // Settings are merged against defaults on every read, so a version bump needs
    // no data rewrite unless a key changes meaning.
  });
}

async function migrateNamespace(
  versionKey: string,
  target: number,
  migrateFn: (from: number) => Promise<void>,
): Promise<void> {
  const stored = await chrome.storage.local.get(versionKey);
  const current = typeof stored[versionKey] === 'number' ? (stored[versionKey] as number) : 0;
  if (current === target) return;

  try {
    await migrateFn(current);
  } catch (err) {
    console.warn('[SponsorScope] migration failed; discarding namespace', versionKey, err);
    await clearNamespace(versionKey.split(':')[0] ?? '');
  }
  await chrome.storage.local.set({ [versionKey]: target });
}

/**
 * Resume migrations.
 *
 * Version 0 is "nothing stored, or stored by a build that predates versioning".
 * The embedding is dropped rather than reinterpreted whenever the schema moves,
 * because a stale vector produces a plausible-looking but wrong match score —
 * far worse than the one-off cost of recomputing it.
 */
async function migrateResume(from: number): Promise<void> {
  if (from === 0) {
    const existing = await chrome.storage.local.get(`${RESUME_NAMESPACE}:data`);
    const data = existing[`${RESUME_NAMESPACE}:data`] as Partial<StoredResume> | undefined;
    if (data?.text) {
      await saveResume(data.text);
    }
  }
}

async function clearNamespace(prefix: string): Promise<void> {
  if (!prefix) return;
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter(
    (key) => key.startsWith(`${prefix}:`) && !key.endsWith('__version'),
  );
  if (keys.length > 0) await chrome.storage.local.remove(keys);
}

// --- Verdict cache ----------------------------------------------------------

function cacheKey(name: string, country: string | undefined): string {
  return `${CACHE_NAMESPACE}:${name.toLowerCase().trim()}:${country ?? '*'}`;
}

export async function getCachedVerdict(
  name: string,
  country: string | undefined,
): Promise<SponsorshipVerdict | null> {
  const key = cacheKey(name, country);
  const stored = await chrome.storage.local.get(key);
  const entry = stored[key] as CacheEntry | undefined;

  if (!entry || typeof entry.storedAt !== 'number' || !entry.verdict) return null;
  if (Date.now() - entry.storedAt > CACHE_TTL_MS) {
    await chrome.storage.local.remove(key);
    return null;
  }
  return entry.verdict;
}

export async function setCachedVerdict(
  name: string,
  country: string | undefined,
  verdict: SponsorshipVerdict,
): Promise<void> {
  // Errors are never cached: a transient network failure must not stick around
  // for a week pretending to be an answer.
  if (verdict.kind === 'error') return;

  await evictIfFull();
  const entry: CacheEntry = { verdict, storedAt: Date.now() };
  await chrome.storage.local.set({ [cacheKey(name, country)]: entry });
}

/** Drops the oldest quarter of entries once the cache is full. */
async function evictIfFull(): Promise<void> {
  const all = await chrome.storage.local.get(null);
  const entries = Object.entries(all).filter(
    ([key]) => key.startsWith(`${CACHE_NAMESPACE}:`) && !key.endsWith('__version'),
  );
  if (entries.length < MAX_CACHE_ENTRIES) return;

  const sorted = entries
    .map(([key, value]) => ({ key, storedAt: (value as CacheEntry)?.storedAt ?? 0 }))
    .sort((a, b) => a.storedAt - b.storedAt);

  await chrome.storage.local.remove(sorted.slice(0, Math.ceil(MAX_CACHE_ENTRIES / 4)).map((e) => e.key));
}

export async function clearCache(): Promise<void> {
  await clearNamespace(CACHE_NAMESPACE);
}

// --- Resume -----------------------------------------------------------------

const RESUME_KEY = `${RESUME_NAMESPACE}:data`;

export async function getResume(): Promise<StoredResume | null> {
  const stored = await chrome.storage.local.get(RESUME_KEY);
  const resume = stored[RESUME_KEY] as StoredResume | undefined;
  return resume?.text ? resume : null;
}

export async function saveResume(text: string): Promise<void> {
  const resume: StoredResume = {
    text,
    // Any edit invalidates the cached embedding.
    vector: null,
    vectorModel: null,
    updatedAt: Date.now(),
  };
  await chrome.storage.local.set({ [RESUME_KEY]: resume });
}

export async function saveResumeVector(vector: number[], model: string): Promise<void> {
  const resume = await getResume();
  if (!resume) return;
  await chrome.storage.local.set({
    [RESUME_KEY]: { ...resume, vector, vectorModel: model } satisfies StoredResume,
  });
}

// --- Per-job analysis cache -------------------------------------------------

/**
 * Caches a resume analysis per job posting.
 *
 * This exists to make the score *stable*. Without it the analysis recomputed on
 * every render, and because the extracted job-description text varies slightly
 * while a single-page app hydrates, the number visibly changed between
 * refreshes. A fit score that moves when you reload is worse than no score: it
 * teaches the user that nothing in the panel can be trusted, including the
 * sponsorship data, which is the part that actually matters.
 *
 * Keyed by job *and* by the resume's `updatedAt`, so editing the resume
 * naturally invalidates every cached analysis without needing a sweep.
 */
function matchKey(jobKey: string, resumeUpdatedAt: number): string {
  return `${RESUME_NAMESPACE}:match:${jobKey}:${resumeUpdatedAt}`;
}

export async function getCachedAnalysis<T>(
  jobKey: string,
  resumeUpdatedAt: number,
): Promise<T | null> {
  const key = matchKey(jobKey, resumeUpdatedAt);
  const stored = await chrome.storage.local.get(key);
  return (stored[key] as T | undefined) ?? null;
}

export async function setCachedAnalysis<T>(
  jobKey: string,
  resumeUpdatedAt: number,
  analysis: T,
): Promise<void> {
  await chrome.storage.local.set({ [matchKey(jobKey, resumeUpdatedAt)]: analysis });
}

/**
 * Deletes the resume and everything derived from it.
 *
 * Wired to the "Delete my resume" control in options. Removes the text, the
 * embedding, and the job-match cache in one operation — a delete that left the
 * embedding behind would be a lie, since the vector is derived from the text.
 */
export async function deleteResume(): Promise<void> {
  await chrome.storage.local.remove(RESUME_KEY);
  await clearNamespace(`${RESUME_NAMESPACE}:match`);
}

// --- Settings ---------------------------------------------------------------

const SETTINGS_KEY = `${SETTINGS_NAMESPACE}:data`;

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const saved = (stored[SETTINGS_KEY] ?? {}) as Partial<Settings>;
  // Merging against defaults means a new setting added in a later version has a
  // sane value without needing a migration.
  return { ...DEFAULT_SETTINGS, ...saved };
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}
