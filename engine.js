/* Field Flow engine: terrain analysis, dirt-work items, plan drawing, PDF + KML.
   No map dependency, so it can be tested on its own. */
(function (global) {
'use strict';
const FT = 3.28084, ACRE = 4046.856, CY = 1.30795;
const DX = [-1, 0, 1, -1, 1, -1, 0, 1], DY = [-1, -1, -1, 0, 0, 1, 1, 1];
const DD = [Math.SQRT2, 1, Math.SQRT2, 1, 1, Math.SQRT2, 1, Math.SQRT2];
const POND_M = 0.05;          // water depth that counts as ponding (~2 in)
const WATERWAY_AC = 5;        // drainage area where a flow path warrants a waterway
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
function analyzeGrid(E, W, H, cs, poly, toLL) {
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
  g.depressions = findDepressions(g);
  g.waterways = findWaterways(g, WATERWAY_AC);
  return g;
}

const cxy = (g, i) => { const x = i % g.W; return [x + .5, (i - x) / g.W + .5]; };
const ll = (g, i) => { const p = cxy(g, i); return g.toLL(p[0], p[1]); };

function stepLen(g, c) { return (g.DK[c] >= 0 ? DD[g.DK[c]] : 1) * g.cs; }

function findDepressions(g) {
  const { W, H, M, P, D, S, cs } = g, lab = new Int32Array(W * H).fill(-1), out = [];
  for (const start of g.cells) {
    if (P[start] <= POND_M || lab[start] >= 0) continue;
    const id = out.length, stack = [start]; lab[start] = id;
    let n = 0, vol = 0, maxP = 0, pit = start, sx = 0, sy = 0;
    const members = [];
    while (stack.length) {
      const c = stack.pop(); n++; vol += P[c]; members.push(c);
      if (P[c] > maxP) { maxP = P[c]; pit = c; }
      const x = c % W, y = (c - x) / W; sx += x; sy += y;
      for (let k = 0; k < 8; k++) {
        const xx = x + DX[k], yy = y + DY[k]; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const m = yy * W + xx; if (M[m] && lab[m] < 0 && P[m] > POND_M) { lab[m] = id; stack.push(m); }
      }
    }
    // surface-drain route: follow the flow path out of the low spot until the water would run free
    let c = pit, len = 0, guard = 0;
    while (D[c] >= 0 && P[c] > 0.015 && guard++ < 5000) { len += stepLen(g, c); c = D[c]; }
    out.push({ id, n, members, areaAc: n * g.cellAc, volCY: vol * cs * cs * CY, maxFt: maxP * FT,
      pit, pitLL: ll(g, pit), exit: c, exitLL: ll(g, c), drainFt: len * FT, spillElevFt: (S[pit] + maxP) * FT });
  }
  const kept = out.filter(d => d.areaAc >= 0.05 && d.volCY >= 10).sort((a, b) => b.volCY - a.volCY).slice(0, 15);
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
    if (lenFt < 150) continue;
    const drop = S[main.head] - S[exit];
    out.push({ segs: list, lenFt, mainFt: main.len * FT, drainAc: A[exit] * g.cellAc,
      slopePct: main.len > 0 ? Math.max(0, drop / main.len * 100) : 0, exit, exitLL: ll(g, exit),
      mid: main.pts[Math.floor(main.pts.length / 2)] });
  }
  out.sort((a, b) => b.drainAc - a.drainAc);
  out.forEach((w, k) => w.label = 'W' + (k + 1));
  return out;
}

/* ---------- plan drawing ---------- */
function marchingSquares(ctx, S, W, x0, y0, x1, y1, level, k) {
  // draws contour segments for one level; grid values at cell centers
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

function drawPlan(g, maxW, maxH) {
  const { W, M, S, P, cells } = g;
  let bx0 = W, by0 = 1e9, bx1 = 0, by1 = 0;
  for (const i of cells) { const x = i % W, y = (i - x) / W; bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); by0 = Math.min(by0, y); by1 = Math.max(by1, y); }
  const pad = 4;
  bx0 = Math.max(0, bx0 - pad); by0 = Math.max(0, by0 - pad); bx1 = Math.min(W - 1, bx1 + pad); by1 = Math.min(g.H - 1, by1 + pad);
  const cw = bx1 - bx0 + 1, chh = by1 - by0 + 1;
  const k = Math.min(maxW / cw, maxH / chh);
  const cv = document.createElement('canvas'); cv.width = Math.round(cw * k); cv.height = Math.round(chh * k);
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);

  // elevation colors with hillshade, at grid resolution then scaled
  const small = document.createElement('canvas'); small.width = cw; small.height = chh;
  const sx = small.getContext('2d'), im = sx.createImageData(cw, chh);
  const span = Math.max(g.mx - g.mn, 0.3), z = 4;
  for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) {
    const i = y * W + x, o = ((y - by0) * cw + (x - bx0)) * 4;
    const xl = Math.max(0, x - 1), xr = Math.min(W - 1, x + 1), yu = Math.max(0, y - 1), yd = Math.min(g.H - 1, y + 1);
    const dzdx = (S[y * W + xr] - S[y * W + xl]) / g.cs * z, dzdy = (S[yd * W + x] - S[yu * W + x]) / g.cs * z;
    const shade = Math.max(.55, Math.min(1.15, 1 + (-dzdx - dzdy) * .35));
    let c = rampColor((S[i] - g.mn) / span);
    if (!M[i]) c = c.map(v => 235 - (235 - v) * .15);
    c = c.map(v => v * .55 + 255 * .45);           // pastel for print
    im.data[o] = Math.min(255, c[0] * shade); im.data[o + 1] = Math.min(255, c[1] * shade); im.data[o + 2] = Math.min(255, c[2] * shade); im.data[o + 3] = 255;
  }
  sx.putImageData(im, 0, 0);
  ctx.imageSmoothingEnabled = true; ctx.drawImage(small, 0, 0, cv.width, cv.height);

  const toPx = (gx, gy) => [(gx - bx0) * k, (gy - by0) * k];
  const polyPath = () => { ctx.beginPath(); g.poly.forEach((p, j) => { const q = toPx(p[0], p[1]); j ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); }); ctx.closePath(); };

  // contours inside the field
  const relief = (g.mx - g.mn) * FT, ivFt = contourInterval(relief), iv = ivFt / FT;
  ctx.save(); polyPath(); ctx.clip();
  for (let lv = Math.ceil(g.mn / iv) * iv; lv <= g.mx; lv += iv) {
    const major = Math.abs(Math.round(lv * FT / (ivFt * 5)) * ivFt * 5 - lv * FT) < 1e-6;
    ctx.strokeStyle = major ? 'rgba(60,40,20,.75)' : 'rgba(60,40,20,.35)'; ctx.lineWidth = major ? 2 : 1;
    marchingSquares(ctx, S, W, bx0, by0, bx1 + 1, by1 + 1, lv, k);
  }
  // ponding cells of reported depressions
  ctx.fillStyle = 'rgba(30,110,230,.55)';
  for (const d of g.depressions) for (const c of d.members) { const x = c % W, y = (c - x) / W; ctx.fillRect((x - bx0) * k, (y - by0) * k, k + .5, k + .5); }
  ctx.restore();

  // waterways
  const chaikin = (pts, n) => {
    for (let it = 0; it < n; it++) {
      if (pts.length < 3) return pts;
      const o = [pts[0]];
      for (let j = 0; j < pts.length - 1; j++) { const a = pts[j], b = pts[j + 1]; o.push([a[0] * .75 + b[0] * .25, a[1] * .75 + b[1] * .25], [a[0] * .25 + b[0] * .75, a[1] * .25 + b[1] * .75]); }
      o.push(pts[pts.length - 1]); pts = o;
    }
    return pts;
  };
  const segPath = s => { ctx.beginPath(); chaikin(s.pts.map(c => { const p = cxy(g, c); return toPx(p[0], p[1]); }), 3).forEach((q, j) => j ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])); };
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const w of g.waterways) for (const s of w.segs) { segPath(s); ctx.strokeStyle = '#fff'; ctx.lineWidth = 9; ctx.stroke(); }
  for (const w of g.waterways) for (const s of w.segs) { segPath(s); ctx.strokeStyle = '#1658c4'; ctx.lineWidth = 5; ctx.stroke(); }

  // field outline
  polyPath(); ctx.strokeStyle = '#111'; ctx.lineWidth = 3; ctx.stroke();

  // labels
  const tag = (txt, i, fill) => {
    const p = cxy(g, i), q = toPx(p[0], p[1]);
    const fs = Math.max(22, Math.round(cv.width / 42)), hh = fs * 1.4;
    ctx.font = `bold ${fs}px Helvetica, Arial, sans-serif`;
    const w = ctx.measureText(txt).width + fs * .7;
    ctx.fillStyle = fill; ctx.strokeStyle = '#fff'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(q[0] - w / 2, q[1] - hh / 2, w, hh, 8) : ctx.rect(q[0] - w / 2, q[1] - hh / 2, w, hh); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(txt, q[0], q[1] + 1);
  };
  for (const w of g.waterways) tag(w.label, w.mid, '#1658c4');
  for (const d of g.depressions) tag(d.label, d.pit, '#0a3d8f');
  for (const w of g.waterways) {             // exit arrows
    const p = cxy(g, w.exit), q = toPx(p[0], p[1]);
    ctx.fillStyle = '#c0392b'; ctx.beginPath(); ctx.arc(q[0], q[1], 8, 0, 7); ctx.fill();
  }

  // north arrow + scale bar
  ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.fillRect(cv.width - 64, 10, 54, 70);
  ctx.fillStyle = '#111'; ctx.beginPath(); ctx.moveTo(cv.width - 37, 18); ctx.lineTo(cv.width - 50, 52); ctx.lineTo(cv.width - 37, 45); ctx.lineTo(cv.width - 24, 52); ctx.closePath(); ctx.fill();
  ctx.font = 'bold 18px Helvetica, Arial, sans-serif'; ctx.textAlign = 'center'; ctx.fillText('N', cv.width - 37, 70);
  const ftPerPx = g.cs * FT / k, target = cv.width * .25 * ftPerPx;
  const nice = [50, 100, 200, 250, 500, 1000, 2000, 2500, 5000].reduce((a, b) => Math.abs(b - target) < Math.abs(a - target) ? b : a);
  const barPx = nice / ftPerPx;
  ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.fillRect(10, cv.height - 52, barPx + 30, 42);
  ctx.fillStyle = '#111'; ctx.fillRect(20, cv.height - 22, barPx, 6);
  ctx.fillStyle = '#fff'; ctx.fillRect(20 + barPx / 2, cv.height - 21, barPx / 2 - 1, 4);
  ctx.fillStyle = '#111'; ctx.font = '16px Helvetica, Arial, sans-serif'; ctx.textAlign = 'left'; ctx.fillText('0', 18, cv.height - 30);
  ctx.textAlign = 'right'; ctx.fillText(nice.toLocaleString() + ' ft', 20 + barPx + 6, cv.height - 30);
  return { canvas: cv, contourFt: ivFt };
}

