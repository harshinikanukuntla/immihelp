/**
 * Types for the token codegen script, so `tests/tokens.test.ts` can import it
 * and assert that the generated stylesheet is in sync with its source.
 *
 * The script itself stays plain `.mjs` because `npm run build` runs it before
 * any TypeScript tooling is involved.
 */

/** Parses the `tokens` record out of tokens.ts into `[name, value]` pairs. */
export function extractTokens(source: string): Array<[string, string]>;

/** Renders those pairs into the generated tokens.css text. */
export function renderCss(entries: Array<[string, string]>): string;
