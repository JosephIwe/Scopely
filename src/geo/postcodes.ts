// Locating businesses on the map from a UK postcode they already carry (launch map).
//
// The map never invents a coordinate. A business is placed only when a source gave its position,
// and the one deterministic path Scopely has is the postcode: a provider record (Clay's locality,
// "Chelmsford, England CM1 7GU") or a postcode a person typed into a list. The postcode is looked
// up in the ONS Postcode Directory through postcodes.io (free, open data, no key, no account), and
// the business is placed at that postcode's centroid. geo_source says exactly that, so the map can
// say "placed at its postcode" rather than pretend to know the door.
//
// What this never does: look up a business by name or address (no geocoding of free text), place
// a business whose postcode the directory does not know, overwrite a coordinate a source already
// gave, or send anything but the postcodes themselves. Nothing here is a fact about the business
// beyond where its postcode is.
import type { Db } from '../tenancy/index.js';

/** The source recorded on every coordinate this module writes. */
export const POSTCODE_GEO_SOURCE = 'postcode centroid · ONS Postcode Directory via postcodes.io';

/** A full UK postcode (outward + inward code), the only thing the directory can place exactly. */
const UK_POSTCODE = /^([A-Z]{1,2}\d[A-Z\d]?)(\d[A-Z]{2})$/;

/** The postcode in its canonical form ("SW1A 1AA"), or null when it is not a full UK postcode. */
export function normalisePostcode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toUpperCase().replace(/\s+/g, '');
  if (v.length > 8) return null;
  const m = UK_POSTCODE.exec(v);
  return m ? `${m[1]} ${m[2]}` : null;
}

export interface PostcodePoint { latitude: number; longitude: number }

/** Where a search is centred: a point, what it is, and the directory record it came from. */
export interface PlacePoint extends PostcodePoint { label: string; source: string }

/** Looks up postcodes; returns the ones the directory knows. Unknown postcodes are simply absent. */
export interface PostcodeGeocoder {
  readonly name: string;
  lookup(postcodes: string[]): Promise<Map<string, PostcodePoint>>;
  /**
   * The centre of a UK postcode, postcode district ("CM1") or named place ("Chelmsford") a person
   * typed for a search, or null when the directory does not know it. Never a business's address.
   */
  place?(query: string): Promise<PlacePoint | null>;
}

const OUTCODE = /^[A-Z]{1,2}\d[A-Z\d]?$/;
const PLACE_TYPES = new Set(['City', 'Town', 'Village', 'Hamlet', 'Suburban Area', 'Other Settlement']);
const inUk = (lat: number, lon: number) => Number.isFinite(lat) && Number.isFinite(lon) && lat >= 49 && lat <= 61.5 && lon >= -9 && lon <= 2.5;

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const BATCH = 100; // postcodes.io's bulk limit

