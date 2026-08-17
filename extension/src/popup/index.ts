/** Popup: a status summary and a way into settings. No lookups happen here. */
import { send } from '../lib/messages';

void init();

async function init(): Promise<void> {
  document.getElementById('open-options')?.addEventListener('click', () => {
    void chrome.runtime.openOptionsPage();
  });

  const [settings, resume] = await Promise.all([
    send({ type: 'get_settings' }),
    send({ type: 'get_resume_status' }),
  ]);

  setText(
    'status',
    settings.ok && settings.settings.enabled
      ? 'Active on LinkedIn job and company pages.'
      : 'The panel is turned off in settings.',
  );

  setText(
    'resume-fact',
    resume.ok && resume.hasResume
      ? `Resume: saved on this device (${resume.chars.toLocaleString()} characters)`
      : 'Resume: not saved — resume matching is inactive',
  );

  setText(
    'api-fact',
    settings.ok ? `Lookup service: ${hostOf(settings.settings.apiBaseUrl)}` : 'Lookup service: unknown',
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function setText(id: string, text: string): void {
  const element = document.getElementById(id);
  if (element) element.textContent = text;
}