/* ---------- recommendations text ---------- */
const f0 = v => Math.round(v).toLocaleString();
const f1 = v => v.toFixed(1);
const fll = p => p[1].toFixed(6) + ', ' + p[0].toFixed(6);

function workItems(g) {
  const items = [];
  for (const d of g.depressions) {
    items.push({
      id: d.label, kind: 'Low spot (ponds water)', where: fll(d.pitLL),
      size: `${f1(d.areaAc)} ac, up to ${f1(d.maxFt)} ft deep, ~${f0(d.volCY)} CY to fill`,
      work: `Option A, fill: about ${f0(d.volCY)} cubic yards to bring the low spot up to its spill elevation (about ${f0(d.spillElevFt)} ft). Strip and stockpile topsoil first, place fill in lifts, replace topsoil, and blend into the surrounding grade so it sheds water. ` +
            `Option B, surface drain: cut a shallow, wide drain about ${f0(d.drainFt)} ft long from the low point (cut up to ${f1(d.maxFt)} ft) to where water runs free at ${fll(d.exitLL)}. ` +
            `Option C, if the field is tiled: a tile intake/riser at the low point tied to a tile main.`
    });
  }
  for (const w of g.waterways) {
    const steep = w.slopePct >= 2;
    items.push({
      id: w.label, kind: 'Concentrated flow path', where: 'Leaves field at ' + fll(w.exitLL),
      size: `${f0(w.lenFt)} ft in field, drains ${f1(w.drainAc)} ac, ${f1(w.slopePct)}% avg slope`,
      work: `Grassed waterway along this path (NRCS Practice 412): shape a broad, parabolic channel, seed and protect it until the stand establishes. Width and depth should be sized for the ${f1(w.drainAc)}-acre drainage area by the contractor or your county SWCD/NRCS office. ` +
            (steep ? 'At 2%+ slope this path has a higher gully risk; treat it as a priority. ' : '') +
            'Check the outlet where it leaves the field for erosion and keep it stable.'
    });
  }
  return items;
}

