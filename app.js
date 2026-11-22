/* Field Flow app: map, field drawing, overlays, rain, draggable panel, report export. */
{
'use strict';
const $ = id => document.getElementById(id);
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/';
const DEM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const { FT, ACRE, rampColor, ELEV_RAMP } = FieldEngine;

const store = { get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} } };
const saved = store.get('ftf-view');

const map = new maplibregl.Map({
  container: 'map',
  center: saved ? saved.c : [-90.19, 41.30],
  zoom: saved ? saved.z : 13,
  maxPitch: 80,
  attributionControl: { compact: true },
  style: {
    version: 8,
    sources: {
      sat: { type: 'raster', tiles: [ESRI + 'World_Imagery/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, maxzoom: 19, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' },
      roads: { type: 'raster', tiles: [ESRI + 'Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, maxzoom: 19 },
      places: { type: 'raster', tiles: [ESRI + 'Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, maxzoom: 19 },
      dem: { type: 'raster-dem', tiles: [DEM_URL], encoding: 'terrarium', tileSize: 256, maxzoom: 15, attribution: 'Elevation: AWS Terrain Tiles (USGS 3DEP)' },
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
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
map.on('moveend', () => store.set('ftf-view', { c: map.getCenter().toArray(), z: map.getZoom() }));

/* ---------- state ---------- */
let mode = 'idle', pts = [], vtxMarkers = [], field = null, grid = null, outletMarker = null;
const fc = f => ({ type: 'FeatureCollection', features: f });
const empty = fc([]);

/* ---------- draggable panel ---------- */
const card = $('card'), grab = $('grab');
let sheet = 'full', sheetY = 0;
const activePanel = () => [$('pIdle'), $('pDraw'), $('pField')].find(p => !p.classList.contains('hide'));
function sheetStops() {
  const H = card.offsetHeight, g = grab.offsetHeight;
  const head = activePanel() && activePanel().querySelector('.head');
  const peekVis = g + (head ? head.offsetHeight + 12 : 44);
  return { full: 0, peek: Math.max(0, H - peekVis), min: Math.max(0, H - g) };
}
function setSheetY(y) { sheetY = y; card.style.transform = `translateY(${y}px)`; }
function snap(state) { sheet = state; setSheetY(sheetStops()[state]); }
let drag = null;
function dragStart(e) {
  if (e.target.closest('button,input,textarea,label,a')) return;
  if (e.button !== undefined && e.button !== 0) return;
  drag = { y0: e.clientY, s0: sheetY, moved: 0, t0: performance.now(), id: e.pointerId };
  card.classList.add('dragging');
  try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) {}
}
function dragMove(e) {
  if (!drag || e.pointerId !== drag.id) return;
  const st = sheetStops(), dy = e.clientY - drag.y0;
  drag.moved = Math.max(drag.moved, Math.abs(dy));
  setSheetY(Math.max(0, Math.min(st.min, drag.s0 + dy)));
}
function dragEnd(e) {
  if (!drag || e.pointerId !== drag.id) return;
  card.classList.remove('dragging');
  const st = sheetStops(), dy = e.clientY - drag.y0, dt = performance.now() - drag.t0;
  if (drag.moved < 6) snap(sheet === 'full' ? 'peek' : 'full');
  else if (dt < 250 && Math.abs(dy) > 30) {                       // flick
    const order = ['full', 'peek', 'min'], i = order.indexOf(sheet);
    snap(order[Math.max(0, Math.min(2, i + (dy > 0 ? 1 : -1)))]);
  } else {
    const best = Object.entries(st).reduce((a, b) => Math.abs(b[1] - sheetY) < Math.abs(a[1] - sheetY) ? b : a);
    snap(best[0]);
  }
  drag = null;
}
function bindDrag(el) {
  el.addEventListener('pointerdown', dragStart);
  el.addEventListener('pointermove', dragMove);
  el.addEventListener('pointerup', dragEnd);
  el.addEventListener('pointercancel', dragEnd);
}
bindDrag(grab);
document.querySelectorAll('.head').forEach(bindDrag);
grab.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); snap(sheet === 'full' ? 'peek' : 'full'); } });
new ResizeObserver(() => { if (!drag) snap(sheet); }).observe($('cardBody'));
addEventListener('resize', () => snap(sheet));

const show = m => {
  mode = m;
  $('pIdle').classList.toggle('hide', m !== 'idle'); $('pDraw').classList.toggle('hide', m !== 'draw'); $('pField').classList.toggle('hide', m !== 'field');
  $('cardBody').scrollTop = 0;
  requestAnimationFrame(() => snap(m === 'draw' ? 'full' : sheet));
};

map.on('load', () => {
  map.addSource('field', { type: 'geojson', data: empty });
  map.addSource('mask', { type: 'geojson', data: empty });
  map.addSource('draft', { type: 'geojson', data: empty });
  map.addLayer({ id: 'mask', type: 'fill', source: 'mask', paint: { 'fill-color': '#000', 'fill-opacity': .45 } });
  map.addLayer({ id: 'field-line', type: 'line', source: 'field', paint: { 'line-color': '#fff', 'line-width': 2.5 } });
  map.addLayer({ id: 'draft-line', type: 'line', source: 'draft', paint: { 'line-color': '#a4c639', 'line-width': 3, 'line-dasharray': [2, 1] } });
  const f = store.get('ftf-field');
  if (f && f.length >= 3) setField(f, false);
});

/* ---------- search & locate ---------- */
$('searchForm').addEventListener('submit', async e => {
  e.preventDefault();
  const q = $('q').value.trim(); if (!q) return;
  const m = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (m) { map.flyTo({ center: [+m[2], +m[1]], zoom: 15 }); $('q').blur(); return; }
  try {
    const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(q));
    const j = await r.json();
    if (j[0]) map.flyTo({ center: [+j[0].lon, +j[0].lat], zoom: 15 }); else $('q').value = 'Not found: ' + q;
  } catch (err) { $('q').value = 'Search unavailable'; }
  $('q').blur();
});
$('locate').onclick = () => {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(p => map.flyTo({ center: [p.coords.longitude, p.coords.latitude], zoom: 16 }), () => {}, { enableHighAccuracy: true, timeout: 10000 });
};

/* ---------- drawing ---------- */
function updateDraft() {
  const feats = [];
  if (pts.length >= 2) feats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: pts.length >= 3 ? [...pts, pts[0]] : pts } });
  map.getSource('draft').setData(fc(feats));
  $('drawHint').textContent = pts.length + ' point' + (pts.length === 1 ? '' : 's') + (pts.length < 3 ? '. Need at least 3.' : '. Tap Finish when done.');
  $('finishDraw').disabled = pts.length < 3;
}
function clearVtx() { vtxMarkers.forEach(m => m.remove()); vtxMarkers = []; }
$('startDraw').onclick = startDraw;
$('redraw').onclick = startDraw;
function startDraw() {
  setRain(false); clearAnalysis(); clearVtx(); pts = [];
  map.getSource('field').setData(empty); map.getSource('mask').setData(empty);
  map.setTerrain(null); map.easeTo({ pitch: 0, bearing: 0 });
  show('draw'); updateDraft();
}
map.on('click', e => {
  if (mode !== 'draw') return;
  const p = [e.lngLat.lng, e.lngLat.lat]; pts.push(p);
  const el = document.createElement('div'); el.className = 'vtx';
  vtxMarkers.push(new maplibregl.Marker({ element: el }).setLngLat(p).addTo(map));
  updateDraft();
});
$('undoPt').onclick = () => { pts.pop(); const m = vtxMarkers.pop(); if (m) m.remove(); updateDraft(); };
$('cancelDraw').onclick = () => { clearVtx(); pts = []; map.getSource('draft').setData(empty); const f = store.get('ftf-field'); if (f && f.length >= 3) setField(f, false); else show('idle'); };
$('finishDraw').onclick = () => { const p = pts.slice(); clearVtx(); pts = []; map.getSource('draft').setData(empty); setField(p, true); };

