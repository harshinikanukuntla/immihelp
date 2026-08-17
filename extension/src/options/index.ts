/**
 * Options page behaviour.
 *
 * All state changes go through the service worker rather than touching
 * `chrome.storage` directly, so storage-schema knowledge stays in one module and
 * the deletion path is the same one the panel's controls use.
 */
import { DEFAULT_SETTINGS, send, type Settings } from '../lib/messages';

const TOGGLES = [
  'enabled',
  'postingScanEnabled',
  'resumeMatchEnabled',
  'deepLinksEnabled',
] as const satisfies ReadonlyArray<keyof Settings>;

void init();

async function init(): Promise<void> {
  await refreshResumeStatus();
  await loadSettings();
  wireResumeControls();
  wireApiControls();
}

// --- Resume -----------------------------------------------------------------

function wireResumeControls(): void {
  const textarea = byId<HTMLTextAreaElement>('resume-text');

  byId<HTMLButtonElement>('save-resume').addEventListener('click', async () => {
    const text = textarea.value.trim();
    if (text.length < 50) {
      setStatus('resume-status', 'That looks too short to match against. Paste the full text.', 'warn');
      return;
    }
    const response = await send({ type: 'save_resume', text });
    setStatus(
      'resume-status',
      response.ok ? 'Resume saved on this device.' : 'Could not save the resume.',
      response.ok ? 'ok' : 'warn',
    );
    await refreshResumeStatus();
  });

  byId<HTMLInputElement>('resume-file').addEventListener('change', async (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    // Read locally and dropped into the textarea rather than saved directly, so
    // the user sees exactly what was extracted before committing it.
    textarea.value = await file.text();
    setStatus('resume-status', `Loaded ${file.name}. Review it, then save.`);
  });

  byId<HTMLButtonElement>('delete-resume').addEventListener('click', async () => {
    // Irreversible and entirely local, so it is confirmed rather than undoable.
    if (!confirm('Delete your saved resume and its computed embedding from this browser?')) return;

    const response = await send({ type: 'delete_resume' });
    textarea.value = '';
    setStatus(
      'resume-status',
      response.ok ? 'Resume deleted from this browser.' : 'Could not delete the resume.',
      response.ok ? 'ok' : 'warn',
    );
    await refreshResumeStatus();
  });
}

async function refreshResumeStatus(): Promise<void> {
  const response = await send({ type: 'get_resume_status' });
  if (!response.ok) {
    setStatus('resume-status', 'Could not read local storage.', 'warn');
    return;
  }

  if (!response.hasResume) {
    setStatus('resume-status', 'No resume saved. Resume matching is inactive.');
    return;
  }

  const when = response.updatedAt ? new Date(response.updatedAt).toLocaleString() : 'unknown';
  setStatus(
    'resume-status',
    `Resume saved on this device (${response.chars.toLocaleString()} characters, last updated ${when}).`,
    'ok',
  );
}

// --- Settings ---------------------------------------------------------------

async function loadSettings(): Promise<void> {
  const response = await send({ type: 'get_settings' });
  if (!response.ok) return;
  applySettings(response.settings);

  for (const key of TOGGLES) {
    const input = byId<HTMLInputElement>(key);
    input.addEventListener('change', async () => {
      const updated = await send({ type: 'set_settings', patch: { [key]: input.checked } });
      if (updated.ok) applySettings(updated.settings);
    });
  }
}

function applySettings(settings: Settings): void {
  for (const key of TOGGLES) {
    byId<HTMLInputElement>(key).checked = Boolean(settings[key]);
  }
  byId<HTMLInputElement>('apiBaseUrl').value = settings.apiBaseUrl;
}

function wireApiControls(): void {
  const input = byId<HTMLInputElement>('apiBaseUrl');

  byId<HTMLButtonElement>('save-api').addEventListener('click', async () => {
    const value = input.value.trim();
    if (!isValidHttpsUrl(value)) {
      setStatus('api-status', 'Enter a valid https:// URL (or http://localhost for development).', 'warn');
      return;
    }

    // Changing the endpoint means talking to a host the manifest does not cover,
    // so the permission is requested at the moment of the change rather than
    // taken broadly up front.
    const granted = await requestHostPermission(value);
    if (!granted) {
      setStatus('api-status', 'Permission for that host was declined, so the change was not saved.', 'warn');
      return;
    }

    const response = await send({ type: 'set_settings', patch: { apiBaseUrl: value } });
    setStatus(
      'api-status',
      response.ok ? 'Saved. Cached results from the previous endpoint were cleared.' : 'Could not save.',
      response.ok ? 'ok' : 'warn',
    );
  });

  byId<HTMLButtonElement>('reset-api').addEventListener('click', async () => {
    const response = await send({
      type: 'set_settings',
      patch: { apiBaseUrl: DEFAULT_SETTINGS.apiBaseUrl },
    });
    if (response.ok) applySettings(response.settings);
    setStatus('api-status', 'Reset to the default endpoint.', 'ok');
  });
}

function isValidHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

async function requestHostPermission(baseUrl: string): Promise<boolean> {
  try {
    const origin = new URL(baseUrl).origin;
    return await chrome.permissions.request({ origins: [`${origin}/*`] });
  } catch {
    return false;
  }
}

// --- Helpers ----------------------------------------------------------------

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}

function setStatus(id: string, message: string, tone?: 'ok' | 'warn'): void {
  const element = byId(id);
  element.textContent = message;
  element.className = `ss-status${tone ? ` ss-status--${tone}` : ''}`;
}
