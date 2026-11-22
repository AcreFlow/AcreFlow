/* AcreFlow app: map, field drawing, overlays, rain, dirt work plan, report export. */
{
'use strict';
const VERSION = '13';
const $ = id => document.getElementById(id);
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/';
const DEM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const E = FieldEngine, { FT, ACRE, rampColor, ELEV_RAMP } = E;

const store = { get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} } };
const saved = store.get('ftf-view');
$('ver').textContent = 'AcreFlow v' + VERSION;

const map = new maplibregl.Map({
  container: 'map',
  center: saved ? saved.c : [-90.19, 41.30],
  zoom: saved ? saved.z : 13,
  maxPitch: 75,
  attributionControl: false,
  style: {
    version: 8,
    sources: {
      sat: { type: 'raster', tiles: [ESRI + 'World_Imagery/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, maxzoom: 19, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' },
      roads: { type: 'raster', tiles: [ESRI + 'Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, maxzoom: 19 },
      places: { type: 'raster', tiles: [ESRI + 'Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, maxzoom: 19 },
      dem: { type: 'raster-dem', tiles: [DEM_URL], encoding: 'terrarium', tileSize: 256, maxzoom: 15, attribution: 'Elevation: USGS 3DEP via AWS Terrain Tiles' },
      demhs: { type: 'raster-dem', tiles: [DEM_URL], encoding: 'terrarium', tileSize: 256, maxzoom: 15 }
    },
    layers: [
      { id: 'sat', type: 'raster', source: 'sat' },
      { id: 'hs', type: 'hillshade', source: 'demhs', paint: { 'hillshade-exaggeration': .3, 'hillshade-shadow-color': '#000', 'hillshade-highlight-color': '#fff' } },
      { id: 'roads', type: 'raster', source: 'roads', paint: { 'raster-opacity': .85 } },
      { id: 'places', type: 'raster', source: 'places' }
    ]
  }
});

map.addControl(new maplibregl.AttributionControl({ compact: true }), 'top-left');
map.addControl(new maplibregl.NavigationControl({ showZoom: false, visualizePitch: true }), 'top-right');
const foldAttribution = () => { const a = document.querySelector('.maplibregl-ctrl-attrib'); if (a) { a.classList.remove('maplibregl-compact-show'); a.removeAttribute('open'); } };
map.on('load', foldAttribution); setTimeout(foldAttribution, 2000);
map.on('moveend', () => store.set('ftf-view', { c: map.getCenter().toArray(), z: map.getZoom() }));

/* ---------- state ---------- */
let prodState = 'none';
let mode = 'idle', pts = [], vtxMarkers = [], field = null, grid = null, ov = {}, photo = 'none', soilState = 'none';
let tune = Object.assign({}, E.DEFAULT_TUNE, store.get('ftf-tune') || {});
const fc = f => ({ type: 'FeatureCollection', features: f });
const empty = fc([]);
const fieldSig = () => field ? field.map(p => p[0].toFixed(5) + ',' + p[1].toFixed(5)).join(';') : '';

/* ---------- draggable panel ---------- */
const card = $('card'), grab = $('grab'), heads = $('heads');
let sheet = 'full', sheetY = 0, drag = null;
function sheetStops() {
  const H = card.offsetHeight, g = grab.offsetHeight;
  return { full: 0, peek: Math.max(0, H - g - heads.offsetHeight), min: Math.max(0, H - g - 2) };
}
function setSheetY(y) { sheetY = y; card.style.transform = `translateY(${y}px)`; }
function snap(state) { sheet = state; setSheetY(sheetStops()[state]); if (state !== 'full') $('cardBody').scrollTop = 0; }
function dragStart(e) {
  if (e.target.closest('button,input,textarea,select,label,a')) return;
  if (e.button !== undefined && e.button !== 0) return;
  drag = { y0: e.clientY, s0: sheetY, moved: 0, t0: performance.now(), id: e.pointerId };
  card.classList.add('dragging');
  try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) {}
}
function dragMove(e) {
  if (!drag || e.pointerId !== drag.id) return;
  const dy = e.clientY - drag.y0;
  drag.moved = Math.max(drag.moved, Math.abs(dy));
  setSheetY(Math.max(0, Math.min(sheetStops().min, drag.s0 + dy)));
}
function dragEnd(e) {
  if (!drag || e.pointerId !== drag.id) return;
  card.classList.remove('dragging');
  const st = sheetStops(), dy = e.clientY - drag.y0, dt = performance.now() - drag.t0, order = ['full', 'peek', 'min'];
  if (drag.moved < 6) snap(sheet === 'full' ? 'peek' : 'full');
  else if (dt < 300 && Math.abs(dy) > 30) snap(order[Math.max(0, Math.min(2, order.indexOf(sheet) + (dy > 0 ? 1 : -1)))]);
  else snap(Object.entries(st).reduce((a, b) => Math.abs(b[1] - sheetY) < Math.abs(a[1] - sheetY) ? b : a)[0]);
  drag = null;
}
for (const el of [grab, heads]) {
  el.addEventListener('pointerdown', dragStart); el.addEventListener('pointermove', dragMove);
  el.addEventListener('pointerup', dragEnd); el.addEventListener('pointercancel', dragEnd);
}
grab.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); snap(sheet === 'full' ? 'peek' : 'full'); } });
new ResizeObserver(() => { if (!drag) snap(sheet); }).observe(card);
addEventListener('resize', () => snap(sheet));
document.addEventListener('gesturestart', e => e.preventDefault());

function show(m) {
  mode = m;
  for (const [k, id] of [['idle', 'Idle'], ['draw', 'Draw'], ['field', 'Field']]) { $('p' + id).classList.toggle('hide', m !== k); $('h' + id).classList.toggle('hide', m !== k); }
  $('cardBody').scrollTop = 0;
  if (m !== 'field') sheet = 'full';
  snap(sheet);
}
function setTab(t) {
  $('tabView').classList.toggle('on', t === 'view'); $('tabWork').classList.toggle('on', t === 'work');
  $('vView').classList.toggle('hide', t !== 'view'); $('vWork').classList.toggle('hide', t !== 'work');
  $('cardBody').scrollTop = 0;
}
$('tabView').onclick = () => setTab('view');
$('tabWork').onclick = () => setTab('work');

