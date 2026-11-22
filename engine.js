/* AcreFlow engine: terrain analysis, dirt-work items, plan drawing, PDF + KML.
   No map dependency, so it can be tested on its own. */
(function (global) {
'use strict';
const FT = 3.28084, ACRE = 4046.856, CY = 1.30795;
const DX = [-1, 0, 1, -1, 1, -1, 0, 1], DY = [-1, -1, -1, 0, 0, 1, 1, 1];
const DD = [Math.SQRT2, 1, Math.SQRT2, 1, 1, Math.SQRT2, 1, Math.SQRT2];
const POND_M = 0.05;          // water depth that counts as ponding (~2 in)
const WW_LEVELS = [8, 5, 3, 2, 1];            // acres draining to a flow path before it is flagged for a waterway
const LOW_LEVELS = [                           // ponding depth (m), area (ac) and volume (CY) before a low spot is flagged
  { d: 0.08, a: 0.10, v: 20 }, { d: 0.05, a: 0.05, v: 10 }, { d: 0.03, a: 0.03, v: 4 }, { d: 0.02, a: 0.02, v: 2 }];
const DEFAULT_TUNE = { ww: 3, low: 2 };
const KICK_OUT = 0.2;                         // share of a flow path showing grass or trees that drops it from the recommendations
const WET_PCT = [0.04, 0.08, 0.12, 0.18];      // share of the field treated as its wettest-lying ground, by low-spot sensitivity
const ELEV_RAMP = [[0, [38, 120, 170]], [.25, [70, 170, 140]], [.5, [220, 215, 90]], [.75, [230, 140, 50]], [1, [170, 50, 40]]];

function rampColor(t) {
  t = Math.max(0, Math.min(1, t));
  for (let k = 1; k < ELEV_RAMP.length; k++) {
    if (t <= ELEV_RAMP[k][0]) {
      const a = ELEV_RAMP[k - 1], b = ELEV_RAMP[k], f = (t - a[0]) / (b[0] - a[0]);
      return a[1].map((v, j) => v + (b[1][j] - v) * f);
    }
  }
  return ELEV_RAMP[ELEV_RAMP.length - 1][1];
}

/* E: Float32Array elevations (m), W x H grid; cs: cell size (m); poly: field corners in grid coords;
   toLL(gx, gy) -> [lng, lat] for a grid position. */
function analyzeGrid(E, W, H, cs, poly, toLL, tune) {
  const N = W * H;
  // smooth twice (3x3) to soften resampling steps in the source data
  let S = E;
  for (let pass = 0; pass < 2; pass++) {
    const T = new Float32Array(N);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) { const xx = x + dx; if (xx < 0 || xx >= W) continue; s += S[yy * W + xx]; n++; }
      }
      T[y * W + x] = s / n;
    }
    S = T;
  }

  // field mask (scanline fill)
  const M = new Uint8Array(N), cells = [];
  for (let y = 0; y < H; y++) {
    const yc = y + .5, xs = [];
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a[1] > yc) !== (b[1] > yc)) xs.push(a[0] + (yc - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2)
      for (let x = Math.max(0, Math.ceil(xs[k] - .5)); x <= Math.min(W - 1, Math.floor(xs[k + 1] - .5)); x++) { M[y * W + x] = 1; cells.push(y * W + x); }
  }
  if (!cells.length) return null;

  // priority-flood depression fill (with a tiny gradient so flats drain)
  const F = new Float64Array(N), closed = new Uint8Array(N);
  const hIdx = new Int32Array(N), hKey = new Float64Array(N); let hn = 0;
  const push = (i, k) => { let c = hn++; while (c > 0) { const p = (c - 1) >> 1; if (hKey[p] <= k) break; hIdx[c] = hIdx[p]; hKey[c] = hKey[p]; c = p; } hIdx[c] = i; hKey[c] = k; };
  const pop = () => { const top = hIdx[0]; const li = hIdx[--hn], lk = hKey[hn]; let c = 0; for (;;) { let l = 2 * c + 1; if (l >= hn) break; if (l + 1 < hn && hKey[l + 1] < hKey[l]) l++; if (hKey[l] >= lk) break; hIdx[c] = hIdx[l]; hKey[c] = hKey[l]; c = l; } hIdx[c] = li; hKey[c] = lk; return top; };
  const seed = i => { if (!closed[i]) { closed[i] = 1; F[i] = S[i]; push(i, F[i]); } };
  for (let x = 0; x < W; x++) { seed(x); seed((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { seed(y * W); seed(y * W + W - 1); }
  const EPS = 1e-4;
  while (hn > 0) {
    const c = pop(), cx = c % W, cy = (c - cx) / W;
    for (let k = 0; k < 8; k++) {
      const xx = cx + DX[k], yy = cy + DY[k]; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      const n = yy * W + xx; if (closed[n]) continue;
      closed[n] = 1; F[n] = Math.max(S[n], F[c] + EPS); push(n, F[n]);
    }
  }

  // D8 flow direction on the filled surface, then accumulation
  const D = new Int32Array(N).fill(-1), DK = new Int8Array(N).fill(-1);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; let best = 0, bi = -1, bk = -1;
    for (let k = 0; k < 8; k++) {
      const xx = x + DX[k], yy = y + DY[k]; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      const n = yy * W + xx, s = (F[i] - F[n]) / DD[k];
      if (s > best) { best = s; bi = n; bk = k; }
    }
    D[i] = bi; DK[i] = bk;
  }
  const order = new Uint32Array(N); for (let i = 0; i < N; i++) order[i] = i;
  order.sort((a, b) => F[b] - F[a]);
  const A = new Float32Array(N).fill(1);
  for (let k = 0; k < N; k++) { const c = order[k]; if (D[c] >= 0) A[D[c]] += A[c]; }

  // downhill direction field on the filled surface (continuous, so drops don't move in 45-degree steps)
  const GX = new Float32Array(N), GY = new Float32Array(N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, xl = Math.max(0, x - 1), xr = Math.min(W - 1, x + 1), yu = Math.max(0, y - 1), yd = Math.min(H - 1, y + 1);
    GX[i] = (F[y * W + xr] - F[y * W + xl]) / ((xr - xl) * cs); GY[i] = (F[yd * W + x] - F[yu * W + x]) / ((yd - yu) * cs);
  }
  const P = new Float32Array(N);
  let mn = 1e9, mx = -1e9, sum = 0, slopeSum = 0, pond = 0;
  for (const i of cells) {
    const e = S[i]; mn = Math.min(mn, e); mx = Math.max(mx, e); sum += e;
    P[i] = F[i] - S[i]; if (P[i] > POND_M) pond++;
    const x = i % W, y = (i - x) / W;
    const xl = Math.max(0, x - 1), xr = Math.min(W - 1, x + 1), yu = Math.max(0, y - 1), yd = Math.min(H - 1, y + 1);
    const gx = (S[y * W + xr] - S[y * W + xl]) / ((xr - xl) * cs), gy = (S[yd * W + x] - S[yu * W + x]) / ((yd - yu) * cs);
    slopeSum += Math.hypot(gx, gy);
  }
  const cellAc = cs * cs / ACRE;
  let outlet = -1, outA = 0;
  for (const i of cells) if (D[i] < 0 || !M[D[i]]) { if (A[i] > outA) { outA = A[i]; outlet = i; } }

  const g = { W, H, cs, S, F, D, DK, A, P, M, GX, GY, cells, poly, toLL, cellAc, mn, mx, mean: sum / cells.length,
    slopePct: slopeSum / cells.length * 100, pondAc: pond * cellAc, fieldAc: cells.length * cellAc,
    outlet, outletAc: outA * cellAc };
  retune(g, tune);
  return g;
}

const cxy = (g, i) => { const x = i % g.W; return [x + .5, (i - x) / g.W + .5]; };
const ll = (g, i) => { const p = cxy(g, i); return g.toLL(p[0], p[1]); };

function stepLen(g, c) { return (g.DK[c] >= 0 ? DD[g.DK[c]] : 1) * g.cs; }

// (re)build low spots and flow paths at a given sensitivity; keeps any aerial photo already loaded
function retune(g, tune) {
  const t = Object.assign({}, DEFAULT_TUNE, tune || {});
  g.tune = { ww: Math.max(0, Math.min(WW_LEVELS.length - 1, t.ww | 0)), low: Math.max(0, Math.min(LOW_LEVELS.length - 1, t.low | 0)) };
  g.depressions = findDepressions(g, LOW_LEVELS[g.tune.low]);
  g.waterways = findWaterways(g, WW_LEVELS[g.tune.ww]);
  g.depressions.forEach(d => { d.tile = designTile(g, d); });
  g.waterways.forEach(w => { w.tile = designMain(w); });
  g.wet = findWetAreas(g, WET_PCT[g.tune.low]);
  checkWaterways(g, g.img || null);
}

function findDepressions(g, lv) {
  const { W, H, M, P, D, S, cs } = g, lab = new Int32Array(W * H).fill(-1), out = [];
  for (const start of g.cells) {
    if (P[start] <= lv.d || lab[start] >= 0) continue;
    const id = out.length, stack = [start]; lab[start] = id;
    let n = 0, vol = 0, maxP = 0, pit = start, sx = 0, sy = 0;
    const members = [];
    while (stack.length) {
      const c = stack.pop(); n++; vol += P[c]; members.push(c);
      if (P[c] > maxP) { maxP = P[c]; pit = c; }
      const x = c % W, y = (c - x) / W; sx += x; sy += y;
      for (let k = 0; k < 8; k++) {
        const xx = x + DX[k], yy = y + DY[k]; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const m = yy * W + xx; if (M[m] && lab[m] < 0 && P[m] > lv.d) { lab[m] = id; stack.push(m); }
      }
    }
    // surface-drain route: follow the flow path out of the low spot until the water would run free
    let c = pit, prev = pit, len = 0, guard = 0;
    while (D[c] >= 0 && P[c] > 0.015 && guard++ < 5000) { len += stepLen(g, c); prev = c; c = D[c]; }
    out.push({ id, n, members, areaAc: n * g.cellAc, volCY: vol * cs * cs * CY, maxFt: maxP * FT,
      pit, pitLL: ll(g, pit), wsAc: g.A[prev] * g.cellAc, exit: c, exitLL: ll(g, c), drainFt: len * FT, spillElevFt: (S[pit] + maxP) * FT });
  }
  const kept = out.filter(d => d.areaAc >= lv.a && d.volCY >= lv.v).sort((a, b) => b.volCY - a.volCY).slice(0, Math.max(25, Math.round(g.cells.length * g.cellAc / 4)));
  kept.forEach((d, k) => d.label = 'D' + (k + 1));
  return kept;
}

function findWaterways(g, thrAc) {
  const { W, H, M, D, A, S, cells } = g, N = W * H, thr = thrAc / g.cellAc;
  const ch = new Uint8Array(N), up = new Uint8Array(N);
  for (const i of cells) if (A[i] >= thr) ch[i] = 1;
  for (const i of cells) if (ch[i] && D[i] >= 0 && ch[D[i]]) up[D[i]] = 1;
  const heads = cells.filter(i => ch[i] && !up[i]);
  // longest paths first so each main stem is traced whole
  const pathLen = h => { let c = h, L = 0, guard = 0; while (D[c] >= 0 && M[D[c]] && guard++ < 1e5) { L += stepLen(g, c); c = D[c]; } return L; };
  const hl = heads.map(h => [h, pathLen(h)]).sort((a, b) => b[1] - a[1]);
  const seg = new Int32Array(N).fill(-1), segs = [];
  for (const [h] of hl) {
    const sid = segs.length, pts = []; let c = h, joins = -1, len = 0, guard = 0;
    for (;;) {
      if (guard++ > 1e5) break;
      pts.push(c); seg[c] = sid;
      const n = D[c];
      if (n < 0 || !M[n]) break;
      len += stepLen(g, c);
      if (seg[n] >= 0) { pts.push(n); joins = seg[n]; break; }
      c = n;
    }
    segs.push({ pts, joins, len, head: h, exit: c });
  }
  const root = s => { let r = s, guard = 0; while (segs[r].joins >= 0 && guard++ < 1e4) r = segs[r].joins; return r; };
  const sys = new Map();
  segs.forEach((s, k) => { const r = root(k); if (!sys.has(r)) sys.set(r, []); sys.get(r).push(s); });
  const out = [];
  for (const [r, list] of sys) {
    const main = segs[r], exit = main.exit;
    const lenFt = list.reduce((t, s) => t + s.len, 0) * FT;
    if (lenFt < 120) continue;
    const drop = S[main.head] - S[exit];
    out.push({ segs: list, lenFt, mainFt: main.len * FT, drainAc: A[exit] * g.cellAc,
      slopePct: main.len > 0 ? Math.max(0, drop / main.len * 100) : 0, exit, exitLL: ll(g, exit),
      mid: main.pts[Math.floor(main.pts.length / 2)], main: main.pts, quarter: main.pts[Math.floor(main.pts.length / 4)] });
  }
  out.sort((a, b) => b.drainAc - a.drainAc);
  out.forEach((w, k) => w.label = 'W' + (k + 1));
  return out;
}

/* ---------- tile design for low spots ---------- */
const TILE_SIZES = [6, 8, 10, 12, 15, 18, 24];
// full-pipe capacity (cfs) of corrugated plastic tile, Manning's equation
function tileCap(dIn, grade) {
  const d = dIn / 12, n = dIn <= 8 ? 0.015 : dIn <= 12 ? 0.017 : 0.02;
  return 1.486 / n * (Math.PI * d * d / 4) * Math.pow(d / 4, 2 / 3) * Math.sqrt(grade);
}
function designTile(g, d) {
  const { D, M, S } = g, depth0 = 3 / FT, gmin = 0.001;
  const pts = [d.pit], dist = [0]; let c = d.pit, len = 0, guard = 0;
  while (D[c] >= 0 && M[D[c]] && guard++ < 1e5) { len += stepLen(g, c); c = D[c]; pts.push(c); dist.push(len); }
  const fall = S[d.pit] - S[c], natural = len > 0 ? fall / len : 0;
  const grade = Math.max(gmin, natural), inv0 = S[d.pit] - depth0;
  let maxDepth = depth0;
  for (let i = 0; i < pts.length; i++) maxDepth = Math.max(maxDepth, S[pts[i]] - (inv0 - grade * dist[i]));
  const outDepth = S[c] - (inv0 - grade * len);
  // design flow: 1/2 in/day over the whole watershed feeding the inlet, or emptying the pond in 24 h, whichever is more
  const qWs = 0.5 * d.wsAc / 23.8, qPond = d.volCY * 27 / 86400, q = Math.max(qWs, qPond);
  let size = null;
  for (const s of TILE_SIZES) if (tileCap(s, grade) >= q) { size = s; break; }
  return { pts, lenFt: len * FT, gradePct: grade * 100, flat: natural < gmin, maxDepthFt: maxDepth * FT, outDepthFt: outDepth * FT,
    q, basis: qWs >= qPond ? 'ws' : 'pond', size, end: c, endLL: ll(g, c),
    unit: unitAt(g, d.pit), spacing: spacingFor(unitAt(g, d.pit)),
    lateralFt: d.areaAc >= 0.25 ? Math.round(d.areaAc * 43560 / spacingFor(unitAt(g, d.pit)) / 10) * 10 : 0 };
}

/* ---------- soils (USDA SSURGO) ----------
   soil: { units: [{ mukey, musym, muname, drain, hydgrp, hydric }], cellUnit: Int16Array (unit index per grid cell, -1 = none) } */
const DRAIN_RANK = { 'excessively drained': 0, 'somewhat excessively drained': 0, 'well drained': 1, 'moderately well drained': 2, 'somewhat poorly drained': 3, 'poorly drained': 4, 'very poorly drained': 5 };
const drainRank = u => u && u.drain ? (DRAIN_RANK[u.drain.toLowerCase()] != null ? DRAIN_RANK[u.drain.toLowerCase()] : -1) : -1;
// lateral spacing (ft) by hydrologic soil group; dual groups (B/D) use the drained letter
function spacingFor(u) { const h = u && u.hydgrp ? u.hydgrp.charAt(0).toUpperCase() : ''; return h === 'A' ? 120 : h === 'B' ? 90 : h === 'C' ? 70 : h === 'D' ? 50 : 60; }
const soilLabel = u => `${u.muname}${u.musym ? ' (' + u.musym + ')' : ''}`;
const soilTraits = u => [u.drain ? u.drain.toLowerCase() : null, u.hydgrp ? 'hydrologic group ' + u.hydgrp : null].filter(Boolean).join(', ');
function unitAt(g, cell) { const s = g.soil; if (!s) return null; const k = s.cellUnit[cell]; return k >= 0 ? s.units[k] : null; }
/* productivity: per soil unit u.pi (Illinois B811 optimum PI), u.nccpi (0-1), u.corn, u.soy (bu/ac); weighted by acres in the field */
const PROD = {
  pi:    { label: 'Illinois PI', long: 'Illinois productivity index, Bulletin 811 optimum management, adjusted for slope and erosion', lo: 80, hi: 147, fmt: v => Math.round(v) + '' },
  nccpi: { label: 'NCCPI', long: 'National Commodity Crop Productivity Index', lo: 0.2, hi: 1, fmt: v => v.toFixed(2) },
  corn:  { label: 'Corn yield', long: 'Corn yield (Bulletin 811 optimum in Illinois, soil survey rating elsewhere)', lo: 100, hi: 230, fmt: v => Math.round(v) + ' bu' },
  soy:   { label: 'Soybean yield', long: 'Soybean yield (Bulletin 811 optimum in Illinois, soil survey rating elsewhere)', lo: 30, hi: 70, fmt: v => Math.round(v) + ' bu' }
};
// Bulletin 811 rating for a soil map unit: soil number from the map symbol (36B, 86C2, 8107A), slope from the name, erosion from the symbol
const SLOPE_MID = { A: 1, B: 3.5, C: 7.5, D: 12.5, E: 17.5, F: 25, G: 40 };
function b811For(u) {
  if (typeof B811 === 'undefined' || !u) return null;
  const m = String(u.musym || '').trim().toUpperCase().match(/^(\d+)([A-G])?(\d)?/); if (!m) return null;
  let n = +m[1], r = B811[n];
  if (!r && n >= 1000) { n = n % 1000; r = B811[n]; }               // phase prefixes (8107 = Sawmill, occasionally flooded) share the base rating
  if (!r || r[3] == null) return null;
  const head = s => String(s || '').toLowerCase().replace(/[^a-z]+/g, ' ').trim().slice(0, 4);
  if (u.muname && head(u.muname) !== head(r[0])) return null;          // symbol and name must agree, or skip rather than guess
  const sm = String(u.muname || '').match(/(\d+(?:\.\d+)?)\s*to\s*(\d+(?:\.\d+)?)\s*percent/i);
  const mid = sm ? (+sm[1] + +sm[2]) / 2 : (SLOPE_MID[m[2]] || 1);
  const name = String(u.muname || '').toLowerCase();
  const ero = m[3] === '3' || /severely eroded/.test(name) ? 2 : m[3] === '2' || /(moderately )?eroded/.test(name) ? 1 : 0;
  const row = B811_S3.find(s => mid <= s[0]), f = row[1 + (r[4] ? 3 : 0) + ero];
  return { num: n, name: r[0], f, pi: r[3] * f, corn: r[1] != null ? r[1] * f : null, soy: r[2] != null ? r[2] * f : null };
}
function prodAvg(g, key) {
  if (!g.soil) return null; let s = 0, a = 0;
  for (const u of g.soil.units) if (u[key] != null && u.acres > 0) { s += u[key] * u.acres; a += u.acres; }
  return a > 0 ? { v: s / a, share: a / g.fieldAc } : null;
}
const prodLine = u => Object.keys(PROD).filter(k => u[k] != null).map(k => `${PROD[k].label} ${PROD[k].fmt(u[k])}`).join(', ');
function applySoils(g, soil) {
  g.soil = soil || null;
  if (soil) { soil.units.forEach(u => { u.acres = 0; }); for (const i of g.cells) { const k = soil.cellUnit[i]; if (k >= 0) soil.units[k].acres += g.cellAc; } }
  retune(g, g.tune);
}
// rasterize soil polygons (rings in grid coordinates) onto the grid; polys: [{ unit: index, rings: [[[x,y],...],...] }]
function rasterizeSoils(W, H, polys) {
  const out = new Int16Array(W * H).fill(-1);
  for (const p of polys) {
    let y0 = H, y1 = 0; for (const r of p.rings) for (const q of r) { y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]); }
    for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(H - 1, Math.ceil(y1)); y++) {
      const yc = y + .5, xs = [];
      for (const r of p.rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const a = r[i], b = r[j]; if ((a[1] > yc) !== (b[1] > yc)) xs.push(a[0] + (yc - a[1]) / (b[1] - a[1]) * (b[0] - a[0])); }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.max(0, Math.ceil(xs[k] - .5)); x <= Math.min(W - 1, Math.floor(xs[k + 1] - .5)); x++) out[y * W + x] = p.unit;
    }
  }
  return out;
}
// WKT POLYGON / MULTIPOLYGON -> [[ring, ring...], ...] with rings as [[lng, lat], ...]
function parseWktPolygons(wkt) {
  const polys = [], reP = /\(\s*(?:\([^()]+\)\s*,?\s*)+\)/g, reR = /\(([^()]+)\)/g; let m;
  while ((m = reP.exec(wkt))) { const rings = []; let r; reR.lastIndex = 0; while ((r = reR.exec(m[0]))) rings.push(r[1].trim().split(/\s*,\s*/).map(s => s.trim().split(/\s+/).map(Number))); if (rings.length) polys.push(rings); }
  return polys;
}

