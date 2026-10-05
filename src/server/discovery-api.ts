// Slice 10: the Find screen's server side. A seller saves a search (their ICP), runs it against a
// discovery provider, reads the run in priority order and selects businesses for analysis. The
// provider's credentials never reach the browser: the screen only learns whether a provider is
// connected.
import type { SearchInput } from '../discovery/index.js';

export class FindRejected extends Error {
  readonly status = 422;
}

const text = (v: unknown, field: string, max = 120): string | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || !v.trim() || v.length > max || /[\u0000-\u001f]/.test(v)) throw new FindRejected(`${field} must be a short line of text.`);
  return v.trim();
};
const whole = (v: unknown, field: string, min: number, max: number): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) throw new FindRejected(`${field} must be a whole number from ${min} to ${max}.`);
  return n;
};
const list = (v: unknown, field: string): string[] => {
  if (v === undefined || v === null || v === '') return [];
  const items = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : null;
  if (!items || items.length > 10) throw new FindRejected(`${field} must be up to ten values.`);
  return [...new Set(items.map((x) => text(x, field)).filter((x): x is string => x !== undefined))];
};

/**
 * The search fields the Find screen sets. Everything else a search can hold keeps its column
 * default; nothing is assumed about who the seller is looking for.
 */
export function searchInputFromBody(b: Record<string, unknown>): SearchInput {
  const name = text(b.name, 'Name');
  if (!name) throw new FindRejected('Give the search a name.');
  const country = text(b.countryCode, 'Country', 2)?.toUpperCase();
  if (country !== undefined && !/^[A-Z]{2}$/.test(country)) throw new FindRejected('Country must be a two-letter code, like GB or US.');
  const presence = b.websitePresence ?? 'any';
  if (!['any', 'required', 'absent'].includes(String(presence))) throw new FindRejected('Website must be any, required or absent.');
  const input: SearchInput = {
    name,
    verticals: list(b.verticals, 'Industries'),
    websitePresence: presence as SearchInput['websitePresence'],
  };
  if (country) input.countryCode = country;
  const city = text(b.city, 'City');
  if (city) input.city = city;
  const min = whole(b.employeeMin, 'Fewest employees', 0, 1_000_000);
  const max = whole(b.employeeMax, 'Most employees', 0, 1_000_000);
  if (min !== undefined && max !== undefined && min > max) throw new FindRejected('Fewest employees cannot be more than most employees.');
  if (min !== undefined) input.employeeMin = min;
  if (max !== undefined) input.employeeMax = max;
  // Revenue is the seller's threshold in the currency they name; it is never converted.
  const revenueMin = whole(b.revenueMin, 'Lowest revenue', 0, 99_999_999_999_999);
  const revenueMax = whole(b.revenueMax, 'Highest revenue', 0, 99_999_999_999_999);
  if (revenueMin !== undefined && revenueMax !== undefined && revenueMin > revenueMax) throw new FindRejected('Lowest revenue cannot be more than highest revenue.');
  const revenueCurrency = text(b.revenueCurrency, 'Revenue currency', 3)?.toUpperCase();
  if (revenueCurrency !== undefined && !/^[A-Z]{3}$/.test(revenueCurrency)) throw new FindRejected('Revenue currency must be a three-letter code, like USD or GBP.');
  if ((revenueMin !== undefined || revenueMax !== undefined) && !revenueCurrency) throw new FindRejected('Say which currency the revenue is in.');
  if (revenueMin !== undefined) input.revenueMin = revenueMin;
  if (revenueMax !== undefined) input.revenueMax = revenueMax;
  if (revenueCurrency && (revenueMin !== undefined || revenueMax !== undefined)) input.revenueCurrency = revenueCurrency;
  const found = whole(b.maxDiscoveredPerRun, 'Businesses to find per run', 1, 100);
  if (found === undefined) throw new FindRejected('Say how many businesses a run may find (up to 100).');
  input.maxDiscoveredPerRun = found;
  const analyse = whole(b.maxBusinessesToAnalyze, 'Businesses to analyse', 1, 100);
  if (analyse !== undefined) input.maxBusinessesToAnalyze = analyse;
  return input;
}

/** The selection a person makes from a run. */
export function selectionFromBody(b: Record<string, unknown>): { businessIds: string[]; selectedBy: string } {
  const ids = b.businessIds;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100 || !ids.every((x) => typeof x === 'string' && /^\d{1,18}$/.test(x))) {
    throw new FindRejected('Choose at least one business.');
  }
  const selectedBy = text(b.selectedBy, 'Your name', 80);
  if (!selectedBy) throw new FindRejected('Say who is selecting these businesses.');
  return { businessIds: [...new Set(ids as string[])], selectedBy };
}

/** A database refusal during selection, in the seller's words. */
export function selectionRefusal(message: string): string | null {
  if (/businesses selected for analysis/.test(message)) return 'That is more businesses than this search may analyse.';
  if (/cannot move from \w+ to SELECTED/.test(message)) return 'Only qualified businesses can be selected. Review the others first.';
  return null;
}
