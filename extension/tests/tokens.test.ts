/**
 * Design tokens.
 *
 * Two things are checked: that the generated stylesheet is in sync with its
 * source (a stale tokens.css means the panel and the options page silently
 * disagree), and that the palette actually meets the contrast requirement the
 * design system claims.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractTokens, renderCss } from '../scripts/build-tokens.mjs';
import { color, status, tokens } from '../src/design/tokens';

const root = resolve(__dirname, '..');

describe('generated tokens.css', () => {
  it('is up to date with tokens.ts', () => {
    const source = readFileSync(resolve(root, 'src/design/tokens.ts'), 'utf8');
    const generated = renderCss(extractTokens(source));
    const onDisk = readFileSync(resolve(root, 'src/design/tokens.css'), 'utf8');

    expect(onDisk).toBe(generated);
  });

  it('exposes the variables in every context the UI renders in', () => {
    const css = readFileSync(resolve(root, 'src/design/tokens.css'), 'utf8');
    // :root for the options and popup pages, :host for the panel's shadow root.
    expect(css).toContain(':root');
    expect(css).toContain(':host');
    expect(css).toContain('.ss-root');
  });

  it('emits every token in the record', () => {
    const css = readFileSync(resolve(root, 'src/design/tokens.css'), 'utf8');
    for (const name of Object.keys(tokens)) {
      expect(css).toContain(`--ss-${name}:`);
    }
  });
});

// --- WCAG contrast ----------------------------------------------------------

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

describe('WCAG AA contrast', () => {
  it('body text on the panel surface', () => {
    expect(contrast(color.text, color.surface)).toBeGreaterThanOrEqual(4.5);
  });

  it('muted metadata text — the "as of" and source lines', () => {
    // These carry provenance, so they must be readable, not decorative.
    expect(contrast(color.textMuted, color.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(color.textMuted, color.surfaceMuted)).toBeGreaterThanOrEqual(4.5);
  });

  it('the accent, used for links and buttons', () => {
    expect(contrast(color.accent, color.surface)).toBeGreaterThanOrEqual(4.5);
  });

  it('every status badge against its own tint', () => {
    for (const [name, tone] of Object.entries(status)) {
      expect(contrast(tone.fg, tone.bg), `${name} badge`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('the accent is not LinkedIn blue, so the panel is not mistaken for native UI', () => {
    expect(color.accent.toLowerCase()).not.toBe('#0a66c2');
  });
});