/** postcodes.io bulk lookup. One request per 100 postcodes, 8 seconds each. */
export function postcodesIoGeocoder(fetchImpl: FetchLike = fetch as unknown as FetchLike, base = 'https://api.postcodes.io'): PostcodeGeocoder {
  return {
    name: 'postcodes.io',
    async lookup(postcodes) {
      const out = new Map<string, PostcodePoint>();
      const unique = [...new Set(postcodes)];
      for (let i = 0; i < unique.length; i += BATCH) {
        const batch = unique.slice(i, i + BATCH);
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 8000);
        try {
          const r = await fetchImpl(`${base}/postcodes`, {
            method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ postcodes: batch }), signal: ctl.signal,
          });
          if (!r.ok) throw new GeocoderUnavailable(`postcode directory answered ${r.status}`);
          const body = await r.json() as { result?: { query?: unknown; result?: { postcode?: unknown; latitude?: unknown; longitude?: unknown } | null }[] };
          for (const row of body.result ?? []) {
            const q = normalisePostcode(row.query);
            const lat = row.result?.latitude, lon = row.result?.longitude;
            // The directory has postcodes with no grid reference (terminated or non-geographic): never placed.
            if (!q || typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
            if (lat < 49 || lat > 61.5 || lon < -9 || lon > 2.5) continue; // not in the UK: refuse rather than misplace
            out.set(q, { latitude: Math.round(lat * 1e6) / 1e6, longitude: Math.round(lon * 1e6) / 1e6 });
          }
        } catch (err) {
          if (err instanceof GeocoderUnavailable) throw err;
          throw new GeocoderUnavailable((err as Error).name === 'AbortError' ? 'postcode directory timed out' : 'postcode directory unreachable');
        } finally {
          clearTimeout(timer);
        }
      }
      return out;
    },
    async place(query) {
      const raw = String(query ?? '').trim();
      if (!raw || raw.length > 80) return null;
      const get = async (path: string): Promise<any> => {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 8000);
        try {
          const r = await fetchImpl(`${base}${path}`, { method: 'GET', headers: { accept: 'application/json' }, signal: ctl.signal });
          if (r.status === 404) return null;
          if (!r.ok) throw new GeocoderUnavailable(`postcode directory answered ${r.status}`);
          return ((await r.json()) as { result?: unknown }).result ?? null;
        } catch (err) {
          if (err instanceof GeocoderUnavailable) throw err;
          throw new GeocoderUnavailable((err as Error).name === 'AbortError' ? 'postcode directory timed out' : 'postcode directory unreachable');
        } finally { clearTimeout(timer); }
      };
      const pc = normalisePostcode(raw);
      if (pc) {
        const r = await get(`/postcodes/${encodeURIComponent(pc.replace(' ', ''))}`);
        return r && inUk(r.latitude, r.longitude) ? { latitude: r.latitude, longitude: r.longitude, label: pc, source: `postcode ${pc} · ONS Postcode Directory via postcodes.io` } : null;
      }
      const oc = raw.toUpperCase().replace(/\s+/g, '');
      if (OUTCODE.test(oc)) {
        const r = await get(`/outcodes/${encodeURIComponent(oc)}`);
        return r && inUk(r.latitude, r.longitude) ? { latitude: r.latitude, longitude: r.longitude, label: oc, source: `postcode district ${oc} centre · ONS via postcodes.io` } : null;
      }
      const rows = await get(`/places?q=${encodeURIComponent(raw)}&limit=10`);
      const want = raw.toLowerCase();
      const hit = (Array.isArray(rows) ? rows : []).find((p: any) => PLACE_TYPES.has(p.local_type) && String(p.name_1 ?? '').toLowerCase() === want
        && inUk(p.latitude, p.longitude));
      if (!hit) return null;
      const where = [hit.name_1, hit.county_unitary ?? hit.district_borough].filter(Boolean).join(', ');
      return { latitude: Math.round(hit.latitude * 1e6) / 1e6, longitude: Math.round(hit.longitude * 1e6) / 1e6, label: where,
        source: `${String(hit.local_type).toLowerCase()} ${where} · OS Open Names via postcodes.io` };
    },
  };
}

export class GeocoderUnavailable extends Error {}

export interface LocateResult {
  /** Businesses with a UK postcode and no position that were looked up. */
  checked: number;
  located: number;
  /** Postcodes the directory does not know: those businesses stay off the map. */
  unknownPostcode: number;
  /** Businesses that have no position and no usable postcode: nothing can place them. */
  noPostcode: number;
}

/**
 * Places the workspace's unplaced businesses that carry a full UK postcode. Only businesses in the
 * current workspace, only ones with no coordinate yet, and only from the postcode on file.
 */
export async function locateBusinesses(db: Db, geocoder: PostcodeGeocoder, opts: { businessIds?: string[]; limit?: number } = {}): Promise<LocateResult> {
  const limit = Math.min(opts.limit ?? 500, 2000);
  const rows = (await db.query<{ id: string; postal_code: string | null; country_code: string | null }>(
    `SELECT id::text, postal_code, country_code FROM scopely.businesses
      WHERE workspace_id = scopely.current_workspace_id() AND latitude IS NULL
        AND ($1::bigint[] IS NULL OR id = ANY ($1))
      ORDER BY id LIMIT $2`, [opts.businessIds ?? null, limit])).rows;
  const wanted = new Map<string, string>();
  let noPostcode = 0;
  for (const r of rows) {
    const pc = normalisePostcode(r.postal_code);
    // A postcode-shaped value on a business recorded in another country is not a UK postcode.
    if (!pc || (r.country_code && !['GB', 'UK'].includes(r.country_code.toUpperCase()))) { noPostcode += 1; continue; }
    wanted.set(r.id, pc);
  }
  if (wanted.size === 0) return { checked: 0, located: 0, unknownPostcode: 0, noPostcode };
  const points = await geocoder.lookup([...wanted.values()]);
  let located = 0;
  for (const [id, pc] of wanted) {
    const p = points.get(pc);
    if (!p) continue;
    const u = await db.query(`UPDATE scopely.businesses SET latitude = $2, longitude = $3, geo_source = $4
      WHERE id = $1 AND workspace_id = scopely.current_workspace_id() AND latitude IS NULL`, [id, p.latitude, p.longitude, POSTCODE_GEO_SOURCE]);
    located += u.rowCount ?? 0;
  }
  return { checked: wanted.size, located, unknownPostcode: wanted.size - located, noPostcode };
}
