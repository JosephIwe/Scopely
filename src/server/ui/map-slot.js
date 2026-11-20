// The opportunity map (A51, supersedes the U3 placeholder). It draws the opportunities the feed is
// showing, at the position a named source gave their business, and nowhere else:
//
//   - a point comes only from item.location ({ latitude, longitude, source }), which the server sets
//     only when the business row carries a coordinate with its geo_source. No address is looked up in
//     the browser and nothing is placed at a guessed or default position;
//   - an opportunity with no position is counted and listed under the map ("not on the map"), never drawn;
//   - a point placed from a postcode says so ("placed at its postcode"), and demo data says DEMO.
//
// The library is MapLibre GL, served by this server (/vendor). The base map is OpenFreeMap's
// vector tiles (free, no key): the browser asks it for the tiles on screen and nothing else. If the
// tiles cannot load, the points still draw on a plain ground, and the map says so.
//
//   const slot = mountMapSlot(el);
//   slot.update(items, info)  // the opportunities the feed shows; info: { total, placeable, onLocate }
//   slot.highlight(id)        // a card is hovered (null when none)
//   slot.select(id)           // a Case File is open (null when closed)
//   slot.onSelect = (id) => … // set by the shell; called when a point is chosen
import { h } from './lib.js';

const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';
const UK = { center: [-2.6, 54.3], zoom: 4.7 };
const PLAIN_STYLE = { version: 8, sources: {}, layers: [{ id: 'ground', type: 'background', paint: { 'background-color': '#ECE7DE' } }] };
const COLOR = { WEBSITE: '#D98E3A', FIX: '#2C5BB4' };

let lib = null;
function loadLibrary() {
  if (!lib) {
    if (!document.querySelector('link[data-maplibre]')) {
      document.head.append(h('link', { rel: 'stylesheet', href: '/vendor/maplibre-gl.css', 'data-maplibre': '' }));
    }
    lib = import('/vendor/maplibre-gl.mjs').then((m) => m.default ?? m);
  }
  return lib;
}

/** The map's points: only items that carry a position. Pure, so it can be tested without a browser. */
export function mapPoints(items) {
  const features = [];
  for (const o of items) {
    const loc = o.location;
    if (!loc || !Number.isFinite(loc.latitude) || !Number.isFinite(loc.longitude)) continue;
    if (Math.abs(loc.latitude) > 90 || Math.abs(loc.longitude) > 180) continue;
    features.push({
      type: 'Feature', id: Number(o.opportunityId),
      geometry: { type: 'Point', coordinates: [loc.longitude, loc.latitude] },
      properties: { id: o.opportunityId, path: o.path ?? 'OTHER', demo: Boolean(o.demo), business: o.business ?? '', issue: o.issue ?? '',
        precision: /postcode/i.test(loc.source) ? 'postcode' : /^demo/i.test(loc.source) ? 'demo' : 'source', source: loc.source },
    });
  }
  return { type: 'FeatureCollection', features };
}