function polyAcres(poly) {
  const lat0 = poly.reduce((s, p) => s + p[1], 0) / poly.length * Math.PI / 180;
  const kx = 111320 * Math.cos(lat0), ky = 110540; let a = 0;
  for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p[0] * kx * q[1] * ky - q[0] * kx * p[1] * ky; }
  return Math.abs(a / 2) / ACRE;
}

function setField(poly, save) {
  field = poly; if (save) store.set('ftf-field', poly);
  const ring = [...poly, poly[0]];
  map.getSource('field').setData(fc([{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] } }]));
  map.getSource('mask').setData(fc([{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]], ring.slice().reverse()] } }]));
  sheet = 'full';
  show('field');
  $('fTitle').textContent = polyAcres(poly).toFixed(1) + ' acre field';
  const b = poly.reduce((a, p) => [Math.min(a[0], p[0]), Math.min(a[1], p[1]), Math.max(a[2], p[0]), Math.max(a[3], p[1])], [180, 90, -180, -90]);
  const pad = Math.min(innerWidth, innerHeight) * .1;
  map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: { top: 70 + pad, bottom: Math.min(innerHeight * .5, 380) + pad * .3, left: pad, right: pad }, pitch: $('t3d').checked ? 55 : 0, duration: 1200 });
  apply3D();
  analyze(poly);
}