// a tile main following a flow path, sized as the outlet for the acres that drain to it (3/8 in/day, subsurface)
function designMain(w) {
  const grade = Math.max(0.001, w.slopePct / 100), q = 0.375 * w.drainAc / 23.8;
  let size = null; for (const s of TILE_SIZES) if (tileCap(s, grade) >= q) { size = s; break; }
  return { lenFt: w.mainFt, gradePct: grade * 100, q, size, cap24Ac: tileCap(24, grade) * 23.8 / 0.375 };
}
// the wettest-lying ground in the field by terrain (flat and collecting water), outside the closed low spots
function findWetAreas(g, pct) {
  const { W, H, M, A, GX, GY, D, S, cs, cells } = g, N = W * H;
  const inDep = new Uint8Array(N); for (const d of g.depressions) for (const c of d.members) inDep[c] = 1;
  const tw = new Float32Array(N);
  for (const i of cells) tw[i] = Math.log(A[i] * cs / (Math.hypot(GX[i], GY[i]) + 0.002));
  const r = Math.max(1, Math.round(12 / cs)), sm = new Float32Array(N), vals = [];
  for (const i of cells) {                      // average over ~25 m so thin channels wash out and broad flats stay
    const x = i % W, y = (i - x) / W; let s = 0, n = 0;
    for (let dy = -r; dy <= r; dy++) { const yy = y + dy; if (yy < 0 || yy >= H) continue; for (let dx = -r; dx <= r; dx++) { const xx = x + dx; if (xx < 0 || xx >= W) continue; const j = yy * W + xx; if (M[j]) { s += Math.min(tw[j], 12); n++; } } }
    sm[i] = s / n; vals.push(sm[i]);
  }
  vals.sort((a, b) => a - b);
  const thr = vals[Math.min(vals.length - 1, Math.floor(vals.length * (1 - pct)))], med = vals[vals.length >> 1] || 0, lv = g.tune.low;
  // with the soil survey loaded, wet ground = poorly drained soils (more classes as sensitivity goes up); otherwise terrain alone
  const wet = new Uint8Array(N);
  for (const i of cells) {
    const u = unitAt(g, i), rk = drainRank(u);
    if (!g.soil || rk < 0) wet[i] = !g.soil && sm[i] >= thr ? 1 : 0;
    else wet[i] = rk >= 5 || (rk === 4 && lv >= 1) || (u.hydric >= 50 && lv >= 1) || (rk === 3 && (lv >= 3 || (lv >= 2 && sm[i] >= med))) ? 1 : 0;
  }
  const lab = new Int32Array(N).fill(-1), out = [];
  for (const start of cells) {
    if (lab[start] >= 0 || inDep[start] || !wet[start]) continue;
    const id = out.length, stack = [start], members = []; lab[start] = id; let sx = 0, sy = 0, low = start;
    while (stack.length) {
      const c = stack.pop(); members.push(c); if (A[c] > A[low]) low = c;
      const x = c % W, y = (c - x) / W; sx += x; sy += y;
      for (let k = 0; k < 8; k++) { const xx = x + DX[k], yy = y + DY[k]; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue; const m = yy * W + xx; if (M[m] && lab[m] < 0 && !inDep[m] && wet[m]) { lab[m] = id; stack.push(m); } }
    }
    out.push({ members, low, cx: sx / members.length, cy: sy / members.length, areaAc: members.length * g.cellAc });
  }
  const kept = out.filter(a => a.areaAc >= 0.4).sort((a, b) => b.areaAc - a.areaAc).slice(0, Math.max(8, Math.round(g.cells.length * g.cellAc / 20)));
  kept.forEach((a, k) => {
    a.label = 'P' + (k + 1);
    let best = a.members[0], bd = 1e18;
    for (const c of a.members) { const x = c % W, y = (c - x) / W, d = (x - a.cx) ** 2 + (y - a.cy) ** 2; if (d < bd) { bd = d; best = c; } }
    a.cen = best; a.cenLL = ll(g, best);
    const pts = [a.low]; let c = a.low, len = 0, guard = 0;
    while (D[c] >= 0 && M[D[c]] && guard++ < 1e5) { len += stepLen(g, c); c = D[c]; pts.push(c); }
    const grade = Math.max(0.001, len > 0 ? (S[a.low] - S[c]) / len : 0), q = 0.375 * a.areaAc / 23.8;
    let size = null; for (const s of TILE_SIZES) if (tileCap(s, grade) >= q) { size = s; break; }
    a.pts = pts; a.end = c; a.endLL = ll(g, c); a.lenFt = len * FT; a.gradePct = grade * 100; a.size = size;
    if (g.soil) { const cnt = new Map(); for (const m of a.members) { const k2 = g.soil.cellUnit[m]; if (k2 >= 0) cnt.set(k2, (cnt.get(k2) || 0) + 1); } let bk = -1, bn = 0; for (const [k2, n2] of cnt) if (n2 > bn) { bn = n2; bk = k2; } a.unit = bk >= 0 ? g.soil.units[bk] : null; a.unitShare = a.members.length ? bn / a.members.length : 0; }
    a.spacing = spacingFor(a.unit);
    a.lateralFt = Math.round(a.areaAc * 43560 / a.spacing / 10) * 10;
  });
  return kept;
}

