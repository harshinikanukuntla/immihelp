#!/usr/bin/env node
/**
 * Generates `src/design/tokens.css` from `src/design/tokens.ts`.
 *
 * tokens.ts is the single source of truth; this script exists so stylesheets can
 * use the same values without anyone hand-syncing two files. `npm run build`
 * runs it before bundling. `tests/tokens.test.ts` fails if the generated file is
 * stale, so a forgotten regeneration surfaces in CI rather than in the UI.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const tokensTs = resolve(here, '../src/design/tokens.ts');
const tokensCss = resolve(here, '../src/design/tokens.css');

/**
 * Extracts the `tokens` record without executing TypeScript. The record is a flat
 * map of string literals by construction, so a scoped regex pass is sufficient and
 * keeps this script dependency-free.
 */
export function extractTokens(source) {
  const start = source.indexOf('export const tokens: Record<string, string> = {');
  if (start === -1) throw new Error('Could not locate the `tokens` record in tokens.ts');
  const open = source.indexOf('{', start);

  let depth = 0;
  let end = -1;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) throw new Error('Unbalanced braces in the `tokens` record');

  const body = source.slice(open + 1, end);
  const entries = [];
  const pattern = /'([^']+)':\s*(?:[A-Za-z][\w.]*|'((?:[^'\\]|\\.)*)')\s*,/g;

  // Values are written either as a literal ('#FFFFFF') or as a reference to one of
  // the typed groups above (color.surface). References are resolved by reading the
  // literal off the referenced group's own declaration.
  for (const match of body.matchAll(pattern)) {
    const key = match[1];
    const literal = match[2];
    if (literal !== undefined) {
      entries.push([key, literal.replace(/\\'/g, "'")]);
      continue;
    }
    const ref = match[0].split(':').slice(1).join(':').trim().replace(/,$/, '');
    entries.push([key, resolveReference(source, ref)]);
  }
  if (entries.length === 0) throw new Error('Parsed zero tokens — the record shape changed');
  return entries;
}

/** Resolves `color.surface` / `status.verified.fg` to its string literal. */
function resolveReference(source, ref) {
  const path = ref.split('.');
  const groupName = path[0];
  const groupStart = source.indexOf(`export const ${groupName} = {`);
  if (groupStart === -1) throw new Error(`Unknown token group: ${groupName}`);

  let depth = 0;
  let groupEnd = -1;
  const open = source.indexOf('{', groupStart);
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) {
        groupEnd = i;
        break;
      }
    }
  }
  let scope = source.slice(open, groupEnd + 1);

  // Walk the remaining path segments, narrowing the scope at each nested object.
  for (let i = 1; i < path.length; i++) {
    const key = path[i];
    const isLast = i === path.length - 1;
    if (isLast) {
      const literal = new RegExp(`\\b${key}:\\s*'((?:[^'\\\\]|\\\\.)*)'`).exec(scope);
      if (literal) return literal[1].replace(/\\'/g, "'");
    }
    const nested = new RegExp(`\\b${key}:\\s*\\{`).exec(scope);
    if (!nested) throw new Error(`Could not resolve token reference: ${ref}`);
    const nestedOpen = scope.indexOf('{', nested.index + nested[0].length - 1);
    let d = 0;
    let nestedEnd = -1;
    for (let j = nestedOpen; j < scope.length; j++) {
      if (scope[j] === '{') d++;
      else if (scope[j] === '}') {
        d--;
        if (d === 0) {
          nestedEnd = j;
          break;
        }
      }
    }
    scope = scope.slice(nestedOpen, nestedEnd + 1);
  }
  throw new Error(`Could not resolve token reference: ${ref}`);
}

export function renderCss(entries) {
  const lines = entries.map(([key, value]) => `  --ss-${key}: ${value};`);
  return [
    '/**',
    ' * GENERATED FILE — DO NOT EDIT.',
    ' * Source: src/design/tokens.ts. Regenerate with `npm run build:tokens`.',
    ' */',
    // Three selectors so one token file serves every context: `:root` for the
    // options and popup pages, `:host` for the panel's shadow root, and
    // `.ss-root` for the panel container itself.
    ':root,',
    ':host,',
    '.ss-root {',
    ...lines,
    '}',
    '',
  ].join('\n');
}

function main() {
  const source = readFileSync(tokensTs, 'utf8');
  const css = renderCss(extractTokens(source));
  const current = existsSync(tokensCss) ? readFileSync(tokensCss, 'utf8') : '';
  if (current === css) {
    console.log('tokens.css is up to date');
    return;
  }
  writeFileSync(tokensCss, css);
  console.log(`Wrote ${tokensCss}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