function summaryLines(g) {
  const fillCY = g.depressions.reduce((t, d) => t + d.volCY, 0);
  const wwFt = g.waterways.reduce((t, w) => t + w.lenFt, 0);
  return [
    ['Field size', f1(g.fieldAc) + ' acres'],
    ['Elevation', `${f0(g.mn * FT)} to ${f0(g.mx * FT)} ft (${f1((g.mx - g.mn) * FT)} ft relief)`],
    ['Average slope', f1(g.slopePct) + '%'],
    ['Ponding area', f1(g.pondAc) + ' acres'],
    ['Low spots to address', g.depressions.length + (g.depressions.length ? ` (about ${f0(fillCY)} CY total if filled)` : '')],
    ['Flow paths for waterways', g.waterways.length + (g.waterways.length ? ` (${f0(wwFt)} ft total)` : '')],
    ['Main outlet', `${fll(ll(g, g.outlet))}, drains ${f0(g.outletAc)} ac`]
  ];
}

const NOTES = [
  'Planning-level estimate from USGS 3DEP elevation data (mostly ~10 m / 33 ft resolution). Small rills, tile lines, terraces and grade changes under about 0.5 ft are below what this data can see. Confirm with an RTK topo survey before bidding or moving dirt.',
  'Fill volumes are the space below each low spot\'s spill elevation. They are a ceiling: a surface drain or partial fill often fixes the problem with less dirt.',
  'Do not divert or concentrate water onto a neighbor\'s land beyond its natural flow. Check with your county SWCD/NRCS office for design help; grassed waterways are often eligible for cost share (e.g., EQIP).',
  'Call 811 (JULIE in Illinois) before any digging. Locate existing tile before cutting drains or shaping waterways.',
  'Coordinates are latitude, longitude (WGS84). The KML file from the app loads these items into Google Earth or most GPS/guidance software.'
];