/* ---------- existing grassed waterway check (aerial photo) ----------
   Along each flow path, look across the path for a strip whose color stands apart from the crop ground on both sides.
   img: { data: RGBA bytes, w, h, k: image px per grid cell } or null when the photo could not be loaded. */
function checkWaterways(g, img) {
  if (!img) { g.waterways.forEach(w => { w.check = { status: 'unchecked' }; w.segs.forEach(s => { s.grass = null; }); }); return; }
  const { W, H, M, cs } = g, k = img.k, data = img.data, iw = img.w, ih = img.h;
  const sample = (gx, gy) => {
    if (gx < 0 || gy < 0 || gx >= W || gy >= H || !M[(gy | 0) * W + (gx | 0)]) return null;
    const px = Math.round(gx * k), py = Math.round(gy * k);
    if (px < 1 || py < 1 || px >= iw - 1 || py >= ih - 1) return null;
    let r = 0, gr = 0, b = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const o = ((py + dy) * iw + px + dx) * 4; r += data[o]; gr += data[o + 1]; b += data[o + 2]; }
    return [r / 9, gr / 9, b / 9];
  };
  const mean = (arr, a, b, minN) => {
    let n = 0, r = 0, gr = 0, bl = 0;
    for (let j = a; j <= b; j++) { const c = arr[j]; if (!c) continue; n++; r += c[0]; gr += c[1]; bl += c[2]; }
    return n >= minN ? [r / n, gr / n, bl / n] : null;
  };
  const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  const spread = (arr, a, b, m) => { let n = 0, s = 0; for (let j = a; j <= b; j++) if (arr[j]) { n++; s += dist(arr[j], m); } return n ? s / n : 0; };
  const lum = c => (c[0] + c[1] + c[2]) / 3, exg = c => 2 * c[1] - c[0] - c[2];
  // roughness: spread of raw pixel brightness in a small window (tree canopy is rough; grass and wet soil are smooth)
  const rough = (gx, gy) => {
    const px = Math.round(gx * k), py = Math.round(gy * k); if (px < 3 || py < 3 || px >= iw - 3 || py >= ih - 3) return null;
    let s = 0, s2 = 0;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) { const o = ((py + dy) * iw + px + dx) * 4, l = (data[o] + data[o + 1] + data[o + 2]) / 3; s += l; s2 += l * l; }
    return Math.sqrt(Math.max(0, s2 / 49 - (s / 49) * (s / 49)));
  };
  const stride = Math.max(1, Math.round(8 / cs)), h = Math.max(2, Math.round(15 / cs));
  // what ordinary ground in this field looks like: typical roughness and brightness over a spread of field cells
  const rawLum = (gx, gy) => { const px = Math.round(gx * k), py = Math.round(gy * k); if (px < 0 || py < 0 || px >= iw || py >= ih) return null; const o = (py * iw + px) * 4; return (data[o] + data[o + 1] + data[o + 2]) / 3; };
  const rs = [], ls = [], stepN = Math.max(1, Math.floor(g.cells.length / 1500));
  for (let q = 0; q < g.cells.length; q += stepN) { const p = cxy(g, g.cells[q]), r = rough(p[0], p[1]), l = rawLum(p[0], p[1]); if (r != null && l != null) { rs.push(r); ls.push(l); } }
  rs.sort((a, b) => a - b); ls.sort((a, b) => a - b);
  const medR = rs.length ? rs[rs.length >> 1] : 6, medL = ls.length ? ls[ls.length >> 1] : 120;
  const treeR = Math.max(10, 2.2 * medR);
  // trees judged on their own look (rough canopy, no brighter than the field), so a draw deep inside timber still counts
  const woods = (c, nx, ny) => {
    let hit = 0, n = 0;
    for (let t = -18; t <= 18; t += 6) { const gx = c[0] + nx * t / cs, gy = c[1] + ny * t / cs, r = rough(gx, gy), l = rawLum(gx, gy); if (r == null || l == null) continue; n++; if (r > treeR && l < medL + 8) hit++; }
    return n >= 3 && hit / n >= 0.4;
  };

  for (const w of g.waterways) {
    let total = 0, checked = 0, grass = 0, wood = 0;
    for (const s of w.segs) {
      const n = s.pts.length, flags = [];
      s.grass = new Uint8Array(n);                     // 0 = not checked, 1 = bare, 2 = grassed strip, 3 = trees
      for (let i = 0; i < n; i += stride) {
        const a = cxy(g, s.pts[Math.max(0, i - h)]), b = cxy(g, s.pts[Math.min(n - 1, i + h)]), c = cxy(g, s.pts[i]);
        const tx = b[0] - a[0], ty = b[1] - a[1], L = Math.hypot(tx, ty) || 1, nx = -ty / L, ny = tx / L;
        const tr = [];                                  // 65 samples, 2 m apart, across the path
        for (let j = 0; j <= 64; j++) { const t = (j - 32) * 2 / cs; tr.push(sample(c[0] + nx * t, c[1] + ny * t)); }
        let best = null;
        for (let jc = 22; jc <= 42; jc++) {             // strip center may sit up to 20 m either side of the DEM path
          const C = mean(tr, jc - 2, jc + 2, 3); if (!C) continue;
          const FL = mean(tr, jc - 22, jc - 9, 4), FR = mean(tr, jc + 9, jc + 22, 4);
          if (!FL && !FR) continue;
          const con = Math.min(FL ? dist(C, FL) : Infinity, FR ? dist(C, FR) : Infinity);
          if (!best || con > best.con) best = { con, C, FL, FR, jc };
        }
        let flag = 0;
        if (woods(c, nx, ny)) flag = 3;
        else if (best) {
          const { C, FL, FR, jc } = best;
          const noise = ((FL ? spread(tr, jc - 22, jc - 9, FL) : 0) + (FR ? spread(tr, jc + 9, jc + 22, FR) : 0)) / ((FL ? 1 : 0) + (FR ? 1 : 0));
          const F = FL && FR ? [(FL[0] + FR[0]) / 2, (FL[1] + FR[1]) / 2, (FL[2] + FR[2]) / 2] : (FL || FR);
          const distinct = best.con > Math.max(16, 2.5 * noise);
          const darker = lum(C) < lum(F) - 8;
          const tc = (jc - 32) * 2 / cs, at = t => rough(c[0] + nx * t, c[1] + ny * t);
          const rc = at(tc), rl = FL ? at(tc - 30 / cs) : null, rr = FR ? at(tc + 30 / cs) : null;
          const rf = rl != null && rr != null ? (rl + rr) / 2 : rl != null ? rl : rr;
          const trees = distinct && darker && rc != null && rf != null && rc > Math.max(11, 1.6 * rf);   // dark and rough = tree canopy
          const wetStreak = darker && exg(C) < exg(F) + 6;                                                // dark, smooth, no greener = wet soil
          flag = trees ? 3 : distinct && !wetStreak ? 2 : 1;
        }
        flags.push(flag);
      }
      const per = s.len / Math.max(1, flags.length);
      flags.forEach((f, idx) => {
        let sm = f;
        if (f) { const n3 = [0, 0, 0, 0]; for (let q = idx - 2; q <= idx + 2; q++) if (flags[q]) n3[flags[q]]++; const mx = Math.max(n3[1], n3[2], n3[3]); sm = n3[f] === mx ? f : n3.indexOf(mx, 1); }
        for (let ii = idx * stride; ii < Math.min(n, (idx + 1) * stride); ii++) s.grass[ii] = sm;
        total += per; if (sm) checked += per; if (sm === 2) grass += per; if (sm === 3) wood += per;
      });
    }
    if (total <= 0 || checked / total < 0.4) { w.check = { status: 'unchecked' }; continue; }
    const cover = (grass + wood) / checked, treeShare = wood / checked;       // cover = share that needs no waterway work
    w.check = { status: cover >= KICK_OUT ? (treeShare >= cover / 2 ? 'wooded' : 'existing') : 'none', cover, treeShare,
      grassFt: w.lenFt * grass / checked, treeFt: w.lenFt * treeShare, bareFt: w.lenFt * (1 - cover) };
  }
}