/* ---------- mercator helpers ---------- */
const worldPx = z => 256 * Math.pow(2, z);
const lngToX = (lng, z) => (lng + 180) / 360 * worldPx(z);
const latToY = (lat, z) => { const s = Math.sin(lat * Math.PI / 180); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * worldPx(z); };
const xToLng = (x, z) => x / worldPx(z) * 360 - 180;
const yToLat = (y, z) => { const n = Math.PI - 2 * Math.PI * y / worldPx(z); return 180 / Math.PI * Math.atan(Math.sinh(n)); };
function loadImg(url) { return new Promise((res, rej) => { const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => res(im); im.onerror = rej; im.src = url; }); }

/* ---------- analysis ---------- */
let runId = 0;
async function analyze(poly) {
  const id = ++runId;
  clearAnalysis();
  setStatus('Reading elevation…');
  let lo = [180, 90], hi = [-180, -90];
  poly.forEach(p => { lo = [Math.min(lo[0], p[0]), Math.min(lo[1], p[1])]; hi = [Math.max(hi[0], p[0]), Math.max(hi[1], p[1])]; });
  const padX = Math.max((hi[0] - lo[0]) * .12, 0.0008), padY = Math.max((hi[1] - lo[1]) * .12, 0.0006);
  lo = [lo[0] - padX, lo[1] - padY]; hi = [hi[0] + padX, hi[1] + padY];
  let z = 15, x0, x1, y0, y1;
  for (; z >= 10; z--) { x0 = Math.floor(lngToX(lo[0], z)); x1 = Math.ceil(lngToX(hi[0], z)); y0 = Math.floor(latToY(hi[1], z)); y1 = Math.ceil(latToY(lo[1], z)); if (Math.max(x1 - x0, y1 - y0) <= 700) break; }
  const W = x1 - x0, H = y1 - y0, N = W * H;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  const jobs = [];
  for (let tx = Math.floor(x0 / 256); tx <= Math.floor((x1 - 1) / 256); tx++) for (let ty = Math.floor(y0 / 256); ty <= Math.floor((y1 - 1) / 256); ty++)
    jobs.push(loadImg(DEM_URL.replace('{z}', z).replace('{x}', tx).replace('{y}', ty)).then(im => cx.drawImage(im, tx * 256 - x0, ty * 256 - y0)));
  try { await Promise.all(jobs); } catch (e) { if (id === runId) setStatus('Could not load elevation data. Check your connection and try again.'); return; }
  if (id !== runId) return;
  setStatus('Tracing water flow…');
  await new Promise(r => setTimeout(r, 30));
  const px = cx.getImageData(0, 0, W, H).data, E = new Float32Array(N);
  for (let i = 0; i < N; i++) E[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
  const latC = (lo[1] + hi[1]) / 2, cs = 40075016.686 * Math.cos(latC * Math.PI / 180) / worldPx(z);
  const pp = poly.map(p => [lngToX(p[0], z) - x0, latToY(p[1], z) - y0]);
  const g = FieldEngine.analyzeGrid(E, W, H, cs, pp, (gx, gy) => [xToLng(x0 + gx, z), yToLat(y0 + gy, z)]);
  if (id !== runId) return;
  if (!g) { setStatus('Field is too small to analyze.'); return; }
  g.z = z; g.x0 = x0; g.y0 = y0; g.fieldAc = polyAcres(poly);
  g.coords = [[xToLng(x0, z), yToLat(y0, z)], [xToLng(x0 + W, z), yToLat(y0, z)], [xToLng(x0 + W, z), yToLat(y0 + H, z)], [xToLng(x0, z), yToLat(y0 + H, z)]];
  grid = g;

  $('stats').innerHTML = [
    [((g.mx - g.mn) * FT).toFixed(1) + ' ft', 'Relief (low to high)'],
    [g.slopePct.toFixed(1) + '%', 'Average slope'],
    [g.pondAc.toFixed(1) + ' ac', 'Ponding area'],
    [(g.mn * FT).toFixed(0) + ' ft', 'Lowest point'],
    [(g.mx * FT).toFixed(0) + ' ft', 'Highest point'],
    [g.outletAc.toFixed(0) + ' ac', 'Drains to main outlet']
  ].map(s => `<div class="stat"><b>${s[0]}</b><span>${s[1]}</span></div>`).join('');
  $('legLo').textContent = (g.mn * FT).toFixed(0) + ' ft'; $('legHi').textContent = (g.mx * FT).toFixed(0) + ' ft';
  $('legBar').style.background = 'linear-gradient(90deg,' + ELEV_RAMP.map(r => `rgb(${r[1]}) ${r[0] * 100}%`).join(',') + ')';

  if (g.outlet >= 0) {
    const ox = g.outlet % W, oy = (g.outlet - ox) / W;
    const el = document.createElement('div'); el.className = 'outlet'; el.textContent = 'Main outlet';
    outletMarker = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat(g.toLL(ox + .5, oy + .5)).addTo(map);
  }
  buildOverlays();
  renderItems();
  setStatus('');
  if (rainOn) startRain();
}
function setStatus(t) { $('status').textContent = t; $('status').classList.toggle('hide', !t); }

/* ---------- overlays ---------- */
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
  const pondURL = makeImage(i => { const d = g.P[i]; if (d <= FieldEngine.POND_M) return null; const t = Math.min(1, d / 0.4); return [20, (90 + 60 * (1 - t)) | 0, 230, (150 + 100 * t) | 0]; });
  const add = (id, url, vis, op) => {
    map.addSource(id, { type: 'image', url, coordinates: g.coords });
    map.addLayer({ id, type: 'raster', source: id, layout: { visibility: vis ? 'visible' : 'none' }, paint: { 'raster-opacity': op, 'raster-fade-duration': 0, 'raster-resampling': id === 'ov-elev' ? 'linear' : 'nearest' } }, 'mask');
  };
  add('ov-elev', elevURL, $('tElev').checked, .8);
  add('ov-chan', chanImage(), $('tChan').checked, 1);
  add('ov-pond', pondURL, $('tPond').checked, .9);
}
function clearAnalysis() {
  stopRainLoop(); clearRainCanvas();
  ['ov-pond', 'ov-chan', 'ov-elev'].forEach(id => { if (map.getLayer(id)) map.removeLayer(id); if (map.getSource(id)) map.removeSource(id); });
  if (outletMarker) { outletMarker.remove(); outletMarker = null; }
  grid = null; R = null;
  $('stats').innerHTML = ''; $('items').innerHTML = ''; $('reportMsg').textContent = '';
  $('pdfBtn').disabled = true; $('kmlBtn').disabled = true;
}