/* ---------- map layers ---------- */
map.on('load', () => {
  map.addSource('field', { type: 'geojson', data: empty });
  map.addSource('mask', { type: 'geojson', data: empty });
  map.addSource('draft', { type: 'geojson', data: empty });
  map.addSource('plan', { type: 'geojson', data: empty });
  map.addLayer({ id: 'mask', type: 'fill', source: 'mask', paint: { 'fill-color': '#000', 'fill-opacity': .45 } });
  map.addLayer({ id: 'field-line', type: 'line', source: 'field', paint: { 'line-color': '#fff', 'line-width': 2.5 } });
  map.addLayer({ id: 'draft-fill', type: 'fill', source: 'draft', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#a4c639', 'fill-opacity': .15 } });
  map.addLayer({ id: 'draft-line', type: 'line', source: 'draft', paint: { 'line-color': '#a4c639', 'line-width': 3 } });
  const round = { 'line-cap': 'round', 'line-join': 'round' };
  map.addLayer({ id: 'plan-case', type: 'line', source: 'plan', filter: ['in', ['get', 'kind'], ['literal', ['old', 'new', 'tile', 'trees']]], layout: round, paint: { 'line-color': '#fff', 'line-width': 7, 'line-opacity': .85 } });
  map.addLayer({ id: 'plan-old', type: 'line', source: 'plan', filter: ['==', ['get', 'kind'], 'old'], layout: round, paint: { 'line-color': '#39d353', 'line-width': 4 } });
  map.addLayer({ id: 'plan-trees', type: 'line', source: 'plan', filter: ['==', ['get', 'kind'], 'trees'], layout: round, paint: { 'line-color': '#b08a52', 'line-width': 4 } });
  map.addLayer({ id: 'plan-new', type: 'line', source: 'plan', filter: ['==', ['get', 'kind'], 'new'], layout: round, paint: { 'line-color': '#2f7bff', 'line-width': 4 } });
  map.addLayer({ id: 'plan-tile', type: 'line', source: 'plan', filter: ['==', ['get', 'kind'], 'tile'], paint: { 'line-color': '#ff8a1e', 'line-width': 4, 'line-dasharray': [1.5, 1.2] } });
  map.addLayer({ id: 'plan-tags', type: 'symbol', source: 'plan', filter: ['has', 'icon'], layout: { 'icon-image': ['get', 'icon'], 'icon-allow-overlap': true, 'icon-ignore-placement': true } });
  map.on('click', 'plan-tags', e => { if (mode === 'field' && e.features[0]) focusItem(e.features[0].properties.id); });
  const f = store.get('ftf-field');
  if (f && f.length >= 3) setField(f, false); else show('idle');
});
const PLAN_LAYERS = ['plan-case', 'plan-old', 'plan-trees', 'plan-new', 'plan-tile', 'plan-tags'];
const vis = (id, on) => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'); };

/* ---------- search & locate ---------- */
$('searchForm').addEventListener('submit', async e => {
  e.preventDefault();
  const q = $('q').value.trim(); if (!q) return;
  $('q').blur();
  const m = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (m) { map.flyTo({ center: [+m[2], +m[1]], zoom: 15 }); return; }
  try {
    const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=' + encodeURIComponent(q));
    const j = await r.json();
    if (j[0]) map.flyTo({ center: [+j[0].lon, +j[0].lat], zoom: 15 }); else { $('q').value = ''; $('q').placeholder = 'Not found. Try a town or lat, lng'; }
  } catch (err) { $('q').value = ''; $('q').placeholder = 'Search unavailable right now'; }
});
$('locate').onclick = () => {
  if (!navigator.geolocation) return;
  $('locate').disabled = true;
  navigator.geolocation.getCurrentPosition(
    p => { $('locate').disabled = false; map.flyTo({ center: [p.coords.longitude, p.coords.latitude], zoom: 16 }); },
    () => { $('locate').disabled = false; $('q').placeholder = 'Location is off. Search instead'; },
    { enableHighAccuracy: true, timeout: 10000 });
};

/* ---------- drawing ---------- */
let lastDrag = 0;
function updateDraft() {
  const feats = [];
  if (pts.length >= 3) feats.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[...pts, pts[0]]] } });
  else if (pts.length === 2) feats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: pts } });
  map.getSource('draft').setData(fc(feats));
  $('drawHint').textContent = pts.length < 3 ? `${pts.length} of at least 3 corners` : `${pts.length} corners, ${polyAcres(pts).toFixed(1)} ac. Drag to adjust, then Finish.`;
  $('finishDraw').disabled = pts.length < 3;
}
function addVtx(p) {
  const el = document.createElement('div'); el.className = 'vtx' + (vtxMarkers.length ? '' : ' first');
  const m = new maplibregl.Marker({ element: el, draggable: true }).setLngLat(p).addTo(map);
  m.on('drag', () => { const i = vtxMarkers.indexOf(m), q = m.getLngLat(); if (i >= 0) { pts[i] = [q.lng, q.lat]; updateDraft(); } });
  m.on('dragend', () => { lastDrag = performance.now(); });
  el.addEventListener('click', e => { e.stopPropagation(); if (performance.now() - lastDrag > 400 && vtxMarkers.indexOf(m) === 0 && pts.length >= 3) finishDraw(); });
  vtxMarkers.push(m);
}
function clearVtx() { vtxMarkers.forEach(m => m.remove()); vtxMarkers = []; }
function startDraw(edit) {
  const keep = edit && field ? field.slice() : [];
  setRain(false); clearAnalysis(); clearVtx();
  map.getSource('field').setData(empty); map.getSource('mask').setData(empty);
  map.setTerrain(null); map.easeTo({ pitch: 0, bearing: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 }, freezeElevation: true });
  pts = keep; pts.forEach(addVtx);
  show('draw'); updateDraft();
}
function finishDraw() { if (pts.length < 3) return; const p = pts.slice(); clearVtx(); pts = []; map.getSource('draft').setData(empty); setField(p, true); }
$('startDraw').onclick = () => startDraw(false);
$('redraw').onclick = () => startDraw(false);
$('editField').onclick = () => startDraw(true);
map.on('click', e => {
  if (mode !== 'draw' || performance.now() - lastDrag < 400) return;
  const p = [e.lngLat.lng, e.lngLat.lat]; pts.push(p); addVtx(p); updateDraft();
});
$('undoPt').onclick = () => { pts.pop(); const m = vtxMarkers.pop(); if (m) m.remove(); updateDraft(); };
$('cancelDraw').onclick = () => { clearVtx(); pts = []; map.getSource('draft').setData(empty); const f = store.get('ftf-field'); if (f && f.length >= 3) setField(f, false); else show('idle'); };
$('finishDraw').onclick = finishDraw;

function polyAcres(poly) {
  const lat0 = poly.reduce((s, p) => s + p[1], 0) / poly.length * Math.PI / 180;
  const kx = 111320 * Math.cos(lat0), ky = 110540; let a = 0;
  for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p[0] * kx * q[1] * ky - q[0] * kx * p[1] * ky; }
  return Math.abs(a / 2) / ACRE;
}

function setField(poly, save) {
  field = poly; if (save) store.set('ftf-field', poly);
  const o = store.get('ftf-ov'); ov = o && o.sig === fieldSig() ? o.ov : {};
  for (const k2 of Object.keys(ov)) if (ov[k2] === 'fill') delete ov[k2];
  const ring = [...poly, poly[0]];
  map.getSource('field').setData(fc([{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] } }]));
  map.getSource('mask').setData(fc([{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]], ring.slice().reverse()] } }]));
  sheet = 'full'; show('field'); setTab('view'); titles();
  apply3D(false);
  requestAnimationFrame(() => frameField(1000));
  analyze(poly);
}
function titles() {
  const ac = polyAcres(field).toFixed(1), name = $('fname').value.trim();
  $('fTitle').textContent = name || ac + ' acre field';
  $('fSub').textContent = (name ? ac + ' ac' : '') + (grid ? (name ? ' · ' : '') + ((grid.mx - grid.mn) * FT).toFixed(1) + ' ft of relief' : name ? '' : 'Reading elevation…');
}
// center the field in the part of the map the panel does not cover
let frameToken = 0;
map.on('movestart', e => { if (e.originalEvent) frameToken++; });      // a touch cancels any pending re-centering
function frameField(dur, tries) {
  if (!field) return;
  const b = field.reduce((a, p) => [Math.min(a[0], p[0]), Math.min(a[1], p[1]), Math.max(a[2], p[0]), Math.max(a[3], p[1])], [180, 90, -180, -90]);
  const top = $('searchForm').getBoundingClientRect().bottom + 14, cardTop = card.getBoundingClientRect().top;
  const padding = { top, bottom: Math.min(innerHeight * .62, innerHeight - cardTop) + 14, left: 18, right: 18 };
  const pitch = $('t3d').checked ? 50 : 0, center = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  // zoom that fits the field in the open area (MapLibre screen px = 2 x 256-px world px at the same zoom)
  const dx = lngToX(b[2], 0) - lngToX(b[0], 0), dy = latToY(b[1], 0) - latToY(b[3], 0);
  const availW = Math.max(120, innerWidth - padding.left - padding.right), availH = Math.max(120, innerHeight - padding.top - padding.bottom);
  const zoom = Math.min(19, Math.log2(Math.min(availW / (2 * dx), availH / (2 * dy)))) - (pitch ? .4 : .08);
  const token = ++frameToken;
  map.easeTo({ center, zoom, pitch, bearing: 0, padding, duration: dur == null ? 700 : dur, freezeElevation: true });
  // with 3D on, the ground height is only known once terrain has loaded; re-aim if the field landed off target
  if ((tries || 0) < 3) map.once('idle', () => {
    if (token !== frameToken || mode !== 'field') return;
    const p = map.project(center), tx = padding.left + availW / 2, ty = padding.top + availH / 2;
    if (Math.hypot(p.x - tx, p.y - ty) > 14 || Math.abs(map.getZoom() - zoom) > .15) frameField(350, (tries || 0) + 1);
  });
}
$('frameBtn').onclick = () => frameField();