/* owner overrides: waterways 'existing' | 'wooded' | 'needs' | 'skip'; low spots 'tile' | 'drain' (shaping) | 'skip' */
function wwStatus(w, o) { return o === 'existing' || o === 'wooded' ? o : o === 'needs' ? 'none' : (w.check ? w.check.status : 'unchecked'); }
const noWork = st => st === 'existing' || st === 'wooded';
function lowMethod(d, o) {
  if (o === 'tile' || o === 'drain') return o;
  if (d.drainFt <= 150 && d.maxFt <= 0.5) return 'drain';     // shallow, with free drainage close by: shape it
  return 'tile';
}
// cells to draw for a waterway that needs work; paths kicked out for grass or trees draw nothing
function waterwayRuns(g, w, o) {
  if (noWork(wwStatus(w, o))) return [];
  return w.segs.filter(s => s.pts.length > 1).map(s => ({ kind: 'new', pts: s.pts }));
}
// a tile main is offered along every flow path except wooded ones, unless the owner leaves it out
function mainOn(w, ov) { return ov['T' + w.label.slice(1)] !== 'skip' && ov[w.label] !== 'skip' && wwStatus(w, ov[w.label]) !== 'wooded'; }
function chaikin(pts, n) {
  for (let it = 0; it < n; it++) {
    if (pts.length < 3) return pts;
    const o = [pts[0]];
    for (let j = 0; j < pts.length - 1; j++) { const a = pts[j], b = pts[j + 1]; o.push([a[0] * .75 + b[0] * .25, a[1] * .75 + b[1] * .25], [a[0] * .25 + b[0] * .75, a[1] * .25 + b[1] * .75]); }
    o.push(pts[pts.length - 1]); pts = o;
  }
  return pts;
}

/* ---------- plan drawing ---------- */
function marchingSquares(ctx, S, W, x0, y0, x1, y1, level, k) {
  ctx.beginPath();
  for (let y = y0; y < y1 - 1; y++) for (let x = x0; x < x1 - 1; x++) {
    const a = S[y * W + x], b = S[y * W + x + 1], c = S[(y + 1) * W + x + 1], d = S[(y + 1) * W + x];
    const idx = (a > level ? 8 : 0) | (b > level ? 4 : 0) | (c > level ? 2 : 0) | (d > level ? 1 : 0);
    if (idx === 0 || idx === 15) continue;
    const px = (u, v) => [((x - x0) + .5 + u) * k, ((y - y0) + .5 + v) * k];
    const t = (p, q) => (level - p) / (q - p);
    const top = px(t(a, b), 0), right = px(1, t(b, c)), bottom = px(t(d, c), 1), left = px(0, t(a, d));
    const L = (p, q) => { ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); };
    switch (idx) {
      case 1: case 14: L(left, bottom); break;
      case 2: case 13: L(bottom, right); break;
      case 3: case 12: L(left, right); break;
      case 4: case 11: L(top, right); break;
      case 5: L(left, top); L(bottom, right); break;
      case 6: case 9: L(top, bottom); break;
      case 7: case 8: L(left, top); break;
      case 10: L(top, right); L(left, bottom); break;
    }
  }
  ctx.stroke();
}
function contourInterval(reliefFt) { return reliefFt < 3 ? 0.5 : reliefFt < 25 ? 1 : reliefFt < 60 ? 2 : 5; }