/* ---------- rain: drops follow the drainage network, drawn over the map ---------- */
const rc = $('rain'), rx = rc.getContext('2d');
let dpr = 1, rainOn = false, rainRAF = 0, R = null;
function sizeRain() { dpr = Math.min(window.devicePixelRatio || 1, 2); rc.width = Math.round(innerWidth * dpr); rc.height = Math.round(innerHeight * dpr); if (R) R.sx.fill(NaN); }
addEventListener('resize', sizeRain); sizeRain();
function clearRainCanvas() { rx.globalCompositeOperation = 'source-over'; rx.clearRect(0, 0, rc.width, rc.height); }
function spawn(k) {
  const g = grid, c = g.cells[(Math.random() * g.cells.length) | 0], x = c % g.W, y = (c - x) / g.W;
  R.c[k] = c; R.fx[k] = x + Math.random(); R.fy[k] = y + Math.random();
  R.ox[k] = (Math.random() - .5) * .8; R.oy[k] = (Math.random() - .5) * .8;
  R.age[k] = 0; R.life[k] = 160 + Math.random() * 300; R.sx[k] = NaN;
}
function initParticles() {
  const n = +$('rainAmt').value;
  R = { n, c: new Int32Array(n), fx: new Float32Array(n), fy: new Float32Array(n), ox: new Float32Array(n), oy: new Float32Array(n),
    age: new Float32Array(n), life: new Float32Array(n), sx: new Float32Array(n), sy: new Float32Array(n) };
  for (let k = 0; k < n; k++) { spawn(k); R.age[k] = Math.random() * R.life[k] * .6; }
}
map.on('move', () => { if (R) { R.sx.fill(NaN); clearRainCanvas(); } });
function rainFrame() {
  const g = grid; if (!g || !rainOn || !R) return;
  rx.globalCompositeOperation = 'destination-out'; rx.fillStyle = 'rgba(0,0,0,0.08)'; rx.fillRect(0, 0, rc.width, rc.height);
  rx.globalCompositeOperation = 'lighter';
  rx.strokeStyle = 'rgba(70,165,255,0.5)'; rx.lineWidth = 2.2 * dpr; rx.lineCap = 'butt';
  const ppc = Math.pow(2, map.getZoom() - g.z + 1);      // screen px per grid cell
  const { W, H, D, GX, GY, P, x0, y0, z } = g, world = worldPx(z);
  rx.beginPath();
  for (let k = 0; k < R.n; k++) {
    let fx = R.fx[k], fy = R.fy[k];
    if (++R.age[k] > R.life[k]) { spawn(k); continue; }
    let budget = -1, steps = 0;
    while (steps++ < 6) {
      const ix = fx | 0, iy = fy | 0;
      if (ix < 0 || iy < 0 || ix >= W || iy >= H) { budget = -2; break; }
      const c = iy * W + ix;
      // bilinear downhill direction
      const gx0 = Math.min(Math.max(fx - .5, 0), W - 1.001), gy0 = Math.min(Math.max(fy - .5, 0), H - 1.001);
      const bx = gx0 | 0, by = gy0 | 0, tx = gx0 - bx, ty = gy0 - by, j = by * W + bx;
      const gxv = GX[j] * (1 - tx) * (1 - ty) + GX[j + 1] * tx * (1 - ty) + GX[j + W] * (1 - tx) * ty + GX[j + W + 1] * tx * ty;
      const gyv = GY[j] * (1 - tx) * (1 - ty) + GY[j + 1] * tx * (1 - ty) + GY[j + W] * (1 - tx) * ty + GY[j + W + 1] * tx * ty;
      const m = Math.hypot(gxv, gyv), pond = P[c] > FieldEngine.POND_M;
      if (budget < 0) {   // screen speed from local slope: faster on steeper ground, a crawl through ponds
        const pxSpeed = pond ? 0.45 : Math.min(6, Math.max(1.4, 1.4 + 160 * m));
        budget = pxSpeed / ppc;
      }
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
    const lng = (x0 + fx) / world * 360 - 180, lat = 180 / Math.PI * Math.atan(Math.sinh(Math.PI - 2 * Math.PI * (y0 + fy) / world));
    const p = map.project([lng, lat]), X = p.x * dpr, Y = p.y * dpr;
    if (R.sx[k] === R.sx[k]) { rx.moveTo(R.sx[k], R.sy[k]); rx.lineTo(X, Y); }
    R.sx[k] = X; R.sy[k] = Y;
  }
  rx.stroke();
  rainRAF = requestAnimationFrame(rainFrame);
}
function startRain() { if (!grid) return; initParticles(); clearRainCanvas(); cancelAnimationFrame(rainRAF); rainRAF = requestAnimationFrame(rainFrame); }
function stopRainLoop() { cancelAnimationFrame(rainRAF); rainRAF = 0; }
function setRain(on) {
  rainOn = on; $('tRain').checked = on;
  $('rainWrap').classList.toggle('hide', !on);
  $('rainQuick').classList.toggle('rainon', on); $('rainQuick').setAttribute('aria-pressed', on);
  if (on) startRain(); else { stopRainLoop(); clearRainCanvas(); }
}

/* ---------- controls ---------- */
function apply3D() {
  const on = $('t3d').checked;
  $('exWrap').classList.toggle('hide', !on);
  if (on) { map.setTerrain({ source: 'dem', exaggeration: +$('ex').value }); if (map.getPitch() < 20 && mode === 'field') map.easeTo({ pitch: 55 }); }
  else { map.setTerrain(null); map.easeTo({ pitch: 0 }); }
}
$('t3d').onchange = apply3D;
$('ex').oninput = () => { $('exOut').textContent = $('ex').value + '×'; if ($('t3d').checked) map.setTerrain({ source: 'dem', exaggeration: +$('ex').value }); };
$('tRain').onchange = () => setRain($('tRain').checked);
$('rainQuick').onclick = () => setRain(!rainOn);
$('rainAmt').oninput = () => { $('rainOut').textContent = (+$('rainAmt').value / 1000).toFixed(1) + 'k'; };
$('rainAmt').onchange = () => { if (rainOn) initParticles(); };
const vis = (id, on) => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'); };
$('tChan').onchange = () => { vis('ov-chan', $('tChan').checked); $('chanWrap').classList.toggle('hide', !$('tChan').checked); };
$('chanThr').oninput = () => { $('chanOut').textContent = $('chanThr').value; };
$('chanThr').onchange = () => { if (grid && map.getSource('ov-chan')) map.getSource('ov-chan').updateImage({ url: chanImage(), coordinates: grid.coords }); };
$('tPond').onchange = () => vis('ov-pond', $('tPond').checked);
$('tElev').onchange = () => { vis('ov-elev', $('tElev').checked); $('legend').classList.toggle('hide', !$('tElev').checked); };
$('tRoads').onchange = () => { vis('roads', $('tRoads').checked); vis('places', $('tRoads').checked); };

/* ---------- dirt work report ---------- */
$('fname').value = store.get('ftf-name') || '';
$('fnotes').value = store.get('ftf-notes') || '';
$('fname').oninput = () => { store.set('ftf-name', $('fname').value); pdfCache = null; };
$('fnotes').oninput = () => { store.set('ftf-notes', $('fnotes').value); pdfCache = null; };
let pdfCache = null;
function renderItems() {
  const g = grid, list = FieldEngine.workItems(g);
  $('items').innerHTML = list.map(it => `<li><b>${it.id}</b><span>${it.kind}: ${it.size}</span></li>`).join('');
  $('itemsHint').textContent = list.length ? `${g.depressions.length} low spot${g.depressions.length === 1 ? '' : 's'} and ${g.waterways.length} flow path${g.waterways.length === 1 ? '' : 's'} found.` : 'No low spots or flow paths big enough to need dirt work at this data resolution.';
  $('pdfBtn').disabled = false; $('kmlBtn').disabled = false; pdfCache = null;
}
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
  const ring = field, center = [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length];
  const bytes = await FieldEngine.buildPDF(grid, { name: reportName(), notes: $('fnotes').value.trim(),
    date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }), center });
  pdfCache = { blob: new Blob([bytes], { type: 'application/pdf' }), name: fileBase() + '.pdf' };
  return pdfCache;
}
function reportMsg(t, retry) {
  const m = $('reportMsg'); m.textContent = t;
  if (retry) { const b = document.createElement('button'); b.className = 'btn rainon'; b.style.marginTop = '8px'; b.textContent = 'Open / share report'; b.onclick = () => deliver(pdfCache.blob, pdfCache.name).then(() => reportMsg('')); m.appendChild(document.createElement('br')); m.appendChild(b); }
}
$('pdfBtn').onclick = async () => {
  if (!grid) return;
  const btn = $('pdfBtn'); btn.disabled = true; reportMsg('Building report…');
  try {
    const r = await makePDF();
    const ok = await deliver(r.blob, r.name);
    reportMsg(ok ? '' : 'Report ready.', !ok);
  } catch (e) { reportMsg('Could not build the report: ' + e.message); }
  btn.disabled = false;
};
$('kmlBtn').onclick = async () => {
  if (!grid) return;
  const kml = FieldEngine.buildKML(grid, reportName());
  const ok = await deliver(new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' }), fileBase() + '.kml');
  if (!ok) reportMsg('Your browser blocked the share sheet. Tap GPS file again.');
};
// warm the PDF library once a field is loaded, so sharing stays inside the tap
map.once('idle', () => setTimeout(() => { if (!window.PDFLib) loadScript('pdf-lib.min.js').catch(() => {}); }, 3000));

/* ---------- install as app ---------- */
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
let deferred = null;
const showInstall = (msg, btn) => { if (standalone || store.get('ftf-noinstall')) return; $('installMsg').textContent = msg; $('installBtn').classList.toggle('hide', !btn); $('install').classList.remove('hide'); };
addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; showInstall('Install Field Flow on your home screen.', true); });
$('installBtn').onclick = async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice.catch(() => {}); deferred = null; $('install').classList.add('hide'); };
$('installX').onclick = () => { $('install').classList.add('hide'); store.set('ftf-noinstall', 1); };
if (isIOS && !standalone) showInstall('To install: tap Share, then “Add to Home Screen.”', false);
}