/* ---------- mercator helpers ---------- */
const worldPx = z => 256 * Math.pow(2, z);
const lngToX = (lng, z) => (lng + 180) / 360 * worldPx(z);
const latToY = (lat, z) => { const s = Math.sin(lat * Math.PI / 180); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * worldPx(z); };
const xToLng = (x, z) => x / worldPx(z) * 360 - 180;
const yToLat = (y, z) => { const n = Math.PI - 2 * Math.PI * y / worldPx(z); return 180 / Math.PI * Math.atan(Math.sinh(n)); };
function loadImg(url) { return new Promise((res, rej) => { const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => res(im); im.onerror = () => rej(new Error('tile')); im.src = url; }); }
async function mosaic(urlFor, z, x0, y0, w, h) {
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const cx = cv.getContext('2d', { willReadFrequently: true }), jobs = [];
  for (let tx = Math.floor(x0 / 256); tx <= Math.floor((x0 + w - 1) / 256); tx++) for (let ty = Math.floor(y0 / 256); ty <= Math.floor((y0 + h - 1) / 256); ty++)
    jobs.push(loadImg(urlFor(z, tx, ty)).then(im => cx.drawImage(im, tx * 256 - x0, ty * 256 - y0)));
  await Promise.all(jobs);
  return { canvas: cv, data: cx.getImageData(0, 0, w, h).data, w, h };
}