export function mountMapSlot(el) {
  const canvas = h('div', { class: 'mp-canvas', role: 'region', 'aria-label': 'Opportunity map' });
  const empty = h('div', { class: 'mp-empty', hidden: true });
  const legend = h('div', { class: 'mp-legend', 'aria-hidden': 'true' },
    h('span', {}, h('i', { class: 'dot web' }), 'Needs a website'), h('span', {}, h('i', { class: 'dot fix' }), 'Needs a fix'));
  const note = h('p', { class: 'mp-note', hidden: true });
  el.replaceChildren(h('div', { class: 'mp', 'data-map': 'live' }, canvas, legend, empty, note));

  let map = null;
  let ready = false;
  let data = mapPoints([]);
  let lastKey = '';
  let hovered = null;
  let selected = null;
  let popup = null;
  let failed = false;

  const slot = {
    onSelect: null,
    update(items, info = {}) {
      data = mapPoints(items);
      const unplaced = items.length - data.features.length;
      const key = data.features.map((f) => f.id).join(',');
      drawOverlay(items.length, unplaced, info);
      if (ready) { map.getSource('opps').setData(data); if (key !== lastKey) fit(); }
      lastKey = key;
      // The base map shows even before there is a point, so the first screen is a map, not a blank.
      if (!map && !failed) start();
    },
    highlight(id) { setState(hovered, { hover: false }); hovered = id; setState(id, { hover: true }); },
    select(id) {
      setState(selected, { selected: false });
      selected = id;
      setState(id, { selected: true });
      const f = id && data.features.find((x) => String(x.id) === String(id));
      if (ready && f) map.easeTo({ center: f.geometry.coordinates, zoom: Math.max(map.getZoom(), 12), duration: 600 });
    },
    get map() { return map; },
  };

  function setState(id, st) { if (ready && id && data.features.some((f) => String(f.id) === String(id))) map.setFeatureState({ source: 'opps', id: Number(id) }, st); }

  function drawOverlay(total, unplaced, info) {
    const placed = total - unplaced;
    if (total === 0) {
      empty.hidden = false;
      empty.replaceChildren(h('div', { class: 'mp-card' }, h('span', { class: 'eyebrow', text: 'Map' }),
        h('h2', { text: info.anyBusinesses ? 'No opportunities match yet' : 'Your opportunities appear here' }),
        h('p', { text: info.anyBusinesses ? 'Analysed businesses with an observed problem show here as points: amber needs a website, blue needs a fix.'
          : 'Find businesses first. Each one Scopely analyses and finds a real problem on becomes a point on this map, at the position its source gave.' })));
    } else if (placed === 0) {
      empty.hidden = false;
      empty.replaceChildren(h('div', { class: 'mp-card' }, h('span', { class: 'eyebrow', text: 'Map' }),
        h('h2', { text: `None of these ${total} ${total === 1 ? 'opportunity has' : 'opportunities have'} a position yet` }),
        h('p', { text: 'Scopely only places a business where a source put it: a UK postcode on file, or coordinates from a provider. It never guesses.' }),
        info.placeable ? h('button', { class: 'btn sm', onclick: (e) => info.onLocate?.(e.currentTarget) }, `Place ${info.placeable} from ${info.placeable === 1 ? 'its postcode' : 'their postcodes'}`) : null));
    } else empty.hidden = true;
    note.hidden = !(placed > 0 && (unplaced > 0 || failed));
    note.replaceChildren(
      unplaced > 0 ? h('span', { text: `${unplaced} not on the map: no source gave ${unplaced === 1 ? 'its' : 'their'} position.` }) : null,
      unplaced > 0 && info.placeable ? h('button', { class: 'lnk', onclick: (e) => info.onLocate?.(e.currentTarget) }, `Place ${info.placeable} from postcode`) : null,
      failed ? h('span', { text: 'The base map could not load; positions are still exact.' }) : null);
  }

  async function start() {
    let ml;
    try { ml = await loadLibrary(); } catch { failed = true; canvas.classList.add('mp-off'); return; }
    if (map) return;
    try {
      map = new ml.Map({ container: canvas, style: STYLE_URL, center: UK.center, zoom: UK.zoom, attributionControl: { compact: true },
        cooperativeGestures: false, dragRotate: false, pitchWithRotate: false, touchPitch: false });
    } catch {
      failed = true; canvas.classList.add('mp-off');
      canvas.replaceChildren(h('p', { class: 'mp-nogl', text: 'This browser cannot draw the map. Every opportunity is in the list.' }));
      return;
    }
    map.touchZoomRotate.disableRotation();
    map.addControl(new ml.NavigationControl({ showCompass: false }), 'bottom-right');
    // Tiles that never arrive: draw the points on plain ground rather than leave an empty frame.
    const giveUp = setTimeout(() => { if (!ready) plain(); }, 7000);
    map.once('error', () => { if (!ready) { clearTimeout(giveUp); plain(); } });
    map.on('style.load', () => { clearTimeout(giveUp); tint(); addLayers(ml); });
  }

  function plain() {
    failed = true;
    map.setStyle(PLAIN_STYLE);
    note.hidden = false;
    if (!note.textContent.includes('base map')) note.append(h('span', { text: 'The base map could not load; positions are still exact.' }));
  }

  /** The positron base, warmed to Scopely's paper and ink. Only colours change. */
  function tint() {
    for (const l of map.getStyle().layers ?? []) {
      try {
        if (l.type === 'background') map.setPaintProperty(l.id, 'background-color', '#EFEBE3');
        else if (l.type === 'fill' && /water/.test(l.id)) map.setPaintProperty(l.id, 'fill-color', '#DCE2E6');
        else if (l.type === 'fill' && /(park|landcover|landuse)/.test(l.id)) map.setPaintProperty(l.id, 'fill-color', '#E6E2D7');
      } catch { /* a layer the style does not paint that way */ }
    }
  }

  function addLayers(ml) {
    if (map.getSource('opps')) return;
    map.addSource('opps', { type: 'geojson', data });
    map.addLayer({ id: 'opps-halo', type: 'circle', source: 'opps', paint: {
      'circle-radius': ['case', ['boolean', ['feature-state', 'selected'], false], 16, ['boolean', ['feature-state', 'hover'], false], 13, 0],
      'circle-color': ['match', ['get', 'path'], 'WEBSITE', COLOR.WEBSITE, 'FIX', COLOR.FIX, '#6F6A61'], 'circle-opacity': 0.22 } });
    map.addLayer({ id: 'opps', type: 'circle', source: 'opps', paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 5, 10, 7, 15, 9],
      'circle-color': ['match', ['get', 'path'], 'WEBSITE', COLOR.WEBSITE, 'FIX', COLOR.FIX, '#6F6A61'],
      'circle-stroke-color': ['case', ['get', 'demo'], '#1B1A18', '#FFFFFF'],
      'circle-stroke-width': ['case', ['boolean', ['feature-state', 'selected'], false], 3, 1.5] } });
    ready = true;
    map.on('mouseenter', 'opps', (e) => {
      map.getCanvas().style.cursor = 'pointer';
      const f = e.features?.[0];
      if (!f) return;
      popup?.remove();
      const p = f.properties;
      popup = new ml.Popup({ closeButton: false, closeOnClick: false, offset: 12, className: 'mp-pop' }).setLngLat(f.geometry.coordinates)
        .setDOMContent(h('div', {}, h('b', { text: p.business }), p.demo ? h('span', { class: 'mp-demo', text: 'DEMO DATA' }) : null,
          h('span', { text: p.issue || (p.path === 'WEBSITE' ? 'Needs a website' : 'Observed problem') }),
          h('small', { text: p.precision === 'postcode' ? 'Placed at its postcode' : p.precision === 'demo' ? 'Fictional position' : `Position: ${p.source}` })))
        .addTo(map);
    });
    map.on('mouseleave', 'opps', () => { map.getCanvas().style.cursor = ''; popup?.remove(); popup = null; });
    map.on('click', 'opps', (e) => { const id = e.features?.[0]?.properties?.id; if (id && slot.onSelect) slot.onSelect(String(id)); });
    if (selected) slot.select(selected);
    fit();
  }

  function fit() {
    if (!ready || !data.features.length) return;
    const xs = data.features.map((f) => f.geometry.coordinates[0]);
    const ys = data.features.map((f) => f.geometry.coordinates[1]);
    // On a wide screen the panel floats over the right of the map: keep the points clear of it.
    const panel = document.querySelector('.sh-panel');
    const side = window.innerWidth > 860 && panel ? panel.offsetWidth + 100 : 40;
    const pad = { top: window.innerWidth > 860 ? 140 : 40, bottom: 70, left: 50, right: side };
    if (data.features.length === 1) map.jumpTo({ center: [xs[0], ys[0]], zoom: 12 });
    else map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: pad, maxZoom: 13, duration: 0 });
  }

  return slot;
}
