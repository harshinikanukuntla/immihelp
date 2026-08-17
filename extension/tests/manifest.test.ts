/**
 * Manifest and adapter agreement.
 *
 * This file exists because of a real bug. The adapter claimed `/jobs/search/`,
 * `/jobs/view/`, and `/jobs/collections/`, and the manifest listed the same
 * three. LinkedIn also serves the identical two-pane posting UI from
 * `/jobs/search-results/`, so on that path the content script never injected and
 * the panel simply never appeared — with no error anywhere, because nothing had
 * run.
 *
 * Unit-testing the adapter could not catch that: the adapter was self-consistent.
 * The failure was in the gap between two files, so the test has to span it.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { linkedInAdapter } from '../src/adapters/linkedin';

/** `detectPageType` decides on the URL alone, so an empty document is enough. */
const emptyDoc = new JSDOM('').window.document;

const manifest = JSON.parse(
  readFileSync(resolve(__dirname, '../public/manifest.json'), 'utf8'),
) as {
  permissions: string[];
  host_permissions: string[];
  content_scripts: Array<{ matches: string[]; js: string[] }>;
};

/** Compiles a Chrome match pattern into a regex. */
function matchPatternToRegex(pattern: string): RegExp {
  const parsed = /^(\*|https?):\/\/([^/]+)(\/.*)$/.exec(pattern);
  if (!parsed) throw new Error(`Unparseable match pattern: ${pattern}`);
  const [, scheme, host, path] = parsed;

  const schemePart = scheme === '*' ? 'https?' : scheme;
  const hostPart = host!.startsWith('*.')
    ? `(?:[^/]+\\.)?${escape(host!.slice(2))}`
    : escape(host!);
  const pathPart = path!.split('*').map(escape).join('.*');

  return new RegExp(`^${schemePart}://${hostPart}${pathPart}$`);
}

function escape(value: string): string {
  return value.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

const contentScript = manifest.content_scripts[0]!;
const patterns = contentScript.matches.map(matchPatternToRegex);

const injects = (url: string) => patterns.some((pattern) => pattern.test(url));

/** URLs LinkedIn actually serves the job or company UI from. */
const CLAIMED_URLS = [
  'https://www.linkedin.com/jobs/view/4435306847/',
  'https://www.linkedin.com/jobs/search/?currentJobId=4435306847',
  // The path that exposed the original bug.
  'https://www.linkedin.com/jobs/search-results/?currentJobId=4435306847&eBP=xyz',
  'https://www.linkedin.com/jobs/collections/recommended/?currentJobId=1',
  'https://www.linkedin.com/company/instabase/',
  'https://www.linkedin.com/company/instabase/people/',
];

const UNCLAIMED_URLS = [
  'https://www.linkedin.com/feed/',
  'https://www.linkedin.com/in/someone/',
  'https://www.linkedin.com/messaging/',
  'https://www.linkedin.com/notifications/',
];

describe('the manifest injects wherever the adapter claims a page', () => {
  for (const url of CLAIMED_URLS) {
    it(`injects on ${new URL(url).pathname}`, () => {
      // Both halves must agree. An adapter that recognises a page the manifest
      // never injects on is silently dead code.
      expect(injects(url), 'manifest does not match this URL').toBe(true);
      expect(
        linkedInAdapter.detectPageType(new URL(url), emptyDoc),
        'adapter does not claim this URL',
      ).not.toBeNull();
    });
  }
});

describe('the content script stays off the rest of LinkedIn', () => {
  for (const url of UNCLAIMED_URLS) {
    it(`does not inject on ${new URL(url).pathname}`, () => {
      expect(injects(url)).toBe(false);
    });
  }

  it('is scoped to path prefixes, not the whole domain', () => {
    // The feed, messages, and profile pages are none of our business, and
    // Chrome Web Store review weighs permission breadth.
    expect(contentScript.matches).not.toContain('https://www.linkedin.com/*');
    expect(contentScript.matches.every((m) => m.startsWith('https://'))).toBe(true);
  });
});

describe('permissions stay minimal', () => {
  it('does not request the broad tabs permission', () => {
    // `activeTab` covers opening links from the panel; `tabs` would grant read
    // access to the URL of every open tab.
    expect(manifest.permissions).not.toContain('tabs');
    expect(manifest.permissions).toContain('activeTab');
  });

  it('requests no host permission beyond the lookup API up front', () => {
    // Anything wider is requested at the moment of use via chrome.permissions.
    expect(manifest.host_permissions).toHaveLength(1);
    expect(manifest.host_permissions[0]).not.toContain('linkedin.com');
  });
});

describe('the manifest points at files the build produces', () => {
  it('names the bundled content script', () => {
    expect(contentScript.js).toEqual(['content.js']);
  });
});