/* opt: { ov: overrides, aerial: { canvas, k } } */
function drawPlan(g, maxW, maxH, opt) {
  opt = opt || {};
  const ov = opt.ov || {}, air = opt.aerial || null;
  const { W, M, S, cells } = g;
  let bx0 = W, by0 = 1e9, bx1 = 0, by1 = 0;
  for (const i of cells) { const x = i % W, y = (i - x) / W; bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); by0 = Math.min(by0, y); by1 = Math.max(by1, y); }
  const pad = 4;
  bx0 = Math.max(0, bx0 - pad); by0 = Math.max(0, by0 - pad); bx1 = Math.min(W - 1, bx1 + pad); by1 = Math.min(g.H - 1, by1 + pad);
  const cw = bx1 - bx0 + 1, chh = by1 - by0 + 1, k = Math.min(maxW / cw, maxH / chh);
  const cv = document.createElement('canvas'); cv.width = Math.round(cw * k); cv.height = Math.round(chh * k);
  const ctx = cv.getContext('2d'), U = Math.max(1, cv.width / 1500);     // line-weight unit
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
  const toPx = (gx, gy) => [(gx - bx0) * k, (gy - by0) * k];
  const polyTrace = () => { g.poly.forEach((p, j) => { const q = toPx(p[0], p[1]); j ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); }); ctx.closePath(); };

  if (air) {
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(air.canvas, bx0 * air.k, by0 * air.k, cw * air.k, chh * air.k, 0, 0, cv.width, cv.height);
    ctx.beginPath(); ctx.rect(0, 0, cv.width, cv.height); polyTrace();
    ctx.fillStyle = 'rgba(255,255,255,.5)'; ctx.fill('evenodd');
  } else {
    const small = document.createElement('canvas'); small.width = cw; small.height = chh;
    const sx = small.getContext('2d'), im = sx.createImageData(cw, chh), span = Math.max(g.mx - g.mn, 0.3), z = 4;
    for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) {
      const i = y * W + x, o = ((y - by0) * cw + (x - bx0)) * 4;
      const xl = Math.max(0, x - 1), xr = Math.min(W - 1, x + 1), yu = Math.max(0, y - 1), yd = Math.min(g.H - 1, y + 1);
      const dzdx = (S[y * W + xr] - S[y * W + xl]) / g.cs * z, dzdy = (S[yd * W + x] - S[yu * W + x]) / g.cs * z;
      const shade = Math.max(.55, Math.min(1.15, 1 + (-dzdx - dzdy) * .35));
      let c = rampColor((S[i] - g.mn) / span);
      if (!M[i]) c = c.map(v => 235 - (235 - v) * .15);
      c = c.map(v => v * .55 + 255 * .45);
      im.data[o] = Math.min(255, c[0] * shade); im.data[o + 1] = Math.min(255, c[1] * shade); im.data[o + 2] = Math.min(255, c[2] * shade); im.data[o + 3] = 255;
    }
    sx.putImageData(im, 0, 0);
    ctx.imageSmoothingEnabled = true; ctx.drawImage(small, 0, 0, cv.width, cv.height);
  }

  // contours and ponding, clipped to the field
  const relief = (g.mx - g.mn) * FT, ivFt = contourInterval(relief), iv = ivFt / FT;
  ctx.save(); ctx.beginPath(); polyTrace(); ctx.clip();
  for (let lv = Math.ceil(g.mn / iv) * iv; lv <= g.mx; lv += iv) {
    const major = Math.abs(Math.round(lv * FT / (ivFt * 5)) * ivFt * 5 - lv * FT) < 1e-6;
    ctx.strokeStyle = air ? (major ? 'rgba(255,255,255,.85)' : 'rgba(255,255,255,.4)') : (major ? 'rgba(60,40,20,.75)' : 'rgba(60,40,20,.35)');
    ctx.lineWidth = (major ? 2 : 1) * U;
    marchingSquares(ctx, S, W, bx0, by0, bx1 + 1, by1 + 1, lv, k);
  }
  ctx.fillStyle = 'rgba(240,130,20,.30)';
  for (const a of g.wet || []) { if (ov[a.label] === 'skip') continue; for (const c of a.members) { const x = c % W, y = (c - x) / W; ctx.fillRect((x - bx0) * k, (y - by0) * k, k + .5, k + .5); } }
  ctx.fillStyle = 'rgba(30,110,230,.55)';
  for (const d of g.depressions) { if (ov[d.label] === 'skip') continue; for (const c of d.members) { const x = c % W, y = (c - x) / W; ctx.fillRect((x - bx0) * k, (y - by0) * k, k + .5, k + .5); } }
  ctx.restore();

  const trace = cellsArr => { ctx.beginPath(); chaikin(cellsArr.map(c => { const p = cxy(g, c); return toPx(p[0], p[1]); }), 3).forEach((q, j) => j ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])); };
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  // waterways: green where a grassed strip already shows, blue where one is needed
  const runs = [];
  for (const w of g.waterways) if (ov[w.label] !== 'skip') runs.push(...waterwayRuns(g, w, ov[w.label]));
  for (const r of runs) { trace(r.pts); ctx.strokeStyle = '#fff'; ctx.lineWidth = 9 * U; ctx.stroke(); }
  for (const r of runs) { trace(r.pts); ctx.strokeStyle = r.kind === 'old' ? '#1f8f3a' : r.kind === 'trees' ? '#8a6a3b' : '#1658c4'; ctx.lineWidth = 5 * U; ctx.stroke(); }
  // tile: mains along flow paths, collectors out of wet ground, outlet lines from low spots
  const dash = cellsArr => { trace(cellsArr); ctx.setLineDash([]); ctx.strokeStyle = '#fff'; ctx.lineWidth = 7 * U; ctx.stroke(); trace(cellsArr); ctx.setLineDash([14 * U, 10 * U]); ctx.strokeStyle = '#e06a00'; ctx.lineWidth = 4 * U; ctx.stroke(); ctx.setLineDash([]); };
  for (const w of g.waterways) if (mainOn(w, ov)) dash(w.main);
  for (const a of g.wet || []) if (ov[a.label] !== 'skip' && a.pts.length > 1) dash(a.pts);
  for (const d of g.depressions) {
    if (ov[d.label] === 'skip' || lowMethod(d, ov[d.label]) !== 'tile' || d.tile.pts.length < 2) continue;
    trace(d.tile.pts); ctx.setLineDash([]); ctx.strokeStyle = '#fff'; ctx.lineWidth = 7 * U; ctx.stroke();
    trace(d.tile.pts); ctx.setLineDash([14 * U, 10 * U]); ctx.strokeStyle = '#e06a00'; ctx.lineWidth = 4 * U; ctx.stroke(); ctx.setLineDash([]);
    const e = cxy(g, d.tile.end), q = toPx(e[0], e[1]);
    ctx.fillStyle = '#e06a00'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 * U; ctx.beginPath(); ctx.rect(q[0] - 8 * U, q[1] - 8 * U, 16 * U, 16 * U); ctx.fill(); ctx.stroke();
  }

  ctx.beginPath(); polyTrace(); ctx.strokeStyle = air ? '#fff' : '#111'; ctx.lineWidth = 3 * U; ctx.stroke();

  const tag = (txt, i, fill) => {
    const p = cxy(g, i), q = toPx(p[0], p[1]);
    const fs = Math.max(22, Math.round(cv.width / 42)), hh = fs * 1.4;
    ctx.font = `bold ${fs}px Helvetica, Arial, sans-serif`;
    const w = ctx.measureText(txt).width + fs * .7;
    ctx.fillStyle = fill; ctx.strokeStyle = '#fff'; ctx.lineWidth = 3 * U;
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(q[0] - w / 2, q[1] - hh / 2, w, hh, 8) : ctx.rect(q[0] - w / 2, q[1] - hh / 2, w, hh); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(txt, q[0], q[1] + 1);
  };
  for (const w of g.waterways) {
    if (ov[w.label] === 'skip') continue;
    if (noWork(wwStatus(w, ov[w.label])) && !mainOn(w, ov)) continue;
    const p = cxy(g, w.exit), q = toPx(p[0], p[1]);
    ctx.fillStyle = '#c0392b'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 * U; ctx.beginPath(); ctx.arc(q[0], q[1], 8 * U, 0, 7); ctx.fill(); ctx.stroke();
    const st = wwStatus(w, ov[w.label]);
    if (!noWork(st)) tag(w.label, w.mid, '#1658c4');
  }
  for (const w of g.waterways) if (mainOn(w, ov)) tag('T' + w.label.slice(1), w.quarter, '#c25a00');
  for (const a of g.wet || []) if (ov[a.label] !== 'skip') tag(a.label, a.cen, '#c25a00');
  for (const d of g.depressions) if (ov[d.label] !== 'skip') tag(d.label, d.pit, '#0a3d8f');

  // north arrow, scale bar, photo credit
  const B = Math.max(1, cv.width / 1600);
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.fillRect(cv.width - 64 * B, 10 * B, 54 * B, 70 * B);
  ctx.fillStyle = '#111'; ctx.beginPath(); ctx.moveTo(cv.width - 37 * B, 18 * B); ctx.lineTo(cv.width - 50 * B, 52 * B); ctx.lineTo(cv.width - 37 * B, 45 * B); ctx.lineTo(cv.width - 24 * B, 52 * B); ctx.closePath(); ctx.fill();
  ctx.font = `bold ${18 * B}px Helvetica, Arial, sans-serif`; ctx.textAlign = 'center'; ctx.fillText('N', cv.width - 37 * B, 72 * B);
  const ftPerPx = g.cs * FT / k, target = cv.width * .25 * ftPerPx;
  const nice = [50, 100, 200, 250, 500, 1000, 2000, 2500, 5000].reduce((a, b) => Math.abs(b - target) < Math.abs(a - target) ? b : a);
  const barPx = nice / ftPerPx;
  ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.fillRect(10 * B, cv.height - 52 * B, barPx + 30 * B, 42 * B);
  ctx.fillStyle = '#111'; ctx.fillRect(20 * B, cv.height - 22 * B, barPx, 6 * B);
  ctx.fillStyle = '#fff'; ctx.fillRect(20 * B + barPx / 2, cv.height - 21 * B, barPx / 2 - 1, 4 * B);
  ctx.fillStyle = '#111'; ctx.font = `${16 * B}px Helvetica, Arial, sans-serif`; ctx.textAlign = 'left'; ctx.fillText('0', 18 * B, cv.height - 30 * B);
  ctx.textAlign = 'right'; ctx.fillText(nice.toLocaleString() + ' ft', 20 * B + barPx + 6 * B, cv.height - 30 * B);
  if (air) {
    const t = 'Imagery: Esri, Maxar, Earthstar Geographics'; ctx.font = `${13 * B}px Helvetica, Arial, sans-serif`;
    const tw = ctx.measureText(t).width; ctx.fillStyle = 'rgba(255,255,255,.8)'; ctx.fillRect(cv.width - tw - 16 * B, cv.height - 24 * B, tw + 12 * B, 18 * B);
    ctx.fillStyle = '#111'; ctx.textAlign = 'right'; ctx.fillText(t, cv.width - 10 * B, cv.height - 10 * B);
  }
  return { canvas: cv, contourFt: ivFt };
}

