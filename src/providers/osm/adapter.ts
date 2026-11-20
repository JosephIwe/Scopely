// OpenStreetMap as a discovery source (A54): real local businesses, found by category around a
// point, from open data (© OpenStreetMap contributors, ODbL), through the Overpass API.
//
// Why it is here: a workspace without a Clay key could find nothing, and no source gave a business's
// position. OpenStreetMap is free, needs no account or key, and its contributors record each
// business's category, its position on the ground and, often, its website, phone and postcode.
//
// What Scopely takes from it, and how it is labelled:
// - The business exists at that place, under that name, in that category: REPORTED by the source.
// - Its coordinate: the mapped point (or the centre of the mapped outline), with geo_source naming
//   the OpenStreetMap element, so the map says where the position came from.
// - Its website, phone and postcode: what the source lists. A listed website is not an observation
//   of a live site (website status stays UNKNOWN until Scopely fetches it), and no website listed is
//   not evidence of no website (A36): it never opens a Website opportunity.
// - The industry is the seller's own word that matched (their search said "dentist", the element is
//   tagged amenity=dentist), so qualification compares like with like. The tag is kept in the record.
// - Country is GB only when the listed postcode is a full UK postcode; otherwise it stays unknown.
//
// What it never does: search by business name, fetch anything but one Overpass query per run, or
// read the businesses' own sites (ANALYZE does that, for the ones a person selects).
import type { SearchCriteria } from '../../discovery/index.js';
import { normalisePostcode } from '../../geo/postcodes.js';
import type { BusinessDiscoveryProvider, DiscoveryPage, ProviderBusiness } from '../discovery.js';
import { ProviderError, type CallCredential } from '../gateway.js';

export const OSM_ATTRIBUTION = '© OpenStreetMap contributors (ODbL)';
export const OSM_OVERPASS = 'https://overpass-api.de/api/interpreter';
/** The widest circle one search may ask about: a town and its surroundings, never a region. */
export const OSM_MAX_RADIUS_KM = 25;

type Tag = readonly [key: string, value: string];

/**
 * Local-business categories and the OpenStreetMap tags that mean them. A search's industry is
 * matched against these words (singular or plural, any case). Anything else can be asked for
 * exactly as `osm:key=value` (for example `osm:shop=florist`).
 */