/* ---------- PDF (pdf-lib) ---------- */
async function buildPDF(g, opts) {
  const { PDFDocument, StandardFonts, rgb } = global.PDFLib;
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const PW = 612, PH = 792, MG = 40, ink = rgb(.08, .08, .08), mute = rgb(.4, .4, .4), blue = rgb(.05, .3, .65);
  let page, y;
  const newPage = () => { page = doc.addPage([PW, PH]); y = PH - MG; };
  const san = s => String(s).replace(/[^\x20-\x7E°]/g, c => ({ '–': '-', '—': '-', '’': "'", '“': '"', '”': '"', '×': 'x' }[c] || ''));
  const wrap = (text, f, size, width) => {
    const words = san(text).split(/\s+/), lines = []; let line = '';
    for (const w of words) { const t = line ? line + ' ' + w : w; if (f.widthOfTextAtSize(t, size) > width && line) { lines.push(line); line = w; } else line = t; }
    if (line) lines.push(line); return lines;
  };
  const text = (t, x, f, size, color, width) => {
    const lines = wrap(t, f, size, width || PW - MG - x);
    for (const l of lines) { if (y < MG + size) newPage(); page.drawText(l, { x, y: y - size, size, font: f, color: color || ink }); y -= size * 1.32; }
  };
  const name = opts.name || 'Field';
  const plan = drawPlan(g, 1600, 1500);
  const png = await doc.embedPng(plan.canvas.toDataURL('image/png'));

  // page 1: summary + plan
  newPage();
  text('Dirt work recommendations', MG, bold, 20, ink); y -= 2;
  text(`${name}  |  ${opts.date}  |  Field center ${fll(opts.center)}`, MG, font, 10, mute); y -= 10;
  const rows = summaryLines(g);
  for (const [k, v] of rows) {
    page.drawText(san(k), { x: MG, y: y - 10, size: 10, font: bold, color: ink });
    const ls = wrap(v, font, 10, PW - MG * 2 - 150);
    ls.forEach((l, j) => page.drawText(l, { x: MG + 150, y: y - 10 - j * 13, size: 10, font, color: ink }));
    y -= 13 * ls.length + 2;
  }
  y -= 8;
  const maxImgH = y - MG - 36, sc = Math.min((PW - MG * 2) / png.width, maxImgH / png.height);
  const iw = png.width * sc, ih = png.height * sc;
  page.drawImage(png, { x: MG + (PW - MG * 2 - iw) / 2, y: y - ih, width: iw, height: ih });
  page.drawRectangle({ x: MG + (PW - MG * 2 - iw) / 2, y: y - ih, width: iw, height: ih, borderColor: mute, borderWidth: .5 });
  y -= ih + 12;
  text(`Map: ${plan.contourFt}-ft contours (heavier every ${plan.contourFt * 5} ft), color = elevation (blue low, red high). Dark blue = ponding low spots (D#). Blue lines = flow paths for waterways (W#). Red dots = where they leave the field.`, MG, font, 8.5, mute);

  // page 2: work items
  newPage();
  text('Recommended work', MG, bold, 16, ink); y -= 4;
  const items = workItems(g);
  if (!items.length) text('No low spots or concentrated flow paths large enough to recommend dirt work were found at this data resolution.', MG, font, 10.5);
  for (const it of items) {
    if (y < MG + 110) newPage();
    page.drawRectangle({ x: MG, y: y - 18, width: 34, height: 18, color: it.id[0] === 'D' ? rgb(.04, .24, .56) : blue });
    page.drawText(it.id, { x: MG + 6, y: y - 13.5, size: 11, font: bold, color: rgb(1, 1, 1) });
    page.drawText(san(it.kind), { x: MG + 44, y: y - 13.5, size: 11.5, font: bold, color: ink });
    y -= 24;
    text('Location: ' + it.where, MG + 44, font, 9.5, mute);
    text('Size: ' + it.size, MG + 44, font, 9.5, mute);
    y -= 2;
    text(it.work, MG + 44, font, 10, ink);
    y -= 10;
  }
  if (opts.notes) { if (y < MG + 80) newPage(); text('Owner notes', MG, bold, 12); y -= 2; text(opts.notes, MG, font, 10); y -= 8; }
  if (y < MG + 160) newPage();
  y -= 4; text('Notes and assumptions', MG, bold, 12); y -= 2;
  for (const n of NOTES) { text('- ' + n, MG, font, 9, mute); y -= 3; }

  const pages = doc.getPages();
  pages.forEach((p, j) => p.drawText(san(`${name} - dirt work recommendations - page ${j + 1} of ${pages.length}`), { x: MG, y: 20, size: 8, font, color: mute }));
  return await doc.save();
}