/* ---------- analysis ---------- */
let runId = 0;
async function analyze(poly) {
  clearAnalysis();
  const id = runId;
  setStatus('Reading elevation…');
  let lo = [180, 90], hi = [-180, -90];
  poly.forEach(p => { lo = [Math.min(lo[0], p[0]), Math.min(lo[1], p[1])]; hi = [Math.max(hi[0], p[0]), Math.max(hi[1], p[1])]; });
  const padX = Math.max((hi[0] - lo[0]) * .12, 0.0008), padY = Math.max((hi[1] - lo[1]) * .12, 0.0006);
  lo = [lo[0] - padX, lo[1] - padY]; hi = [hi[0] + padX, hi[1] + padY];
  let z = 15, x0, x1, y0, y1;
  for (; z >= 10; z--) { x0 = Math.floor(lngToX(lo[0], z)); x1 = Math.ceil(lngToX(hi[0], z)); y0 = Math.floor(latToY(hi[1], z)); y1 = Math.ceil(latToY(lo[1], z)); if (Math.max(x1 - x0, y1 - y0) <= 1000) break; }
  const W = x1 - x0, H = y1 - y0, N = W * H;
  let dem;
  try { dem = await mosaic((zz, tx, ty) => DEM_URL.replace('{z}', zz).replace('{x}', tx).replace('{y}', ty), z, x0, y0, W, H); }
  catch (e) { if (id === runId) setStatus('Could not load elevation data. Check your signal, then tap Edit corners and Finish to retry.'); return; }
  if (id !== runId) return;
  setStatus('Tracing water flow…');
  await new Promise(r => setTimeout(r, 30));
  if (id !== runId) return;
  const px = dem.data, elev = new Float32Array(N);
  for (let i = 0; i < N; i++) elev[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
  const cs = 40075016.686 * Math.cos((lo[1] + hi[1]) / 2 * Math.PI / 180) / worldPx(z);
  const pp = poly.map(p => [lngToX(p[0], z) - x0, latToY(p[1], z) - y0]);
  const g = E.analyzeGrid(elev, W, H, cs, pp, (gx, gy) => [xToLng(x0 + gx, z), yToLat(y0 + gy, z)], tune);
  if (!g) { setStatus('That field is too small to analyze. Tap Edit corners to redraw it.'); return; }
  g.z = z; g.x0 = x0; g.y0 = y0; g.fieldAc = polyAcres(poly);
  g.coords = [g.toLL(0, 0), g.toLL(W, 0), g.toLL(W, H), g.toLL(0, H)];
  grid = g;

  $('stats').innerHTML = [
    [((g.mx - g.mn) * FT).toFixed(1) + ' ft', 'Relief'],
    [g.slopePct.toFixed(1) + '%', 'Average slope'],
    [g.pondAc.toFixed(1) + ' ac', 'Ponding area'],
    [(g.mn * FT).toFixed(0) + ' ft', 'Lowest point'],
    [(g.mx * FT).toFixed(0) + ' ft', 'Highest point'],
    [g.outletAc.toFixed(0) + ' ac', 'To main outlet']
  ].map(s => `<div class="stat"><b>${s[0]}</b><span>${s[1]}</span></div>`).join('');
  $('legLo').textContent = (g.mn * FT).toFixed(0) + ' ft'; $('legHi').textContent = (g.mx * FT).toFixed(0) + ' ft';
  $('legBar').style.background = 'linear-gradient(90deg,' + ELEV_RAMP.map(r => `rgb(${r[1]}) ${r[0] * 100}%`).join(',') + ')';
  buildOverlays();
  photo = g.waterways.length ? 'loading' : 'none';
  refreshPlan(); titles(); setStatus('');
  $('pdfBtn').disabled = false; $('kmlBtn').disabled = false;
  if (rainOn) startRain();

  // soil survey (USDA SSURGO): drives the pattern-tile areas and lateral spacing
  soilState = 'loading'; showSoils();
  loadSoils(g, lo, hi).then(soil => {
    if (id !== runId) return;
    soilState = soil ? 'done' : 'failed';
    if (soil) { E.applySoils(g, soil); ov = Object.fromEntries(Object.entries(ov).filter(([k2]) => k2[0] !== 'P')); refreshPlan(); buildSoilOverlay(); }
    showSoils();
    if (soil) loadProd(soil.units).then(() => { if (id !== runId) return; prodState = 'done'; pdfCache = null; buildProdOverlay(); showProd(); showSoils(); });
    else { prodState = 'failed'; showProd(); }
  });

  // aerial photo: used to spot waterways that are already grassed, and as the report's second map
  const k = Math.pow(2, Math.max(0, Math.min(17 - z, Math.floor(Math.log2(2800 / Math.max(W, H))))));
  let img = null;
  try { img = await mosaic((zz, tx, ty) => `${ESRI}World_Imagery/MapServer/tile/${zz}/${ty}/${tx}`, z + Math.log2(k), x0 * k, y0 * k, W * k, H * k); img.k = k; } catch (e) {}
  if (id !== runId) return;
  g.img = img;
  E.checkWaterways(g, img);
  photo = img ? 'done' : 'failed';
  refreshPlan();
}
const SDA = 'https://SDMDataAccess.sc.egov.usda.gov/Tabular/post.rest';
const DRAIN_COLORS = ['#d9b36c', '#d9b36c', '#c9d36a', '#7fc8a9', '#4a90d9', '#2b4fb3'];   // by drainage rank, dry to wet
const drainColor = u => { const r = E.drainRank(u); return r < 0 ? '#9aa39b' : DRAIN_COLORS[r]; };
async function loadSoils(g, lo, hi) {
  try {
    const ring = [[lo[0], lo[1]], [hi[0], lo[1]], [hi[0], hi[1]], [lo[0], hi[1]], [lo[0], lo[1]]].map(p => p[0].toFixed(6) + ' ' + p[1].toFixed(6)).join(',');
    const q = `~DeclareGeometry(@aoi)~\nselect @aoi = geometry::STPolyFromText('polygon((${ring}))', 4326)\n~DeclareIdGeomTable(@p)~\n~GetClippedMapunits(@aoi,polygon,geo,@p)~\n` +
      'select p.id as mukey, p.geom.STAsText() as wkt, m.musym, m.muname, a.drclassdcd, a.hydgrpdcd, a.hydclprs from @p p inner join mapunit m on m.mukey = p.id left join muaggatt a on a.mukey = p.id';
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 25000);
    const r = await fetch(SDA, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'format=JSON%2BCOLUMNNAME&query=' + encodeURIComponent(q), signal: ctl.signal });
    clearTimeout(timer);
    const j = await r.json(), rows = (j && j.Table) || [];
    if (rows.length < 2) return null;
    const col = Object.fromEntries(rows[0].map((n, k2) => [String(n).toLowerCase(), k2])), units = [], byKey = new Map(), polys = [];
    for (const row of rows.slice(1)) {
      const key = String(row[col.mukey]);
      if (!byKey.has(key)) { byKey.set(key, units.length); units.push({ mukey: key, musym: row[col.musym] || '', muname: row[col.muname] || 'Unnamed soil', drain: row[col.drclassdcd] || '', hydgrp: row[col.hydgrpdcd] || '', hydric: parseInt(row[col.hydclprs], 10) || 0 }); }
      for (const rings of E.parseWktPolygons(String(row[col.wkt] || ''))) polys.push({ unit: byKey.get(key), rings: rings.map(rg => rg.map(p => [lngToX(p[0], g.z) - g.x0, latToY(p[1], g.z) - g.y0])) });
    }
    if (!polys.length) return null;
    return { units, cellUnit: E.rasterizeSoils(g.W, g.H, polys) };
  } catch (e) { return null; }
}
// productivity ratings per soil: two separate queries so one failing (e.g. no Illinois PI outside Illinois) does not lose the other
async function sda(q) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 25000);
  try {
    const r = await fetch(SDA, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'format=JSON%2BCOLUMNNAME&query=' + encodeURIComponent(q), signal: ctl.signal });
    const j = await r.json(), rows = (j && j.Table) || [];
    if (rows.length < 2) return [];
    const col = rows[0].map(n => String(n).toLowerCase());
    return rows.slice(1).map(row => Object.fromEntries(col.map((n, k2) => [n, row[k2]])));
  } catch (e) { return []; } finally { clearTimeout(timer); }
}
async function loadProd(units) {
  const keys = units.map(u => "'" + String(u.mukey).replace(/[^0-9]/g, '') + "'").join(',');
  if (!keys) return;
  const comps = `from component c where c.mukey in (${keys}) and c.comppct_r > 0`;
  const [nc, il] = await Promise.all([
    sda(`select c.mukey, c.comppct_r, (select max(ci.interphr) from cointerp ci where ci.cokey = c.cokey and ci.ruledepth = 0 and ci.mrulename like 'NCCPI - National Commodity Crop Productivity Index%') as nccpi ${comps}`),
    sda(`select c.mukey, c.comppct_r, (select max(y.cropprodindex) from cocropyld y where y.cokey = c.cokey) as pi, ` +
        `(select max(y.nonirryield_r) from cocropyld y where y.cokey = c.cokey and y.cropname = 'Corn') as corn, ` +
        `(select max(y.nonirryield_r) from cocropyld y where y.cokey = c.cokey and y.cropname = 'Soybeans') as soy ${comps}`)
  ]);
  // weight each rating by component percent, over the components that have one
  const agg = (rows, key) => {
    const m = new Map();
    for (const r of rows) { const v = parseFloat(r[key]), w = parseFloat(r.comppct_r); if (!isFinite(v) || !isFinite(w) || w <= 0) continue; const k2 = String(r.mukey), o = m.get(k2) || { s: 0, w: 0 }; o.s += v * w; o.w += w; m.set(k2, o); }
    return m;
  };
  const maps = { nccpi: agg(nc, 'nccpi'), pi: agg(il, 'pi'), corn: agg(il, 'corn'), soy: agg(il, 'soy') };
  for (const u of units) for (const k2 of Object.keys(maps)) { const o = maps[k2].get(String(u.mukey)); u[k2] = o && o.w > 0 ? o.s / o.w : null; }
}
const prodKey = () => $('prodMetric').value;
function prodColor(t) {        // red (low) -> yellow -> green (high)
  t = Math.max(0, Math.min(1, t));
  const s = [[0, [200, 50, 40]], [.5, [235, 205, 70]], [1, [40, 150, 60]]];
  for (let k2 = 1; k2 < s.length; k2++) if (t <= s[k2][0]) { const a0 = s[k2 - 1], b0 = s[k2], f = (t - a0[0]) / (b0[0] - a0[0]); return a0[1].map((v, j) => Math.round(v + (b0[1][j] - v) * f)); }
  return s[2][1];
}
function buildProdOverlay() {
  if (!grid || !grid.soil) return;
  const key = prodKey(), P = E.PROD[key], s = grid.soil, W = grid.W;
  const col = s.units.map(u => u[key] == null ? null : prodColor((u[key] - P.lo) / (P.hi - P.lo)));
  const url = makeImage(i => {
    const k2 = s.cellUnit[i]; if (k2 < 0 || !col[k2]) return null;
    const x = i % W, edge = (x + 1 < W && s.cellUnit[i + 1] !== k2) || (i + W < s.cellUnit.length && s.cellUnit[i + W] !== k2);
    return edge ? [20, 30, 20, 230] : [col[k2][0], col[k2][1], col[k2][2], 170];
  });
  if (map.getSource('ov-prod')) map.getSource('ov-prod').updateImage({ url, coordinates: grid.coords });
  else { map.addSource('ov-prod', { type: 'image', url, coordinates: grid.coords }); map.addLayer({ id: 'ov-prod', type: 'raster', source: 'ov-prod', layout: { visibility: $('tProd').checked ? 'visible' : 'none' }, paint: { 'raster-fade-duration': 0, 'raster-resampling': 'nearest' } }, 'mask'); }
}
function showProd() {
  const on = $('tProd').checked, box = $('prodBox');
  box.classList.toggle('hide', !on);
  if (!on) return;
  const msg = t => { $('prodList').innerHTML = `<p class="hint" style="font-size:13px">${t}</p>`; };
  if (soilState === 'failed') return msg('The USDA soil survey did not load, so productivity is not available.');
  if (prodState !== 'done' || !grid || !grid.soil) return msg('Loading productivity ratings…');
  const key = prodKey(), P = E.PROD[key], avg = E.prodAvg(grid, key);
  $('prodLo').textContent = P.fmt(P.lo); $('prodHi').textContent = P.fmt(P.hi);
  if (!avg) return msg(`No ${P.label} ratings for these soils.` + (key === 'pi' ? ' The Illinois PI is only rated for Illinois soils.' : ''));
  const rows = E.soilRows(grid).filter(u => u[key] != null).sort((a0, b0) => b0[key] - a0[key]);
  $('prodList').innerHTML = `<div class="prod-avg"><b>${P.fmt(avg.v)}</b><span>${esc(P.long)}, acre-weighted field average${avg.share < .95 ? ` (${Math.round(avg.share * 100)}% of the field rated)` : ''}</span></div>` +
    rows.map(u => { const c = prodColor((u[key] - P.lo) / (P.hi - P.lo)); return `<div class="soil"><i style="background:rgb(${c})"></i><div><b>${esc(P.fmt(u[key]))}</b> ${esc(u.musym)} ${esc(u.muname)}<small>${u.acres.toFixed(1)} ac (${Math.round(u.acres / grid.fieldAc * 100)}%)</small></div></div>`; }).join('');
}
function buildSoilOverlay() {
  if (!grid || !grid.soil) return;
  const s = grid.soil, rgb = s.units.map(u => { const h = drainColor(u); return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; });
  const W = grid.W, url = makeImage(i => {
    const k2 = s.cellUnit[i]; if (k2 < 0) return null;
    const x = i % W, edge = (x + 1 < W && s.cellUnit[i + 1] !== k2) || (i + W < s.cellUnit.length && s.cellUnit[i + W] !== k2);   // dark line between soils
    return edge ? [20, 30, 20, 230] : [rgb[k2][0], rgb[k2][1], rgb[k2][2], 150];
  });
  if (map.getSource('ov-soil')) map.getSource('ov-soil').updateImage({ url, coordinates: grid.coords });
  else { map.addSource('ov-soil', { type: 'image', url, coordinates: grid.coords }); map.addLayer({ id: 'ov-soil', type: 'raster', source: 'ov-soil', layout: { visibility: $('tSoil').checked ? 'visible' : 'none' }, paint: { 'raster-fade-duration': 0, 'raster-resampling': 'nearest' } }, 'ov-elev'); }
}
function showSoils() {
  const on = $('tSoil').checked, box = $('soilList');
  box.classList.toggle('hide', !on);
  if (!on) return;
  if (soilState !== 'done' || !grid || !grid.soil) { box.innerHTML = `<p class="hint" style="font-size:13px">${soilState === 'loading' ? 'Loading the USDA soil survey…' : soilState === 'failed' ? 'The USDA soil survey did not load. Tile recommendations are using terrain only.' : ''}</p>`; return; }
  box.innerHTML = E.soilRows(grid).map(u => `<div class="soil"><i style="background:${drainColor(u)}"></i><div><b>${esc(u.musym)}</b> ${esc(u.muname)}<small>${u.acres.toFixed(1)} ac (${Math.round(u.acres / grid.fieldAc * 100)}%) · ${esc(u.drain ? u.drain.toLowerCase() : 'no drainage rating')}${u.hydgrp ? ' · group ' + esc(u.hydgrp) : ''}${u.pi != null ? ' · PI ' + Math.round(u.pi) : ''}</small></div></div>`).join('');
}
function setStatus(t) { $('status').textContent = t; $('status').classList.toggle('hide', !t); }