/* ---------- recommendations ---------- */
const f0 = v => Math.round(v).toLocaleString('en-US');
const f1 = v => v.toFixed(1);
const fll = p => p[1].toFixed(6) + ', ' + p[0].toFixed(6);

function tileText(d) {
  const t = d.tile;
  if (t.lenFt < 20) return `Install a surface intake (riser or blind/gravel inlet) at the low point. This low spot sits at the field edge, so the outlet is right there at ${fll(t.endLL)}; it needs somewhere to discharge about ${f1(t.outDepthFt)} ft below ground.`;
  const basis = t.basis === 'ws' ? `1/2 inch per day over the ${f1(d.wsAc)} acres that drain to this low spot` : 'emptying the ponded water within 24 hours';
  let s = `Install a surface intake (riser or blind/gravel inlet) at the low point and run about ${f0(t.lenFt)} ft of `;
  s += t.size ? `${t.size}-inch tile` : 'tile';
  s += ` to the outlet at ${fll(t.endLL)}, where this drainage path leaves the field. Tie into an existing main sooner if one is closer. `;
  s += `Grade about ${t.gradePct.toFixed(2)}%. Trench about 3 ft deep at the intake, up to ${f1(t.maxDepthFt)} ft along the run and ${f1(t.outDepthFt)} ft at the outlet. `;
  s += `Design flow ${t.q.toFixed(2)} cfs (${basis}). `;
  if (!t.size) s += 'That is more than a 24-inch tile carries at this grade: handle the surface water with a waterway or surface drain and size the tile for the ponded water only. ';
  if (t.flat) s += `The ground is nearly flat along this route, so the line is set at the 0.1% minimum grade and ends about ${f1(t.outDepthFt)} ft deep; it needs a ditch or main that deep to empty into. `;
  if (t.basis === 'ws' && d.wsAc > 40) s += 'With this much ground draining to it, most storm water will still cross on the surface, so pair the intake with a waterway. ';
  if (t.lateralFt) s += `Optional: about ${f0(t.lateralFt)} ft of 4-inch laterals at roughly ${t.spacing}-ft spacing across the wet area` + (t.unit ? ` (soil here is ${soilLabel(t.unit)}, ${soilTraits(t.unit)}).` : ' (40 to 80 ft depending on soil).');
  return s.trim();
}
const drainText = d => `Shape the ground so this spot drains on its own: cut a shallow, wide swale about ${f0(d.drainFt)} ft long from the low point (cut up to ${f1(d.maxFt)} ft at the rim) to where water runs free at ${fll(d.exitLL)}. Keep the side slopes flat enough to farm across, spread the cut soil thin on nearby ground, and put the topsoil back.`;

function workItems(g, ov) {
  ov = ov || {};
  const items = [];
  for (const d of g.depressions) {
    if (ov[d.label] === 'skip') continue;
    const m = lowMethod(d, ov[d.label]), t = d.tile;
    const opts = { tile: ['Tile intake and outlet line', tileText(d)], drain: ['Shape it to drain', drainText(d)] };
    const alt = { tile: 'Tile option', drain: 'Shaping option' };
    items.push({
      id: d.label, type: 'low', kind: 'Low spot that ponds water', where: fll(d.pitLL), method: m,
      size: `${f1(d.areaAc)} ac, up to ${f1(d.maxFt)} ft deep; ${f1(d.wsAc)} ac drain to it` + (t.unit ? `; soil: ${soilLabel(t.unit)}, ${soilTraits(t.unit)}` : ''),
      recTitle: opts[m][0], rec: opts[m][1],
      more: ['tile', 'drain'].filter(x => x !== m).map(x => [alt[x], opts[x][1]]),
      short: m === 'tile' ? `Tile: ${t.size ? t.size + '-in' : 'intake'}${t.lenFt >= 20 ? ', ' + f0(t.lenFt) + ' ft to outlet' : ''}` : `Shape to drain: ${f0(d.drainFt)} ft swale`,
      line: `${f1(d.areaAc)} ac, ${f1(d.maxFt)} ft deep`
    });
  }
  for (const a of g.wet || []) {
    if (ov[a.label] === 'skip') continue;
    const u = a.unit, collector = a.lenFt >= 20 ? `a ${a.size ? a.size + '-inch ' : ''}collector that runs about ${f0(a.lenFt)} ft at ${a.gradePct.toFixed(2)}% to the outlet at ${fll(a.endLL)}, where this ground drains off the field, or into a nearer main.` : `an outlet at the field edge beside it (${fll(a.endLL)}).`;
    items.push({ id: a.label, type: 'wet', kind: u ? 'Poorly drained soil' : 'Wet-lying ground', where: fll(a.cenLL),
      size: u ? `${f1(a.areaAc)} ac, ${Math.round(a.unitShare * 100)}% ${soilLabel(u)}: ${soilTraits(u)}${u.hydric ? ', ' + u.hydric + '% hydric' : ''}` : `${f1(a.areaAc)} ac of the flattest, most water-collecting ground in this field`,
      recTitle: 'Pattern tile',
      rec: `Pattern tile this area: about ${f0(a.lateralFt)} ft of 4-inch laterals at roughly ${a.spacing}-ft spacing` + (u ? ` (a typical spacing for hydrologic group ${u.hydgrp || '?'} soils; the contractor sets the final spacing and depth)` : ' (40 to 80 ft depending on soil)') + `, feeding ` + collector +
        ` Collector sized for 3/8 inch per day over ${f1(a.areaAc)} acres. ` + (u ? 'The soil comes from the USDA soil survey, which maps at a coarse scale and does not show tile already in the ground: skip this if the area is already tiled.' : 'This is judged from terrain alone: confirm the ground really stays wet (yield maps, standing water, soil type) and is not already tiled.'),
      more: [], short: `Pattern tile: about ${f0(a.lateralFt)} ft of laterals at ${a.spacing} ft`, line: u ? `${f1(a.areaAc)} ac, ${u.muname}` : `${f1(a.areaAc)} ac` });
  }
  for (const w of g.waterways) {
    if (!mainOn(w, ov)) continue;
    const t = w.tile, id = 'T' + w.label.slice(1);
    items.push({ id, type: 'main', kind: 'Tile main along a flow path', where: 'Outlet at ' + fll(w.exitLL),
      size: `${f0(t.lenFt)} ft along the draw, ${f1(w.drainAc)} ac drain toward it, ${t.gradePct.toFixed(2)}% grade`,
      recTitle: t.size ? `${t.size}-inch tile main` : 'Tile main (24-inch or larger)',
      rec: `This draw is the natural route for a tile main. Run about ${f0(t.lenFt)} ft of ` + (t.size ? `${t.size}-inch tile` : 'tile') + ` up it, set to one side of the channel bottom, to the outlet at ${fll(w.exitLL)}. ` +
        (t.size ? `That size carries 3/8 inch per day from all ${f1(w.drainAc)} acres at this grade, so laterals from wet ground on either side can tie in later. ` : `A 24-inch main carries about ${f0(t.cap24Ac)} acres at this grade; the full ${f1(w.drainAc)} acres needs a larger or second line. `) +
        'Step the size down toward the upper end as the acres served drop. Skip this if a main already runs here.',
      more: [], short: `Tile main: ${t.size ? t.size + '-in, ' : ''}${f0(t.lenFt)} ft`, line: `${f0(t.lenFt)} ft, ${f1(w.drainAc)} ac` });
  }
  for (const w of g.waterways) {
    if (ov[w.label] === 'skip') continue;
    const st = wwStatus(w, ov[w.label]), owner = ['existing', 'needs', 'wooded'].includes(ov[w.label]), c = w.check || {};
    const pct = c.cover != null ? Math.round(c.cover * 100) : null;
    const build = `shape a broad, parabolic channel along this path, seed it and protect it until the stand establishes (NRCS Practice 412). Size the width and depth for the ${f1(w.drainAc)}-acre drainage area with the contractor or the county SWCD/NRCS office. Where the bottom stays wet, add a tile line along one side, offset from the center, so the waterway can be established and mowed.`;
    const treeNote = c.treeFt > 60 && !owner ? ` About ${f0(c.treeFt)} ft of this path runs through trees (brown on the map) and is left alone.` : '';
    const steep = w.slopePct >= 2 ? ' At 2% or more slope this path has a higher gully risk; treat it as a priority.' : '';
    let recTitle, rec, short;
    if (st === 'wooded') {
      recTitle = 'Wooded draw: no waterway recommended';
      rec = (owner ? 'The owner reports trees or brush along this path.' : `The aerial photo shows trees along about ${Math.round(c.treeShare * 100)}% of this path.`) + ' No waterway is recommended here. It is shown for reference only.';
      short = owner ? 'Trees or brush (set by you). No work.' : 'Trees along this path. Not recommended.';
    } else if (st === 'existing') {
      recTitle = 'Already grassed: no work recommended';
      rec = (owner ? 'The owner reports a grassed waterway is already in place on this path.' : `The aerial photo shows a grassed waterway along about ${pct}% of this path.`) + ' It is shown for reference only and is not part of the recommended work.';
      short = owner ? 'Already has a waterway (set by you). No work.' : `Grass or trees on ${pct}% of it. Not recommended.`;
    } else if (st === 'partial') {
      recTitle = 'Extend or repair the existing waterway';
      rec = `The aerial photo shows a grassed strip along about ${pct}% of this path (roughly ${f0(c.grassFt)} ft, green on the map). About ${f0(c.bareFt)} ft shows no grass (blue on the map). On the bare stretches, ` + build + steep + treeNote;
      short = `Partly grassed (${pct}%): extend about ${f0(c.bareFt)} ft`;
    } else {
      recTitle = 'Build a grassed waterway';
      rec = (st === 'unchecked' ? 'The aerial photo could not be checked for this path, so confirm in the field that no waterway exists. ' : owner ? '' : 'No grassed strip shows on the aerial photo along this path. ') +
        build.charAt(0).toUpperCase() + build.slice(1) + steep + ' Check the outlet where it leaves the field for erosion and keep it stable.' + treeNote;
      short = st === 'unchecked' ? 'Needs waterway (photo not checked)' : 'Needs waterway: ' + f0(w.lenFt) + ' ft';
    }
    items.push({ id: w.label, type: 'ww', kind: st === 'existing' ? 'Existing grassed waterway' : st === 'wooded' ? 'Wooded draw' : 'Concentrated flow path', status: st, existing: noWork(st), where: 'Leaves field at ' + fll(w.exitLL),
      size: `${f0(w.lenFt)} ft in field, drains ${f1(w.drainAc)} ac, ${f1(w.slopePct)}% average slope`,
      recTitle, rec, more: [], short, line: `${f0(w.lenFt)} ft, drains ${f1(w.drainAc)} ac` });
  }
  return items;
}