/* ---------- KML ---------- */
function buildKML(g, name) {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const c = p => p[0].toFixed(7) + ',' + p[1].toFixed(7) + ',0';
  const items = workItems(g), byId = Object.fromEntries(items.map(i => [i.id, i]));
  const ring = [...g.poly, g.poly[0]].map(p => c(g.toLL(p[0], p[1]))).join(' ');
  let pm = `<Placemark><name>${esc(name)} boundary</name><styleUrl>#field</styleUrl><Polygon><outerBoundaryIs><LinearRing><coordinates>${ring}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>\n`;
  for (const d of g.depressions) {
    const it = byId[d.label];
    pm += `<Placemark><name>${d.label} low spot</name><description>${esc(it.size + '. ' + it.work)}</description><styleUrl>#pond</styleUrl><Point><coordinates>${c(d.pitLL)}</coordinates></Point></Placemark>\n`;
  }
  for (const w of g.waterways) {
    const it = byId[w.label];
    pm += `<Placemark><name>${w.label} waterway</name><description>${esc(it.size + '. ' + it.work)}</description><styleUrl>#ww</styleUrl><MultiGeometry>` +
      w.segs.map(s => `<LineString><tessellate>1</tessellate><coordinates>${s.pts.map(i => c(ll(g, i))).join(' ')}</coordinates></LineString>`).join('') +
      `</MultiGeometry></Placemark>\n`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${esc(name)} dirt work</name>
<Style id="field"><LineStyle><color>ffffffff</color><width>3</width></LineStyle><PolyStyle><fill>0</fill></PolyStyle></Style>
<Style id="pond"><IconStyle><color>ffff8c1e</color><scale>1.2</scale></IconStyle></Style>
<Style id="ww"><LineStyle><color>ffc45816</color><width>5</width></LineStyle></Style>
${pm}</Document></kml>`;
}

global.FieldEngine = { analyzeGrid, drawPlan, buildPDF, buildKML, workItems, summaryLines, rampColor, ELEV_RAMP, FT, ACRE, POND_M };
})(window);