/* ---------- raster overlays ---------- */
function makeImage(fn) {
  const { W, H } = grid, c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d'), im = x.createImageData(W, H);
  for (const i of grid.cells) { const v = fn(i); if (v) im.data.set(v, i * 4); }
  x.putImageData(im, 0, 0); return c.toDataURL();
}
const chanThreshold = () => 300 * Math.pow(1.6, 10 - (+$('chanThr').value));   // m² of drainage area
function chanImage() {
  const thr = chanThreshold(), a2 = grid.cs * grid.cs, lmin = Math.log(thr), lmax = Math.log(thr * 80);
  return makeImage(i => { const ar = grid.A[i] * a2; if (ar < thr) return null; const t = Math.min(1, (Math.log(ar) - lmin) / (lmax - lmin)); return [Math.round(60 + 150 * t), Math.round(170 + 70 * t), 255, Math.round(140 + 115 * t)]; });
}
function buildOverlays() {
  const g = grid, span = Math.max(g.mx - g.mn, 0.3);
  const elevURL = makeImage(i => { const c = rampColor((g.S[i] - g.mn) / span); return [c[0] | 0, c[1] | 0, c[2] | 0, 200]; });
  const pondURL = makeImage(i => { const d = g.P[i]; if (d <= E.POND_M) return null; const t = Math.min(1, d / 0.4); return [20, (90 + 60 * (1 - t)) | 0, 230, (150 + 100 * t) | 0]; });
  const add = (id, url, on, op) => {
    map.addSource(id, { type: 'image', url, coordinates: g.coords });
    map.addLayer({ id, type: 'raster', source: id, layout: { visibility: on ? 'visible' : 'none' }, paint: { 'raster-opacity': op, 'raster-fade-duration': 0, 'raster-resampling': id === 'ov-elev' ? 'linear' : 'nearest' } }, 'mask');
  };
  add('ov-elev', elevURL, $('tElev').checked, .8);
  add('ov-chan', chanImage(), $('tChan').checked, 1);
  add('ov-pond', pondURL, $('tPond').checked, .9);
}
function clearAnalysis() {
  runId++;
  stopRainLoop(); clearRainCanvas();
  ['ov-prod', 'ov-soil', 'ov-wet', 'ov-pond', 'ov-chan', 'ov-elev'].forEach(id => { if (map.getLayer(id)) map.removeLayer(id); if (map.getSource(id)) map.removeSource(id); });
  if (map.getSource('plan')) map.getSource('plan').setData(empty);
  grid = null; R = null; LAT = null; pdfCache = null; photo = 'none'; soilState = 'none'; prodState = 'none';
  $('stats').innerHTML = ''; $('items').innerHTML = ''; $('itemsHint').textContent = ''; $('reportMsg').textContent = '';
  $('tabWork').textContent = 'Dirt work';
  $('pdfBtn').disabled = true; $('kmlBtn').disabled = true;
}