export const OSM_CATEGORIES: Record<string, readonly Tag[]> = {
  dentist: [['amenity', 'dentist'], ['healthcare', 'dentist']],
  'dental practice': [['amenity', 'dentist'], ['healthcare', 'dentist']],
  clinic: [['amenity', 'clinic'], ['healthcare', 'clinic']],
  doctor: [['amenity', 'doctors'], ['healthcare', 'doctor']],
  'gp surgery': [['amenity', 'doctors']],
  physiotherapist: [['healthcare', 'physiotherapist']],
  physio: [['healthcare', 'physiotherapist']],
  physiotherapy: [['healthcare', 'physiotherapist']],
  chiropractor: [['healthcare', 'chiropractor']],
  osteopath: [['healthcare', 'osteopath']],
  podiatrist: [['healthcare', 'podiatrist']],
  optician: [['shop', 'optician'], ['healthcare', 'optometrist']],
  optometrist: [['healthcare', 'optometrist'], ['shop', 'optician']],
  pharmacy: [['amenity', 'pharmacy']],
  'hearing aids': [['shop', 'hearing_aids']],
  aesthetics: [['shop', 'beauty'], ['healthcare', 'cosmetic']],
  'aesthetics clinic': [['shop', 'beauty'], ['healthcare', 'cosmetic']],
  beauty: [['shop', 'beauty']],
  'beauty salon': [['shop', 'beauty']],
  'nail salon': [['shop', 'beauty']],
  hairdresser: [['shop', 'hairdresser']],
  barber: [['shop', 'hairdresser']],
  massage: [['shop', 'massage']],
  tattoo: [['shop', 'tattoo']],
  spa: [['leisure', 'spa'], ['amenity', 'spa']],
  vet: [['amenity', 'veterinary']],
  veterinary: [['amenity', 'veterinary']],
  'pet grooming': [['shop', 'pet_grooming']],
  gym: [['leisure', 'fitness_centre']],
  'fitness centre': [['leisure', 'fitness_centre']],
  'yoga studio': [['leisure', 'fitness_centre'], ['sport', 'yoga']],
  restaurant: [['amenity', 'restaurant']],
  cafe: [['amenity', 'cafe']],
  pub: [['amenity', 'pub']],
  bar: [['amenity', 'bar']],
  takeaway: [['amenity', 'fast_food']],
  bakery: [['shop', 'bakery']],
  butcher: [['shop', 'butcher']],
  florist: [['shop', 'florist']],
  hotel: [['tourism', 'hotel']],
  'guest house': [['tourism', 'guest_house']],
  'bed and breakfast': [['tourism', 'guest_house']],
  plumber: [['craft', 'plumber']],
  electrician: [['craft', 'electrician']],
  builder: [['craft', 'builder']],
  roofer: [['craft', 'roofer']],
  carpenter: [['craft', 'carpenter']],
  painter: [['craft', 'painter']],
  'heating engineer': [['craft', 'hvac']],
  hvac: [['craft', 'hvac']],
  locksmith: [['shop', 'locksmith'], ['craft', 'locksmith']],
  gardener: [['craft', 'gardener']],
  photographer: [['craft', 'photographer'], ['shop', 'photo']],
  'car repair': [['shop', 'car_repair']],
  garage: [['shop', 'car_repair']],
  mechanic: [['shop', 'car_repair']],
  'car wash': [['amenity', 'car_wash']],
  'driving school': [['amenity', 'driving_school']],
  solicitor: [['office', 'lawyer']],
  lawyer: [['office', 'lawyer']],
  accountant: [['office', 'accountant']],
  'estate agent': [['office', 'estate_agent'], ['shop', 'estate_agent']],
  'letting agent': [['office', 'estate_agent']],
  'insurance broker': [['office', 'insurance']],
  'financial adviser': [['office', 'financial_advisor']],
  'architect': [['office', 'architect']],
  nursery: [['amenity', 'childcare'], ['amenity', 'kindergarten']],
  childcare: [['amenity', 'childcare']],
  'care home': [['amenity', 'social_facility'], ['social_facility', 'nursing_home']],
  'funeral director': [['shop', 'funeral_directors']],
  'dry cleaner': [['shop', 'dry_cleaning']],
  'print shop': [['shop', 'copyshop']],
  'bicycle shop': [['shop', 'bicycle']],
  'furniture shop': [['shop', 'furniture']],
  jeweller: [['shop', 'jewelry']],
  'clothes shop': [['shop', 'clothes']],
};

const TAG_RE = /^osm:([a-z][a-z0-9_:]{0,40})=([a-z0-9_ -]{1,60})$/i;

/** The category words this source knows, for the search form. */
export const osmCategoryWords = () => Object.keys(OSM_CATEGORIES).sort();

/** A seller's industry word in the form the table uses: lower case, single spaces, singular. */
function wordKey(w: string): string {
  const v = w.trim().toLowerCase().replace(/\s+/g, ' ');
  if (OSM_CATEGORIES[v]) return v;
  for (const s of [v.replace(/ies$/, 'y'), v.replace(/es$/, ''), v.replace(/s$/, '')]) if (OSM_CATEGORIES[s]) return s;
  return v;
}

/** Each industry word the search named, with the tags it means; or the words this source cannot search. */
export function osmTagsFor(words: string[]): { terms: { word: string; tags: Tag[] }[]; unknown: string[] } {
  const terms: { word: string; tags: Tag[] }[] = [];
  const unknown: string[] = [];
  for (const w of words) {
    const raw = w.trim();
    if (!raw) continue;
    const t = TAG_RE.exec(raw);
    if (t) { terms.push({ word: raw, tags: [[t[1]!.toLowerCase(), t[2]!.toLowerCase().replace(/ /g, '_')]] }); continue; }
    const k = wordKey(raw);
    if (OSM_CATEGORIES[k]) terms.push({ word: raw, tags: [...OSM_CATEGORIES[k]!] });
    else unknown.push(raw);
  }
  return { terms, unknown };
}

