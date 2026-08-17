/**
 * SponsorScope design tokens — the single source of truth.
 *
 * `scripts/build-tokens.mjs` generates `tokens.css` from this file, so CSS and TS
 * can never drift. Components import from here (or use the generated custom
 * properties); they must never hardcode a hex value.
 *
 * Light theme only, by product decision. There is no dark palette and no toggle.
 * The injected panel is meant to read as a native inline card sitting beside the
 * host page's own content — not a floating overlay, and not an ad.
 */

/** Every custom property is emitted with this prefix to avoid colliding with host-page CSS. */
export const TOKEN_PREFIX = '--ss';

export const color = {
  /** Panel surface. */
  surface: '#FFFFFF',
  /** Page-adjacent surface for nested/inset regions. */
  surfaceMuted: '#F8F9FA',
  /** Hairline borders and dividers. */
  border: '#E4E6E8',
  borderStrong: '#D0D3D6',

  /** Body copy. 16.1:1 on surface. */
  text: '#1A1A1A',
  /** Headings and emphasis. 15.0:1 on surface. */
  textStrong: '#202124',
  /** Metadata, "as of" lines, source attributions. 5.9:1 on surface — passes AA. */
  textMuted: '#5F6368',

  /**
   * Accent: muted teal. Deliberately not LinkedIn's blue (#0A66C2) so the panel
   * is never mistaken for native LinkedIn UI. 5.2:1 on white — passes AA for body text.
   */
  accent: '#0F766E',
  accentHover: '#0B5C55',
  /** Very light teal wash for accent-tinted surfaces. */
  accentSubtle: '#F0FDFA',
  /** Focus ring. Must remain visible against both surface and accentSubtle. */
  focusRing: '#0F766E',
} as const;

/**
 * Status palette.
 *
 * These are muted on purpose. This is emotionally high-stakes information for
 * someone whose ability to stay in a country may depend on it — nothing here
 * should read like a warning siren.
 *
 * Never signal status by color alone. Every status is rendered with an icon and a
 * text label alongside the color (see `statusPresentation` in `src/content/panel.ts`).
 */
export const status = {
  /** Government-sourced, confident match. */
  verified: { fg: '#15803D', bg: '#DCFCE7', border: '#BBF7D0' },
  /** Mentioned in the posting text, or a low-confidence entity match. */
  unverified: { fg: '#B45309', bg: '#FEF3C7', border: '#FDE68A' },
  /**
   * No record located. NOT a negative signal — see docs/data-sources.md.
   *
   * The foreground is `#5F6368` rather than the `#6B7280` the original palette
   * specified: `#6B7280` on this tint measures 4.39:1, which fails the AA 4.5:1
   * floor the rest of this file is held to. `tests/tokens.test.ts` enforces the
   * floor, so the two requirements cannot both be satisfied as originally
   * written. `#5F6368` is already the `textMuted` value, so this reuses an
   * existing grey instead of introducing a near-duplicate, and measures 5.50:1.
   *
   * This is the badge a user is most likely to misread as bad news, which makes
   * it the worst one to leave hard to read.
   */
  none: { fg: '#5F6368', bg: '#F3F4F6', border: '#E5E7EB' },
  /** Confirmed does-not-sponsor. Used sparingly; see panel.ts for the guard. */
  negative: { fg: '#B91C1C', bg: '#FEE2E2', border: '#FECACA' },
} as const;

export type StatusTone = keyof typeof status;

/** 4-point spacing scale. */
export const space = {
  xs: '4px',
  sm: '8px',
  md: '12px',
  lg: '16px',
  xl: '24px',
} as const;

export const radius = {
  /** Cards, buttons, badges all share one radius. */
  base: '8px',
  /** Pills (badges with fully rounded ends). */
  pill: '999px',
} as const;

export const shadow = {
  /** Subtle only. The panel is an inline card, not a floating overlay. */
  card: '0 1px 3px rgba(0, 0, 0, 0.08)',
  /** For the one genuinely layered surface (the options-page dialog). */
  raised: '0 2px 8px rgba(0, 0, 0, 0.10)',
} as const;

export const font = {
  /**
   * System stack only — no webfonts. Keeps the panel feeling native to the host
   * page and avoids extra CSP and network overhead inside a content script.
   */
  family:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  familyMono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  sizeXs: '11px',
  sizeSm: '12px',
  sizeBase: '13px',
  sizeMd: '14px',
  sizeLg: '16px',
  weightRegular: '400',
  weightMedium: '500',
  weightSemibold: '600',
  lineTight: '1.3',
  lineBase: '1.5',
} as const;

export const motion = {
  /** Respected only when the user has not requested reduced motion. */
  fast: '120ms',
  base: '200ms',
  easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
} as const;

export const zIndex = {
  /** High enough to sit above LinkedIn's sticky chrome, low enough to stay under modals. */
  panel: '900',
} as const;

/**
 * Flat map consumed by the token build script. Keys become
 * `--ss-<key>` custom properties, in source order.
 */
export const tokens: Record<string, string> = {
  'color-surface': color.surface,
  'color-surface-muted': color.surfaceMuted,
  'color-border': color.border,
  'color-border-strong': color.borderStrong,
  'color-text': color.text,
  'color-text-strong': color.textStrong,
  'color-text-muted': color.textMuted,
  'color-accent': color.accent,
  'color-accent-hover': color.accentHover,
  'color-accent-subtle': color.accentSubtle,
  'color-focus-ring': color.focusRing,

  'status-verified-fg': status.verified.fg,
  'status-verified-bg': status.verified.bg,
  'status-verified-border': status.verified.border,
  'status-unverified-fg': status.unverified.fg,
  'status-unverified-bg': status.unverified.bg,
  'status-unverified-border': status.unverified.border,
  'status-none-fg': status.none.fg,
  'status-none-bg': status.none.bg,
  'status-none-border': status.none.border,
  'status-negative-fg': status.negative.fg,
  'status-negative-bg': status.negative.bg,
  'status-negative-border': status.negative.border,

  'space-xs': space.xs,
  'space-sm': space.sm,
  'space-md': space.md,
  'space-lg': space.lg,
  'space-xl': space.xl,

  'radius-base': radius.base,
  'radius-pill': radius.pill,

  'shadow-card': shadow.card,
  'shadow-raised': shadow.raised,

  'font-family': font.family,
  'font-family-mono': font.familyMono,
  'font-size-xs': font.sizeXs,
  'font-size-sm': font.sizeSm,
  'font-size-base': font.sizeBase,
  'font-size-md': font.sizeMd,
  'font-size-lg': font.sizeLg,
  'font-weight-regular': font.weightRegular,
  'font-weight-medium': font.weightMedium,
  'font-weight-semibold': font.weightSemibold,
  'line-tight': font.lineTight,
  'line-base': font.lineBase,

  'motion-fast': motion.fast,
  'motion-base': motion.base,
  'motion-easing': motion.easing,

  'z-panel': zIndex.panel,
};

/** `var(--ss-<name>)` for a token key, for use in inline styles and template literals. */
export function cssVar(name: keyof typeof tokens & string): string {
  return `var(${TOKEN_PREFIX}-${name})`;
}