/* ---------- dirt work plan: map layer + item list ---------- */
function tagIcon(text, color) {
  const id = 'tag-' + text + '-' + color;
  if (map.hasImage(id)) return id;
  const s = 2, c = document.createElement('canvas'), x = c.getContext('2d');
  x.font = `bold ${14 * s}px system-ui, sans-serif`;
  const w = Math.ceil(x.measureText(text).width) + 16 * s, h = 26 * s;
  c.width = w; c.height = h;
  x.font = `bold ${14 * s}px system-ui, sans-serif`;
  x.fillStyle = '#fff'; x.beginPath(); x.roundRect ? x.roundRect(0, 0, w, h, 8 * s) : x.rect(0, 0, w, h); x.fill();
  x.fillStyle = color; x.beginPath(); x.roundRect ? x.roundRect(2 * s, 2 * s, w - 4 * s, h - 4 * s, 6 * s) : x.rect(2 * s, 2 * s, w - 4 * s, h - 4 * s); x.fill();
  x.fillStyle = '#fff'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(text, w / 2, h / 2 + s);
  map.addImage(id, x.getImageData(0, 0, w, h), { pixelRatio: s });
  return id;
}
function planFeatures() {
  const g = grid, feats = [];
  const line = (cellsArr, kind, id) => feats.push({ type: 'Feature', properties: { kind, id }, geometry: { type: 'LineString', coordinates: E.chaikin(cellsArr.map(c => E.cellLL(g, c)), 2) } });
  const point = (llp, id, icon) => feats.push({ type: 'Feature', properties: { id, icon }, geometry: { type: 'Point', coordinates: llp } });
  for (const w of g.waterways) {
    if (ov[w.label] !== 'skip' && !E.noWork(E.wwStatus(w, ov[w.label]))) {
      for (const r of E.waterwayRuns(g, w, ov[w.label])) line(r.pts, 'new', w.label);
      point(E.cellLL(g, w.mid), w.label, tagIcon(w.label, '#1658c4'));
    }
    if (E.mainOn(w, ov)) { const id = 'T' + w.label.slice(1); line(w.main, 'tile', id); point(E.cellLL(g, w.quarter), id, tagIcon(id, '#c25a00')); }
  }
  for (const p of g.wet) {
    if (ov[p.label] === 'skip') continue;
    if (p.pts.length > 1) line(p.pts, 'tile', p.label);
    point(p.cenLL, p.label, tagIcon(p.label, '#c25a00'));
  }
  for (const d of g.depressions) {
    if (ov[d.label] === 'skip') continue;
    if (E.lowMethod(d, ov[d.label]) === 'tile' && d.tile.pts.length > 1) line(d.tile.pts, 'tile', d.label);
    point(d.pitLL, d.label, tagIcon(d.label, '#0a3d8f'));
  }
  return feats;
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function refreshPlan() {
  if (!grid) return;
  const g = grid;
  pdfCache = null;
  map.getSource('plan').setData(fc(planFeatures()));
  { // shade the wet-lying ground
    const wetSet = new Set(); for (const p of g.wet) if (ov[p.label] !== 'skip') for (const c of p.members) wetSet.add(c);
    const url = makeImage(i => wetSet.has(i) ? [255, 138, 30, 95] : null);
    if (map.getSource('ov-wet')) map.getSource('ov-wet').updateImage({ url, coordinates: g.coords });
    else { map.addSource('ov-wet', { type: 'image', url, coordinates: g.coords }); map.addLayer({ id: 'ov-wet', type: 'raster', source: 'ov-wet', layout: { visibility: $('tPlan').checked ? 'visible' : 'none' }, paint: { 'raster-fade-duration': 0, 'raster-resampling': 'nearest' } }, 'mask'); }
  }
  const items = E.workItems(g, ov), byId = Object.fromEntries(items.map(i => [i.id, i]));
  const all = [...g.depressions.map(d => ({ id: d.label, type: 'low', o: d })), ...g.wet.map(p => ({ id: p.label, type: 'wet', o: p })),
    ...g.waterways.filter(w => E.wwStatus(w, ov[w.label]) !== 'wooded' && ov[w.label] !== 'skip').map(w => ({ id: 'T' + w.label.slice(1), type: 'main', o: w })),
    ...g.waterways.map(w => ({ id: w.label, type: 'ww', o: w }))];
  const todo = items.filter(i => !i.existing).length;
  $('tabWork').textContent = todo ? `Dirt work (${todo})` : 'Dirt work';
  $('itemsHint').textContent = !all.length ? 'No low spots or flow paths big enough to need dirt work showed up at this data resolution.'
    : photo === 'loading' ? 'Checking the aerial photo for grass and trees along the flow paths…'
    : photo === 'failed' ? 'The aerial photo did not load, so existing waterways could not be checked. Set each one yourself below.'
    : 'Tap Map on an item to see it. Change the choice if you know the ground better than the data does.' + (soilState === 'failed' ? ' The soil survey did not load, so wet ground is judged from terrain only.' : '');
  const isDone = x => !!(byId[x.id] && byId[x.id].existing), card = a => {
    const it = byId[a.id], cur = ov[a.id] || 'auto';
    const opt = (v, t) => `<option value="${v}"${cur === v ? ' selected' : ''}>${esc(t)}</option>`;
    let sel, cls, line;
    if (a.type === 'low') {
      const d = a.o, auto = { tile: 'tile it', drain: 'shape it to drain' }[E.lowMethod(d, null)];
      cls = 'low'; line = `${d.areaAc.toFixed(1)} ac, up to ${d.maxFt.toFixed(1)} ft deep`;
      sel = opt('auto', `Recommended: ${auto}`) + opt('tile', 'Tile it') + opt('drain', 'Shape it to drain') + opt('skip', 'Leave out of the report');
    } else if (a.type === 'wet' || a.type === 'main') {
      cls = 'tile'; line = a.type === 'wet' ? (a.o.unit ? `${a.o.areaAc.toFixed(1)} ac, ${a.o.unit.muname.split(',')[0]}` : `${a.o.areaAc.toFixed(1)} ac of wet-lying ground`) : `along ${a.o.label}, ${a.o.drainAc.toFixed(1)} ac drain toward it`;
      sel = opt('auto', 'Include in the report') + opt('skip', 'Leave out of the report');
    } else {
      const w = a.o, st = w.check.status;
      const auto = photo === 'loading' ? 'checking photo…' : st === 'existing' ? 'grass seen' : st === 'wooded' ? 'trees seen' : st === 'none' ? 'bare, no grass or trees' : 'not checked';
      cls = it && it.status === 'existing' ? 'old' : it && it.status === 'wooded' ? 'wood' : ''; line = `${Math.round(w.lenFt).toLocaleString()} ft, drains ${w.drainAc.toFixed(1)} ac`;
      sel = opt('auto', `Photo check: ${auto}`) + opt('existing', 'Already has a waterway') + opt('wooded', 'Trees or brush: leave alone') + opt('needs', 'Needs a waterway') + opt('skip', 'Leave out of the report');
    }
    return `<div class="item" id="item-${a.id}"><div class="item-h"><span class="tag ${cls}">${a.id}</span>` +
      `<div class="item-t">${(a.type === 'wet' && a.o.unit ? 'Poorly drained soil' : { low: 'Low spot', wet: 'Wet ground', main: 'Tile main', ww: 'Flow path' }[a.type])}<small>${esc(line)}</small></div>` +
      `<button class="btn sm" data-go="${a.id}">Map</button></div>` +
      `<div class="item-r">${it ? esc(it.short) : 'Left out of the report'}</div>` +
      `<select data-ov="${a.id}" aria-label="Choice for ${a.id}">${sel}</select></div>`;
  };
  const work = all.filter(x => !isDone(x)), done = all.filter(isDone);
  $('items').innerHTML = (all.length && !work.length ? '<p class="hint">Nothing here needs dirt work.</p>' : work.map(card).join('')) +
    (done.length ? '<h2>Kicked out: grass or trees seen</h2><p class="hint" style="font-size:13px">Not in the report and not drawn. Change one to "Needs a waterway" to bring it back.</p>' + done.map(card).join('') : '');
}
$('items').addEventListener('change', e => {
  const id = e.target.dataset.ov; if (!id) return;
  if (e.target.value === 'auto') delete ov[id]; else ov[id] = e.target.value;
  store.set('ftf-ov', { sig: fieldSig(), ov });
  refreshPlan();
});
$('items').addEventListener('click', e => { const b = e.target.closest('[data-go]'); if (b) goItem(b.dataset.go); });
function itemLL(id) {
  const d = grid.depressions.find(x => x.label === id); if (d) return d.pitLL;
  const p = grid.wet.find(x => x.label === id); if (p) return p.cenLL;
  if (id[0] === 'T') { const m = grid.waterways.find(x => x.label === 'W' + id.slice(1)); return m ? E.cellLL(grid, m.quarter) : null; }
  const w = grid.waterways.find(x => x.label === id); return w ? E.cellLL(grid, w.mid) : null;
}
function goItem(id) {
  const p = grid && itemLL(id); if (!p) return;
  if (!$('tPlan').checked) { $('tPlan').checked = true; [...PLAN_LAYERS, 'ov-wet'].forEach(l => vis(l, true)); }
  snap('peek');
  const pad = { top: $('searchForm').getBoundingClientRect().bottom + 14, bottom: grab.offsetHeight + heads.offsetHeight + 30, left: 18, right: 18 };
  map.easeTo({ center: p, zoom: Math.max(map.getZoom(), 16), padding: pad, duration: 800, freezeElevation: true });
}
function focusItem(id) {
  setTab('work'); snap('full');
  const el = $('item-' + id); if (!el) return;
  requestAnimationFrame(() => { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1400); });
}