/** The one Overpass query for a search: named elements with any of the tags, within the circle. */
export function overpassQuery(tags: Tag[], lat: number, lon: number, radiusKm: number, max: number): string {
  const r = Math.round(radiusKm * 1000);
  const uniq = [...new Map(tags.map((t) => [`${t[0]}=${t[1]}`, t])).values()];
  const parts = uniq.map(([k, v]) => `nwr["${k}"="${v}"]["name"](around:${r},${lat.toFixed(6)},${lon.toFixed(6)});`).join('');
  return `[out:json][timeout:25];(${parts});out center tags ${Math.max(1, Math.min(max, 500))};`;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number; lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

/** Overpass over HTTPS. One POST per run, 30 seconds at most; nothing is sent but the query. */
export class OverpassTransport {
  constructor(private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike, private readonly url = OSM_OVERPASS) {}
  async query(q: string): Promise<{ elements: OverpassElement[]; timestamp: string | null }> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 30_000);
    try {
      const r = await this.fetchImpl(this.url, {
        method: 'POST', signal: ctl.signal,
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'user-agent': 'Scopely business discovery (open data)' },
        body: `data=${encodeURIComponent(q)}`,
      });
      if (r.status === 429) throw new ProviderError('rate_limited');
      if (r.status === 400) throw new ProviderError('invalid_request', null, false);
      if (r.status === 504 || r.status >= 500) throw new ProviderError('provider_unavailable');
      if (!r.ok) throw new ProviderError('invalid_request', `answered ${r.status}`, false);
      const body = await r.json() as { elements?: unknown; osm3s?: { timestamp_osm_base?: unknown }; remark?: unknown };
      if (!Array.isArray(body.elements)) throw new ProviderError('malformed_response');
      // Overpass answers 200 with a remark when the query ran out of time or memory: nothing is complete.
      if (typeof body.remark === 'string' && /runtime error|timed out|out of memory/i.test(body.remark)) throw new ProviderError('provider_unavailable');
      const ts = body.osm3s?.timestamp_osm_base;
      return { elements: body.elements as OverpassElement[], timestamp: typeof ts === 'string' ? ts : null };
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw (err as Error).name === 'AbortError' ? new ProviderError('timeout') : new ProviderError('network');
    } finally { clearTimeout(timer); }
  }
}

const clip = (v: string | undefined, n: number) => (v && v.trim() ? v.trim().slice(0, n) : undefined);

/** The listed website as an absolute http(s) URL and its host, or nothing when it is not one. */
export function listedWebsite(tags: Record<string, string>): { url: string; domain: string } | null {
  const raw = (tags.website ?? tags['contact:website'] ?? tags.url ?? '').split(';')[0]!.trim();
  if (!raw) return null;
  // A scheme other than http(s) (mailto:, tel:, javascript:) is not a website.
  const scheme = /^([a-z][a-z0-9+-]*):/i.exec(raw);
  if (scheme && !/^https?$/i.test(scheme[1]!)) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (!host.includes('.') || /(^|\.)(facebook|instagram|twitter|x|linkedin|tiktok|google|goo|yell|wa)\.(com|me|gl|co\.uk)$/.test(host)) return null;
    return { url: u.toString(), domain: host };
  } catch { return null; }
}

