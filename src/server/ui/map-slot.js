// The map's place in the product shell (U3: the map is deferred). The approved dashboard puts a
// map behind the feed, linked both ways: hovering a card lifts its marker and selecting a marker
// opens its Case File. No map provider, tiles or coordinates are chosen yet, so this slot says so
// plainly and keeps the interface a map will implement:
//
//   const slot = mountMapSlot(el);
//   slot.update(items)      // the opportunities the feed currently shows
//   slot.highlight(id)      // a card is hovered (null when none)
//   slot.select(id)         // a Case File is open (null when closed)
//   slot.onSelect = (id) => …   // set by the shell; a map calls it when a marker is chosen
//
// A real map replaces this module's body and nothing else. It would read coordinates through a
// map endpoint over listMapBusinesses (not exposed yet; it only returns businesses whose
// coordinates a named source gave), never from this list.
import { h } from './lib.js';

export function mountMapSlot(el) {
  const count = h('p', { class: 'mp-count' });
  el.replaceChildren(h('div', { class: 'mp-deferred', 'data-map': 'deferred' },
    h('div', { class: 'mp-card' },
      h('span', { class: 'plan', text: 'PLANNED' }),
      h('h2', { text: 'Map' }),
      h('p', { text: 'The opportunity map is planned. Until then, every opportunity is in the list.' }),
      count)));
  const slot = {
    onSelect: null,
    update(items) {
      const web = items.filter((o) => o.path === 'WEBSITE').length;
      const fix = items.filter((o) => o.path === 'FIX').length;
      count.replaceChildren(
        h('span', { text: `${items.length} ${items.length === 1 ? 'opportunity' : 'opportunities'}` }),
        h('span', {}, h('i', { class: 'dot web' }), `${web} need a website`),
        h('span', {}, h('i', { class: 'dot fix' }), `${fix} need a fix`));
    },
    highlight() { /* a map lifts the hovered business's marker */ },
    select() { /* a map flies to the selected business */ },
  };
  return slot;
}