/* sensitivity sliders: how readily flow paths and low spots get flagged */
function showTune() {
  $('sWw').value = tune.ww; $('sLow').value = tune.low;
  $('sWwOut').textContent = E.WW_LEVELS[tune.ww] + ' ac'; $('sLowOut').textContent = (E.LOW_LEVELS[tune.low].d * FT * 12).toFixed(0) + ' in';
}
function setTune() {
  tune = { ww: +$('sWw').value, low: +$('sLow').value }; store.set('ftf-tune', tune); showTune();
  if (!grid) return;
  E.retune(grid, tune);
  ov = {}; store.set('ftf-ov', { sig: fieldSig(), ov });      // item numbers change, so earlier choices no longer line up
  refreshPlan();
}
$('sWw').oninput = showTune2; $('sLow').oninput = showTune2; $('sWw').onchange = setTune; $('sLow').onchange = setTune;
function showTune2() { $('sWwOut').textContent = E.WW_LEVELS[+$('sWw').value] + ' ac'; $('sLowOut').textContent = (E.LOW_LEVELS[+$('sLow').value].d * FT * 12).toFixed(0) + ' in'; }
showTune();

/* ---------- rain: drops follow the downhill direction, drawn over the map ---------- */
const rc = $('rain'), rx = rc.getContext('2d');
let dpr = 1, rainOn = false, rainRAF = 0, R = null, LAT = null, latDirty = true, lastLat = 0;
function sizeRain() { dpr = Math.min(window.devicePixelRatio || 1, 2); rc.width = Math.round(innerWidth * dpr); rc.height = Math.round(innerHeight * dpr); latDirty = true; if (R) R.sx.fill(NaN); }
addEventListener('resize', sizeRain); sizeRain();
function clearRainCanvas() { rx.globalCompositeOperation = 'source-over'; rx.clearRect(0, 0, rc.width, rc.height); }
// project a coarse lattice of grid points to the screen once per map move; drops interpolate between them
function buildLattice() {
  const g = grid, step = Math.max(4, Math.ceil(Math.max(g.W, g.H) / 32)), nx = Math.floor(g.W / step) + 2, ny = Math.floor(g.H / step) + 2;
  const sx = new Float32Array(nx * ny), sy = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const p = map.project(g.toLL(i * step, j * step)); sx[j * nx + i] = p.x * dpr; sy[j * nx + i] = p.y * dpr; }
  LAT = { step, nx, ny, sx, sy }; latDirty = false; lastLat = performance.now();
}
function spawn(k) {
  const g = grid, c = g.cells[(Math.random() * g.cells.length) | 0], x = c % g.W, y = (c - x) / g.W;
  R.fx[k] = x + Math.random(); R.fy[k] = y + Math.random();
  R.ox[k] = (Math.random() - .5) * .8; R.oy[k] = (Math.random() - .5) * .8;
  R.age[k] = 0; R.life[k] = 160 + Math.random() * 300; R.sx[k] = NaN;
}
function initParticles() {
  const n = +$('rainAmt').value;
  R = { n, fx: new Float32Array(n), fy: new Float32Array(n), ox: new Float32Array(n), oy: new Float32Array(n), age: new Float32Array(n), life: new Float32Array(n), sx: new Float32Array(n), sy: new Float32Array(n) };
  for (let k = 0; k < n; k++) { spawn(k); R.age[k] = Math.random() * R.life[k] * .6; }
}
function rainMoved() { latDirty = true; if (R) { R.sx.fill(NaN); clearRainCanvas(); } }
map.on('move', rainMoved);
map.on('idle', () => { latDirty = true; });
function rainFrame() {
  const g = grid; if (!g || !rainOn || !R) return;
  rainRAF = requestAnimationFrame(rainFrame);
  if (document.hidden) return;
  if (latDirty || !LAT || performance.now() - lastLat > 1500) buildLattice();
  rx.globalCompositeOperation = 'destination-out'; rx.fillStyle = 'rgba(0,0,0,0.08)'; rx.fillRect(0, 0, rc.width, rc.height);
  rx.globalCompositeOperation = 'lighter';
  rx.strokeStyle = 'rgba(70,165,255,0.5)'; rx.lineWidth = 2.2 * dpr; rx.lineCap = 'butt';
  const ppc = Math.pow(2, map.getZoom() - g.z + 1);      // screen px per grid cell
  const { W, H, D, GX, GY, P, M } = g, L = LAT, st = L.step, lnx = L.nx;
  rx.beginPath();
  for (let k = 0; k < R.n; k++) {
    let fx = R.fx[k], fy = R.fy[k];
    if (++R.age[k] > R.life[k]) { spawn(k); continue; }
    let budget = -1, steps = 0;
    while (steps++ < 6) {
      const ix = fx | 0, iy = fy | 0;
      if (fx < 0 || fy < 0 || ix >= W || iy >= H) { budget = -2; break; }
      const c = iy * W + ix;
      if (!M[c]) { budget = -2; break; }           // left the field
      const gx0 = Math.min(Math.max(fx - .5, 0), W - 1.001), gy0 = Math.min(Math.max(fy - .5, 0), H - 1.001);
      const bx = gx0 | 0, by = gy0 | 0, tx = gx0 - bx, ty = gy0 - by, j = by * W + bx;
      const gxv = GX[j] * (1 - tx) * (1 - ty) + GX[j + 1] * tx * (1 - ty) + GX[j + W] * (1 - tx) * ty + GX[j + W + 1] * tx * ty;
      const gyv = GY[j] * (1 - tx) * (1 - ty) + GY[j + 1] * tx * (1 - ty) + GY[j + W] * (1 - tx) * ty + GY[j + W + 1] * tx * ty;
      const m = Math.hypot(gxv, gyv), pond = P[c] > E.POND_M;
      if (budget < 0) budget = (pond ? 0.45 : Math.min(6, Math.max(1.4, 1.4 + 160 * m))) / ppc;   // faster on steeper ground, a crawl through ponds
      let dx, dy;
      if (m > 2e-4 && !pond) { dx = -gxv / m; dy = -gyv / m; }
      else {                                   // flat or ponded: follow the drainage network out
        const n = D[c]; if (n < 0) { budget = -2; break; }
        const nx = n % W; dx = nx + .5 + R.ox[k] * .5 - fx; dy = (n - nx) / W + .5 + R.oy[k] * .5 - fy;
        const d = Math.hypot(dx, dy) || 1; dx /= d; dy /= d;
      }
      const stepLen = Math.min(budget, 0.7);
      fx += dx * stepLen + (Math.random() - .5) * .04; fy += dy * stepLen + (Math.random() - .5) * .04;
      budget -= stepLen;
      if (budget <= 1e-6) break;
    }
    if (budget === -2) { spawn(k); continue; }
    R.fx[k] = fx; R.fy[k] = fy;
    const u = fx / st, v = fy / st, li = Math.max(0, Math.min(lnx - 2, u | 0)), lj = Math.max(0, Math.min(L.ny - 2, v | 0)), a = u - li, b = v - lj, o = lj * lnx + li;
    const X = (L.sx[o] * (1 - a) + L.sx[o + 1] * a) * (1 - b) + (L.sx[o + lnx] * (1 - a) + L.sx[o + lnx + 1] * a) * b;
    const Y = (L.sy[o] * (1 - a) + L.sy[o + 1] * a) * (1 - b) + (L.sy[o + lnx] * (1 - a) + L.sy[o + lnx + 1] * a) * b;
    if (R.sx[k] === R.sx[k] && Math.abs(X - R.sx[k]) + Math.abs(Y - R.sy[k]) < 60 * dpr) { rx.moveTo(R.sx[k], R.sy[k]); rx.lineTo(X, Y); }
    R.sx[k] = X; R.sy[k] = Y;
  }
  rx.stroke();
}
function startRain() { if (!grid) return; initParticles(); latDirty = true; clearRainCanvas(); cancelAnimationFrame(rainRAF); rainRAF = requestAnimationFrame(rainFrame); }
function stopRainLoop() { cancelAnimationFrame(rainRAF); rainRAF = 0; }
function setRain(on) {
  rainOn = on; $('tRain').checked = on;
  $('rainWrap').classList.toggle('hide', !on);
  $('rainQuick').classList.toggle('on', on); $('rainQuick').setAttribute('aria-pressed', on);
  if (on) startRain(); else { stopRainLoop(); clearRainCanvas(); }
}

