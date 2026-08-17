/**
 * Best-effort country inference from a job posting's location string.
 *
 * Used only to decide which government registers to check. A wrong guess widens
 * the search (we fall back to checking every supported register) rather than
 * producing a wrong answer, so this is allowed to be approximate.
 */

const COUNTRY_NAMES: Array<[RegExp, string]> = [
  [/\b(united states|usa|u\.s\.a?\.?|america)\b/i, 'US'],
  [/\b(united kingdom|england|scotland|wales|northern ireland|u\.k\.?|uk)\b/i, 'GB'],
  [/\bcanada\b/i, 'CA'],
  [/\b(india|bharat)\b/i, 'IN'],
  [/\bgermany|deutschland\b/i, 'DE'],
  [/\bireland\b/i, 'IE'],
  [/\baustralia\b/i, 'AU'],
  [/\bnetherlands|holland\b/i, 'NL'],
  [/\bsingapore\b/i, 'SG'],
  [/\bfrance\b/i, 'FR'],
  [/\bspain\b/i, 'ES'],
  [/\bswitzerland\b/i, 'CH'],
  [/\bsweden\b/i, 'SE'],
  [/\bpoland\b/i, 'PL'],
  [/\bnew zealand\b/i, 'NZ'],
  [/\bjapan\b/i, 'JP'],
  [/\bbrazil|brasil\b/i, 'BR'],
  [/\bmexico\b/i, 'MX'],
  [/\bunited arab emirates|uae|dubai|abu dhabi\b/i, 'AE'],
];

/** Postal abbreviations, checked only when they appear as a standalone token. */
const US_STATES = new Set(
  ('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM ' +
    'NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC')
    .split(' '),
);

const CA_PROVINCES = new Set('AB BC MB NB NL NS NT NU ON PE QC SK YT'.split(' '));

/**
 * Returns an ISO 3166-1 alpha-2 code, or undefined when the location is absent
 * or unrecognised. Undefined is a meaningful answer: the caller then checks every
 * supported register rather than guessing.
 */
export function inferCountry(location: string | undefined): string | undefined {
  if (!location) return undefined;

  for (const [pattern, code] of COUNTRY_NAMES) {
    if (pattern.test(location)) return code;
  }

  // "San Francisco, CA" and "Toronto, ON" are the two most common shapes that
  // name no country at all.
  const tokens = location.split(/[,\s]+/).filter(Boolean);
  for (const token of tokens) {
    const upper = token.toUpperCase();
    // Ambiguous between the two sets; skip rather than guess.
    if (US_STATES.has(upper) && CA_PROVINCES.has(upper)) continue;
    if (US_STATES.has(upper)) return 'US';
    if (CA_PROVINCES.has(upper)) return 'CA';
  }

  return undefined;
}

/** Registers we hold government data for. Everything else falls back to Feature 1b. */
export const COVERED_COUNTRIES = new Set(['US', 'GB', 'CA']);

export function hasGovernmentCoverage(country: string | undefined): boolean {
  return country !== undefined && COVERED_COUNTRIES.has(country);
}

const DISPLAY_NAMES: Record<string, string> = {
  US: 'United States',
  GB: 'United Kingdom',
  CA: 'Canada',
};

export function countryLabel(code: string): string {
  return DISPLAY_NAMES[code] ?? code;
}