/** One element in Scopely's words, or null when it has no name or no position. */
export function normalizeOsmElement(el: OverpassElement, terms: { word: string; tags: Tag[] }[], observedAt: string): ProviderBusiness | null {
  const t = el.tags ?? {};
  const name = clip(t.name, 200);
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (!name || typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const ref = `${el.type}/${el.id}`;
  const term = terms.find((x) => x.tags.some(([k, v]) => t[k] === v));
  const site = listedWebsite(t);
  const postcode = normalisePostcode(t['addr:postcode']);
  const street = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ');
  const kept: Record<string, unknown> = { element: ref, name };
  for (const k of ['amenity', 'shop', 'healthcare', 'craft', 'office', 'leisure', 'tourism', 'brand', 'brand:wikidata', 'operator',
    'website', 'contact:website', 'addr:postcode', 'addr:city', 'addr:street', 'addr:housenumber', 'check_date', 'opening_hours']) {
    if (t[k]) kept[k] = t[k]!.slice(0, 300);
  }
  return {
    source: { provider: 'openstreetmap', sourceType: 'dataset', reference: ref, discoveredAt: observedAt, record: kept },
    name,
    ...(site ? { domain: site.domain, websiteUrl: site.url } : {}),
    ...(clip(t.phone ?? t['contact:phone'], 40) ? { phone: clip(t.phone ?? t['contact:phone'], 40) } : {}),
    ...(term ? { vertical: term.word.toLowerCase() } : {}),
    ...(street ? { addressLine: street.slice(0, 200) } : {}),
    ...(clip(t['addr:city'] ?? t['addr:town'], 120) ? { city: clip(t['addr:city'] ?? t['addr:town'], 120) } : {}),
    ...(postcode ? { postalCode: postcode, countryCode: 'GB' } : {}),
    geo: {
      latitude: Math.round(lat * 1e6) / 1e6, longitude: Math.round(lon * 1e6) / 1e6,
      source: `OpenStreetMap ${ref} (${el.type === 'node' ? 'mapped point' : 'centre of mapped outline'}) · ${OSM_ATTRIBUTION}`,
    },
  };
}

/**
 * The BusinessDiscoveryProvider for OpenStreetMap. It needs no key (`keyless`): the run records each
 * call in provider_operations with no connection and no billing, and its cost as not reported.
 */
export class OsmBusinessDiscoveryAdapter implements BusinessDiscoveryProvider {
  readonly provider = 'openstreetmap';
  readonly transport = 'live' as const;
  readonly label = 'OpenStreetMap';
  readonly keyless = true;
  categories(): string[] { return osmCategoryWords(); }
  constructor(private readonly t: Pick<OverpassTransport, 'query'> = new OverpassTransport(), private readonly now = () => new Date()) {}

  plan(c: SearchCriteria): { request: Record<string, unknown> } | { refused: string } {
    if (c.centerLatitude == null || c.centerLongitude == null || c.radiusKm == null) {
      return { refused: 'OpenStreetMap searches around a place: set where to search (a postcode or town) and how far around it.' };
    }
    if (!(c.radiusKm > 0) || c.radiusKm > OSM_MAX_RADIUS_KM) return { refused: `Search within ${OSM_MAX_RADIUS_KM} km or less of the place.` };
    const words = [...c.verticals, ...c.subverticals, ...c.specialties];
    if (words.length === 0) return { refused: 'Name at least one industry, such as dentist, physiotherapist or plumber.' };
    const { terms, unknown } = osmTagsFor(words);
    if (unknown.length) {
      return { refused: `OpenStreetMap has no category for ${unknown.map((u) => `"${u}"`).join(', ')}. Use a listed industry (for example dentist, beauty salon, plumber) or an exact tag such as osm:shop=florist.` };
    }
    const max = Math.min(c.maxDiscoveredPerRun ?? 100, 100) * 3;
    return { request: { query: overpassQuery(terms.flatMap((x) => x.tags), c.centerLatitude, c.centerLongitude, c.radiusKm, max), terms } };
  }

  async page(request: Record<string, unknown>, _cursor: string | null, _credential: CallCredential | null): Promise<DiscoveryPage> {
    const terms = request.terms as { word: string; tags: Tag[] }[];
    const { elements, timestamp } = await this.t.query(String(request.query));
    const observedAt = (timestamp && !Number.isNaN(Date.parse(timestamp)) ? new Date(timestamp) : this.now()).toISOString();
    const businesses = elements.map((e) => normalizeOsmElement(e, terms, observedAt)).filter((b): b is ProviderBusiness => b !== null);
    // Nearest first is not something Overpass gives; Scopely's own priority orders the run.
    return { businesses, next: null, ref: null, cost: null };
  }
}