const soilRows = g => g.soil ? g.soil.units.filter(u => u.acres >= 0.05).sort((a, b) => b.acres - a.acres) : [];
function summaryLines(g, ov) {
  ov = ov || {};
  const items = workItems(g, ov), lows = items.filter(i => i.type === 'low'), wws = items.filter(i => i.type === 'ww');
  const dep = id => g.depressions.find(d => d.label === id), way = id => g.waterways.find(w => w.label === id);
  const tiled = lows.filter(i => i.method === 'tile'), drained = lows.filter(i => i.method === 'drain');
  const parts = [];
  if (tiled.length) parts.push(`${tiled.length} to tile (about ${f0(tiled.reduce((t, i) => t + dep(i.id).tile.lenFt, 0))} ft of main)`);
  if (drained.length) parts.push(`${drained.length} to shape so ${drained.length > 1 ? 'they drain' : 'it drains'}`);
  const exist = wws.filter(i => i.existing), need = wws.filter(i => !i.existing);
  const needFt = need.reduce((t, i) => { return t + way(i.id).lenFt; }, 0);
  const mains = items.filter(i => i.type === 'main'), wets = items.filter(i => i.type === 'wet'), tp = [];
  if (mains.length) tp.push(`${mains.length} main${mains.length > 1 ? 's' : ''} along flow paths (about ${f0(mains.reduce((t, i) => t + way('W' + i.id.slice(1)).tile.lenFt, 0))} ft)`);
  if (wets.length) tp.push(`${wets.length} wet area${wets.length > 1 ? 's' : ''} to pattern tile (about ${f0(wets.reduce((t, i) => t + g.wet.find(a => a.label === i.id).lateralFt, 0))} ft of laterals)`);
  const tileLine = tp.join('; ');
  const wp = [];
  if (need.length) wp.push(`${need.length} to build (about ${f0(needFt)} ft)`);
  return [
    ['Field size', f1(g.fieldAc) + ' acres'],
    ['Elevation', `${f0(g.mn * FT)} to ${f0(g.mx * FT)} ft (${f1((g.mx - g.mn) * FT)} ft relief)`],
    ['Average slope', f1(g.slopePct) + '%'],
    ['Ponding area', f1(g.pondAc) + ' acres'],
    ['Low spots', lows.length ? parts.join('; ') : 'None to address'],
    ['Tile', tileLine || 'None recommended'],
    ['Waterways', need.length ? wp.join('; ') : 'None to build'],
    ['Main outlet', `${fll(ll(g, g.outlet))}, drains ${f0(g.outletAc)} ac`],
    ...(g.soil && Object.keys(PROD).some(k => prodAvg(g, k)) ? [['Productivity', Object.keys(PROD).map(k => { const p = prodAvg(g, k); return p ? `${PROD[k].label} ${PROD[k].fmt(p.v)}` : null; }).filter(Boolean).join('; ') + ' (acre-weighted)']] : []),
    ...(g.soil ? [['Soils', soilRows(g).slice(0, 3).map(u => `${u.muname} ${Math.round(u.acres / g.fieldAc * 100)}%`).join('; ') || 'No soil survey data here']] : [])
  ];
}

const NOTES = [
  'Planning-level estimate from USGS 3DEP elevation data (mostly about 10 m / 33 ft resolution). Small rills, existing tile, terraces and grade changes under about 0.5 ft are below what this data can see. Confirm grades with an RTK survey before bidding or moving dirt.',
  'A flow path is dropped from the waterway list when the aerial photo shows grass or trees along it. The photo may be a year or more old and can be fooled by crop color, so confirm on the ground.',
  'Pattern-tile areas (P#) are the poorly drained soils from the USDA soil survey (SSURGO) when it loads, otherwise the flattest, most water-collecting ground by terrain. Tile mains (T#) follow the draws. Lateral spacing is a typical figure by hydrologic soil group (A 120 ft, B 90, C 70, D 50). None of this accounts for tile already in the ground.',
  'Tile sizes use Manning\'s equation for corrugated plastic tile flowing full, with a drainage coefficient of 1/2 inch per day over the watershed feeding each intake. Final size, grade, depth and outlet are the contractor\'s design. Existing tile is not mapped here; locate it first, since tying into a nearby main is often cheaper than a new outlet.',
  'Before draining or reshaping any low spot, check with the county FSA/NRCS office (form AD-1026). Draining a wetland without a determination can cost USDA program eligibility.',
  'Do not divert or concentrate water onto a neighbor\'s land beyond its natural flow. Grassed waterways are often eligible for cost share (for example EQIP); ask the county SWCD/NRCS office.',
  'Call 811 (JULIE in Illinois) before any digging.',
  'Illinois productivity index and Illinois corn and soybean yields: University of Illinois Bulletin 811, Table S2 (optimum management), matched by Illinois soil number and adjusted for slope and erosion with Table S3. Other figures from the USDA soil survey: the NRCS National Commodity Crop Productivity Index (NCCPI), and the survey\'s corn and soybean yield ratings. Field averages are weighted by acres of each soil and are not adjusted for slope, erosion or drainage improvements.',
  'Coordinates are latitude, longitude (WGS84). The KML file from the app loads these items into Google Earth or most GPS and guidance software.'
];