/* ---------- controls ---------- */
function apply3D(tilt) {
  const on = $('t3d').checked;
  $('exWrap').classList.toggle('hide', !on);
  $('q3d').classList.toggle('on', on); $('q3d').setAttribute('aria-pressed', on);
  map.setTerrain(on ? { source: 'dem', exaggeration: +$('ex').value } : null);
  if (tilt !== false && mode === 'field') frameField(600);
  rainMoved();
}
$('t3d').onchange = () => apply3D();
$('q3d').onclick = () => { $('t3d').checked = !$('t3d').checked; apply3D(); };
$('ex').oninput = () => { $('exOut').textContent = $('ex').value + '×'; if ($('t3d').checked) { map.setTerrain({ source: 'dem', exaggeration: +$('ex').value }); rainMoved(); } };
$('tRain').onchange = () => setRain($('tRain').checked);
$('rainQuick').onclick = () => setRain(!rainOn);
$('rainAmt').oninput = () => { $('rainOut').textContent = (+$('rainAmt').value / 1000).toFixed(1) + 'k'; };
$('rainAmt').onchange = () => { if (rainOn) initParticles(); };
$('tPlan').onchange = () => [...PLAN_LAYERS, 'ov-wet'].forEach(l => vis(l, $('tPlan').checked));
$('tChan').onchange = () => { vis('ov-chan', $('tChan').checked); $('chanWrap').classList.toggle('hide', !$('tChan').checked); };
$('chanThr').oninput = () => { $('chanOut').textContent = $('chanThr').value; };
$('chanThr').onchange = () => { if (grid && map.getSource('ov-chan')) map.getSource('ov-chan').updateImage({ url: chanImage(), coordinates: grid.coords }); };
$('tPond').onchange = () => vis('ov-pond', $('tPond').checked);
$('tSoil').onchange = () => { vis('ov-soil', $('tSoil').checked); showSoils(); };
$('tProd').onchange = () => { vis('ov-prod', $('tProd').checked); showProd(); };
$('prodMetric').value = store.get('ftf-prod') || 'pi';
$('prodMetric').onchange = () => { store.set('ftf-prod', prodKey()); buildProdOverlay(); showProd(); };
$('tElev').onchange = () => { vis('ov-elev', $('tElev').checked); $('legend').classList.toggle('hide', !$('tElev').checked); };
$('tRoads').onchange = () => { vis('roads', $('tRoads').checked); vis('places', $('tRoads').checked); };

/* ---------- report ---------- */
let pdfCache = null;
$('fname').value = store.get('ftf-name') || '';
$('fnotes').value = store.get('ftf-notes') || '';
$('fname').oninput = () => { store.set('ftf-name', $('fname').value); pdfCache = null; if (field) titles(); };
$('fnotes').oninput = () => { store.set('ftf-notes', $('fnotes').value); pdfCache = null; };
const reportName = () => $('fname').value.trim() || 'Field';
const fileBase = () => (reportName().replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'field') + '-dirt-work';
function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('could not load ' + src)); document.head.appendChild(s); }); }
async function deliver(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return true; }
    catch (e) { if (e.name === 'AbortError') return true; if (e.name === 'NotAllowedError') return false; }
  }
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return true;
}
async function makePDF() {
  if (pdfCache) return pdfCache;
  if (!window.PDFLib) await loadScript('pdf-lib.min.js');
  const center = [field.reduce((s, p) => s + p[0], 0) / field.length, field.reduce((s, p) => s + p[1], 0) / field.length];
  let logo = null; try { logo = new Uint8Array(await (await fetch('icon-192.png')).arrayBuffer()); } catch (e) {}
  const bytes = await E.buildPDF(grid, { logo, name: reportName(), notes: $('fnotes').value.trim(), ov, aerial: grid.img || null, center,
    date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) });
  pdfCache = { blob: new Blob([bytes], { type: 'application/pdf' }), name: fileBase() + '.pdf' };
  return pdfCache;
}
function reportMsg(t, retry) {
  const m = $('reportMsg'); m.textContent = t;
  if (retry) {
    const b = document.createElement('button'); b.className = 'btn on'; b.style.marginTop = '8px'; b.textContent = 'Open / share report';
    b.onclick = () => deliver(pdfCache.blob, pdfCache.name).then(() => reportMsg(''));
    m.appendChild(document.createElement('br')); m.appendChild(b);
  }
}
$('pdfBtn').onclick = async () => {
  if (!grid) return;
  const btn = $('pdfBtn'); btn.disabled = true; reportMsg(photo === 'loading' ? 'Building report (aerial photo still loading, so it is left out)…' : 'Building report…');
  try { const r = await makePDF(), ok = await deliver(r.blob, r.name); reportMsg(ok ? '' : 'Report ready.', !ok); }
  catch (e) { reportMsg('Could not build the report: ' + e.message); }
  btn.disabled = false;
};
$('kmlBtn').onclick = async () => {
  if (!grid) return;
  const ok = await deliver(new Blob([E.buildKML(grid, reportName(), ov)], { type: 'application/vnd.google-earth.kml+xml' }), fileBase() + '.kml');
  if (!ok) reportMsg('Your browser blocked the share sheet. Tap GPS file again.');
};
// load the PDF library ahead of time so sharing stays inside the tap
map.once('idle', () => setTimeout(() => { if (!window.PDFLib) loadScript('pdf-lib.min.js').catch(() => {}); }, 3000));

/* ---------- install as app ---------- */
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
let deferred = null;
const showInstall = (msg, btn) => { if (standalone || store.get('ftf-noinstall')) return; $('installMsg').textContent = msg; $('installBtn').classList.toggle('hide', !btn); $('install').classList.remove('hide'); };
addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; showInstall('Install AcreFlow on your home screen.', true); });
$('installBtn').onclick = async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice.catch(() => {}); deferred = null; $('install').classList.add('hide'); };
$('installX').onclick = () => { $('install').classList.add('hide'); store.set('ftf-noinstall', 1); };
if (isIOS && !standalone) showInstall('To install: tap Share, then “Add to Home Screen.”', false);
}
