// Demo data. A business whose address is on a name reserved for documentation and testing
// (RFC 2606, RFC 6761) can never be a real business: the demo seed and the synthetic people
// recordings use them for exactly that reason. The app labels such a business as demo data so it
// is never read as a live prospect. Every other business is treated as real, whatever its source.

const RESERVED_TLDS = ['example', 'test', 'invalid', 'localhost'];
const RESERVED_DOMAINS = ['example.com', 'example.net', 'example.org'];

function host(value: string): string | null {
  const v = value.trim().toLowerCase();
  if (!v) return null;
  try { return new URL(v.includes('://') ? v : `https://${v}`).hostname.replace(/\.$/, ''); } catch { return null; }
}

/** True when the host is a reserved documentation or test name. */
export function isReservedHost(value: string): boolean {
  const h = host(value);
  if (!h) return false;
  const tld = h.slice(h.lastIndexOf('.') + 1);
  return RESERVED_TLDS.includes(tld) || RESERVED_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`));
}

/** A business is demo data when every address it has is reserved, and it has at least one. */
export function isDemoBusiness(domain: string | null, websiteUrl: string | null = null): boolean {
  const known = [domain, websiteUrl].filter((v): v is string => Boolean(v && v.trim()));
  return known.length > 0 && known.every(isReservedHost);
}
