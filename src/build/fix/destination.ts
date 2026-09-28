// The corrected destination of a broken contact link. A person types it; Scopely only checks its
// shape and writes it as a link (F4). Nothing here guesses a country code, completes a number or
// derives a value from the broken one.

export type Channel = 'phone' | 'whatsapp' | 'email';

export const CHANNELS: Channel[] = ['phone', 'whatsapp', 'email'];

/** Which destination repairs which finding. Mirrors fix_channel_allowed in migration 012. */
export const CHANNELS_FOR: Record<string, Channel[]> = {
  'E-TEL-BROKEN': ['phone'],
  'E-WA-BROKEN': ['whatsapp'],
  'E-EMAIL-INVALID': ['email'],
  'E-LINK-TARGET-MISMATCH': ['phone', 'whatsapp', 'email'],
};

/** The link shapes the database accepts for a corrected destination. */
export const HREF_SHAPE: Record<Channel, RegExp> = {
  phone: /^tel:\+[1-9][0-9]{6,14}$/,
  whatsapp: /^https:\/\/wa\.me\/[1-9][0-9]{7,14}$/,
  email: /^mailto:[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,24}$/,
};

export class DestinationError extends Error {}

/** A person's entry as the link it becomes, or a refusal that says what to type. */
export function toHref(channel: Channel, value: string): string {
  const v = String(value ?? '').trim();
  if (!v) throw new DestinationError('Type the destination the link should open.');
  if (v.length > 200) throw new DestinationError('That is too long for a contact destination.');
  switch (channel) {
    case 'phone': {
      let d = v.replace(/^tel:/i, '').replace(/[\s().-]/g, '');
      if (d.startsWith('00')) d = `+${d.slice(2)}`;
      if (!d.startsWith('+')) throw new DestinationError('Include the country code, for example +44 20 7946 0000. Scopely does not guess it.');
      const href = `tel:${d}`;
      if (!HREF_SHAPE.phone.test(href)) throw new DestinationError('That is not a phone number with a country code.');
      return href;
    }
    case 'whatsapp': {
      let d = v.replace(/^https?:\/\/(wa\.me|api\.whatsapp\.com\/send\?phone=)\/?/i, '').replace(/[\s().+-]/g, '');
      if (d.startsWith('00')) d = d.slice(2);
      if (d.startsWith('0')) throw new DestinationError('Include the country code, for example 447700900123. Scopely does not guess it.');
      const href = `https://wa.me/${d}`;
      if (!HREF_SHAPE.whatsapp.test(href)) throw new DestinationError('That is not a WhatsApp number with a country code.');
      return href;
    }
    case 'email': {
      const href = `mailto:${v.replace(/^mailto:/i, '')}`;
      if (!HREF_SHAPE.email.test(href)) throw new DestinationError('That is not an email address.');
      return href;
    }
    default:
      throw new DestinationError('Choose a phone number, WhatsApp or email.');
  }
}

/** True when `href` is a destination of the given kind that the Fix Builder can write. */
export const isValidHref = (channel: Channel, href: string) => HREF_SHAPE[channel]?.test(href) ?? false;

/** A destination as a person reads it. */
export function describeHref(href: string): string {
  if (/^tel:/i.test(href)) return `Calls ${href.slice(4)}`;
  if (/^https:\/\/wa\.me\//.test(href)) return `Opens WhatsApp to +${href.slice(14)}`;
  if (/^mailto:/i.test(href)) return `Emails ${href.slice(7)}`;
  return `Opens ${href}`;
}