/* ---------- PDF (pdf-lib) ---------- */
async function buildPDF(g, opts) {
  const { PDFDocument, StandardFonts, rgb } = global.PDFLib;
  const ov = opts.ov || {};
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const PW = 612, PH = 792, MG = 40, ink = rgb(.08, .08, .08), mute = rgb(.4, .4, .4);
  const colors = { low: rgb(.04, .24, .56), ww: rgb(.09, .35, .77), existing: rgb(.12, .56, .23) };
  let page, y;
  const newPage = () => { page = doc.addPage([PW, PH]); y = PH - MG; };
  const san = s => String(s).replace(/[^\x20-\x7E]/g, c => ({ '–': '-', '—': '-', '’': "'", '“': '"', '”': '"', '×': 'x' }[c] || ''));
  const wrap = (text, f, size, width) => {
    const words = san(text).split(/\s+/), lines = []; let line = '';
    for (const w of words) { const t = line ? line + ' ' + w : w; if (f.widthOfTextAtSize(t, size) > width && line) { lines.push(line); line = w; } else line = t; }
    if (line) lines.push(line); return lines;
  };
  const text = (t, x, f, size, color, width) => {
    for (const l of wrap(t, f, size, width || PW - MG - x)) { if (y < MG + size + 14) newPage(); page.drawText(l, { x, y: y - size, size, font: f, color: color || ink }); y -= size * 1.32; }
  };
  const labeled = (label, body, x, size) => {       // bold run-in label, then wrapped body
    const lw = bold.widthOfTextAtSize(san(label) + ' ', size), first = wrap(body, font, size, PW - MG - x - lw)[0] || '';
    if (y < MG + size + 14) newPage();
    page.drawText(san(label), { x, y: y - size, size, font: bold, color: ink });
    page.drawText(first, { x: x + lw, y: y - size, size, font, color: ink }); y -= size * 1.32;
    const rest = san(body).slice(first.length).trim(); if (rest) text(rest, x, font, size, ink);
  };
  const name = opts.name || 'Field';
  const picture = async (plan, jpg) => {
    const img = jpg ? await doc.embedJpg(plan.canvas.toDataURL('image/jpeg', .86)) : await doc.embedPng(plan.canvas.toDataURL('image/png'));
    const maxH = y - MG - 44, sc = Math.min((PW - MG * 2) / img.width, maxH / img.height), iw = img.width * sc, ih = img.height * sc, x = MG + (PW - MG * 2 - iw) / 2;
    page.drawImage(img, { x, y: y - ih, width: iw, height: ih });
    page.drawRectangle({ x, y: y - ih, width: iw, height: ih, borderColor: mute, borderWidth: .5 });
    y -= ih + 10;
  };
  const key = 'Blue lines = waterway to build (W#). Orange dashes = tile: mains along flow paths (T#), collectors from wet ground and outlet lines from low spots. Orange shading = wet-lying ground to pattern tile (P#). Dark blue = ponding low spots (D#). Red dots = where flow paths leave the field. Flow paths that already show grass or trees on the aerial photo are left out.';

  // page 1: summary and topo plan
  newPage();
  if (opts.logo) { try { const lg = await doc.embedPng(opts.logo); page.drawImage(lg, { x: PW - MG - 40, y: PH - MG - 40, width: 40, height: 40 }); page.drawText('AcreFlow', { x: PW - MG - 40 - bold.widthOfTextAtSize('AcreFlow', 11) - 8, y: PH - MG - 25, size: 11, font: bold, color: mute }); } catch (err) {} }
  text('Dirt work recommendations', MG, bold, 20, ink, PW - MG * 2 - 120); y -= 2;
  text(`${name}  |  ${opts.date}  |  Field center ${fll(opts.center)}`, MG, font, 10, mute); y -= 10;
  for (const [k, v] of summaryLines(g, ov)) {
    page.drawText(san(k), { x: MG, y: y - 10, size: 10, font: bold, color: ink });
    const ls = wrap(v, font, 10, PW - MG * 2 - 110);
    ls.forEach((l, j) => page.drawText(l, { x: MG + 110, y: y - 10 - j * 13, size: 10, font, color: ink }));
    y -= 13 * ls.length + 2;
  }
  y -= 8;
  const topo = drawPlan(g, 1600, 1500, { ov });
  await picture(topo, false);
  text(`Topo plan: ${topo.contourFt}-ft contours (heavier every ${topo.contourFt * 5} ft); color = elevation, blue low to red high. ${key}`, MG, font, 8.5, mute);

  // page 2: aerial plan
  if (opts.aerial) {
    newPage();
    text('Aerial view', MG, bold, 16, ink); y -= 6;
    await picture(drawPlan(g, 1600, 1500, { ov, aerial: opts.aerial }), true);
    text(`Aerial plan: same items over the most recent aerial photo available; white lines are ${topo.contourFt}-ft contours. ${key}`, MG, font, 8.5, mute);
  }

  // work items
  newPage();
  text('Recommended work', MG, bold, 16, ink); y -= 4;
  const items = workItems(g, ov).filter(i => !i.existing);
  if (!items.length) text('No low spots or flow paths needing dirt work were found at this data resolution.', MG, font, 10.5);
  for (const it of items) {
    if (y < MG + 130) newPage();
    page.drawRectangle({ x: MG, y: y - 18, width: 34, height: 18, color: it.type === 'low' ? colors.low : it.type === 'ww' ? colors.ww : rgb(.76, .35, 0) });
    page.drawText(it.id, { x: MG + 6, y: y - 13.5, size: 11, font: bold, color: rgb(1, 1, 1) });
    page.drawText(san(it.kind), { x: MG + 44, y: y - 13.5, size: 11.5, font: bold, color: ink });
    y -= 24;
    text('Location: ' + it.where, MG + 44, font, 9.5, mute);
    text('Size: ' + it.size, MG + 44, font, 9.5, mute);
    y -= 3;
    text('Recommended: ' + it.recTitle, MG + 44, bold, 10.5, ink);
    text(it.rec, MG + 44, font, 10, ink);
    for (const [label, body] of it.more) { y -= 3; labeled(label + ':', body, MG + 44, 9.5); }
    y -= 12;
  }
  if (g.soil && soilRows(g).length) {
    if (y < MG + 110) newPage();
    text('Soils in this field (USDA soil survey)', MG, bold, 12); y -= 2;
    for (const u of soilRows(g)) { labeled(`${u.musym || '-'}  ${u.muname}:`, `${f1(u.acres)} ac (${Math.round(u.acres / g.fieldAc * 100)}%). ${soilTraits(u) || 'no drainage rating'}${u.hydric ? ', ' + u.hydric + '% hydric' : ''}.${prodLine(u) ? ' ' + prodLine(u) + '.' : ''} Typical lateral spacing ${spacingFor(u)} ft.`, MG, 9.5); y -= 2; }
    y -= 8;
  }
  if (opts.notes) { if (y < MG + 80) newPage(); text('Owner notes', MG, bold, 12); y -= 2; text(opts.notes, MG, font, 10); y -= 8; }
  if (y < MG + 200) newPage();
  y -= 4; text('Notes and assumptions', MG, bold, 12); y -= 2;
  for (const n of NOTES) { text('- ' + n, MG, font, 9, mute); y -= 3; }

  const pages = doc.getPages();
  pages.forEach((p, j) => p.drawText(san(`${name} - dirt work recommendations - page ${j + 1} of ${pages.length} - made with AcreFlow`), { x: MG, y: 20, size: 8, font, color: mute }));
  return await doc.save();
}

/* ---------- KML ---------- */
function buildKML(g, name, ov) {
  ov = ov || {};
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const c = p => p[0].toFixed(7) + ',' + p[1].toFixed(7) + ',0';
  const byId = Object.fromEntries(workItems(g, ov).map(i => [i.id, i]));
  const line = cellsArr => `<LineString><tessellate>1</tessellate><coordinates>${cellsArr.map(i => c(ll(g, i))).join(' ')}</coordinates></LineString>`;
  const ring = [...g.poly, g.poly[0]].map(p => c(g.toLL(p[0], p[1]))).join(' ');
  let pm = `<Placemark><name>${esc(name)} boundary</name><styleUrl>#field</styleUrl><Polygon><outerBoundaryIs><LinearRing><coordinates>${ring}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>\n`;
  for (const d of g.depressions) {
    const it = byId[d.label]; if (!it) continue;
    pm += `<Placemark><name>${d.label} low spot: ${esc(it.recTitle)}</name><description>${esc(it.size + '. ' + it.rec)}</description><styleUrl>#pond</styleUrl><Point><coordinates>${c(d.pitLL)}</coordinates></Point></Placemark>\n`;
    if (it.method === 'tile' && d.tile.pts.length > 1) {
      pm += `<Placemark><name>${d.label} tile route</name><description>${esc(it.rec)}</description><styleUrl>#tile</styleUrl>${line(d.tile.pts)}</Placemark>\n`;
      pm += `<Placemark><name>${d.label} tile outlet</name><styleUrl>#pond</styleUrl><Point><coordinates>${c(d.tile.endLL)}</coordinates></Point></Placemark>\n`;
    }
  }
  for (const a of g.wet || []) { const it = byId[a.label]; if (!it) continue;
    pm += `<Placemark><name>${a.label} wet ground: pattern tile</name><description>${esc(it.size + '. ' + it.rec)}</description><styleUrl>#pond</styleUrl><Point><coordinates>${c(a.cenLL)}</coordinates></Point></Placemark>\n`;
    if (a.pts.length > 1) pm += `<Placemark><name>${a.label} collector route</name><styleUrl>#tile</styleUrl>${line(a.pts)}</Placemark>\n`; }
  for (const w of g.waterways) { const it = byId['T' + w.label.slice(1)]; if (!it) continue;
    pm += `<Placemark><name>${it.id} ${esc(it.recTitle)}</name><description>${esc(it.size + '. ' + it.rec)}</description><styleUrl>#tile</styleUrl>${line(w.main)}</Placemark>\n`; }
  for (const w of g.waterways) {
    const it = byId[w.label]; if (!it || it.existing) continue;
    const runs = waterwayRuns(g, w, ov[w.label]);
    for (const [kind, label, style] of [['old', 'existing grassed waterway (no work)', '#wwold'], ['trees', 'trees along flow path (no work)', '#wwtree'], ['new', 'waterway to build', '#wwnew']]) {
      const rs = runs.filter(r => r.kind === kind); if (!rs.length) continue;
      pm += `<Placemark><name>${w.label} ${label}</name><description>${esc(it.size + '. ' + it.rec)}</description><styleUrl>${style}</styleUrl><MultiGeometry>${rs.map(r => line(r.pts)).join('')}</MultiGeometry></Placemark>\n`;
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${esc(name)} dirt work</name>
<Style id="field"><LineStyle><color>ffffffff</color><width>3</width></LineStyle><PolyStyle><fill>0</fill></PolyStyle></Style>
<Style id="pond"><IconStyle><color>ffff8c1e</color><scale>1.2</scale></IconStyle></Style>
<Style id="wwnew"><LineStyle><color>ffc45816</color><width>5</width></LineStyle></Style>
<Style id="wwtree"><LineStyle><color>ff3b6a8a</color><width>5</width></LineStyle></Style>
<Style id="wwold"><LineStyle><color>ff3a8f1f</color><width>5</width></LineStyle></Style>
<Style id="tile"><LineStyle><color>ff006ae0</color><width>4</width></LineStyle></Style>
${pm}</Document></kml>`;
}

global.FieldEngine = { b811For, PROD, prodAvg, prodLine, applySoils, rasterizeSoils, parseWktPolygons, drainRank, spacingFor, soilRows, analyzeGrid, retune, WW_LEVELS, LOW_LEVELS, DEFAULT_TUNE, checkWaterways, wwStatus, lowMethod, waterwayRuns, chaikin, cellLL: ll, drawPlan, buildPDF, buildKML,
  workItems, summaryLines, mainOn, noWork, rampColor, ELEV_RAMP, FT, ACRE, POND_M };
})(window);
