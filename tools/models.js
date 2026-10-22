// 多種 SMC 進場模型的比較回測（只用當時已收盤的資料，不偷看未來）
// SC = 掃流動性 + 1H CHoCH（回調結束、順 H4 趨勢）
// BF = 1H BOS 帶 FVG，回踩 FVG 進場（止損放 OB 外）
// OB = 現行策略（回到 OB / FVG 出吞沒 + EMA + 斐波）
const fs = require('fs'), path = require('path');
const SMC = require('../src/smc');
const { load, DAYS, SOURCE, EXCHANGE } = require('./hist');
const H = 3600e3, H4 = 4 * H, FEE = 0.0006;

function prep(d) {
  const L = d.ltf, HH = d.htf;
  const ls = SMC.structure(L, { swingLen: 3, breakBy: 'close', obInvalid: 'close' });
  const hs = SMC.structure(HH, { swingLen: 3, breakBy: 'close', obInvalid: 'close' });
  const evAt = new Map(); for (const e of ls.events) evAt.set(e.idx, e);
  const hev = hs.events.map(e => ({ T: HH[e.idx].t + H4, dir: e.dir, from: e.from, idx: e.idx }));
  return { L, HH, ls, hs, evAt, hev, ema: SMC.ema(L, 50) };
}
// H4 在時間 T（1H 收盤時刻）的方向與區間
function htfAt(P, T) {
  let k = -1; for (let a = 0; a < P.hev.length && P.hev[a].T <= T; a++) k = a;
  if (k < 0) return null;
  const e = P.hev[k]; let last = e.idx; while (last + 1 < P.HH.length && P.HH[last + 1].t + H4 <= T) last++;
  let hi = -Infinity, lo = Infinity; for (let j = e.from; j <= last; j++) { hi = Math.max(hi, P.HH[j].h); lo = Math.min(lo, P.HH[j].l); }
  return { dir: e.dir, hi, lo, eq: (hi + lo) / 2 };
}
const inPD = (h, dir, p) => dir > 0 ? p <= h.eq : p >= h.eq;   // 做多在折價區、做空在溢價區

// ---- 模型 SC：掃流動性 + CHoCH ----
function modelSC(P, i, o) {
  const e = P.evAt.get(i); if (!e || e.type !== 'CHoCH') return null;
  const L = P.L, dir = e.dir, T = L[i].t + H, h = htfAt(P, T);
  if (!h || h.dir !== dir) return null;
  let m = e.from; for (let j = e.from; j <= i; j++) if (dir > 0 ? L[j].l < L[m].l : L[j].h > L[m].h) m = j;
  if (o.sweep !== 'off') {
    const pts = dir > 0 ? P.ls.sw.lo : P.ls.sw.hi; let ok = false;
    for (const p of pts) {
      if (p.i >= m || p.conf > m || p.i < m - 72) continue;
      const took = dir > 0 ? L[m].l < p.price : L[m].h > p.price;
      const back = dir > 0 ? Math.max(L[m].c, (L[m + 1] || L[m]).c) > p.price : Math.min(L[m].c, (L[m + 1] || L[m]).c) < p.price;
      if (took && back) { ok = true; break; }
    }
    if (!ok) return null;
  }
  let ext = L[m].c; for (let j = m; j <= i; j++) ext = dir > 0 ? Math.max(ext, L[j].h) : Math.min(ext, L[j].l);
  const lo = dir > 0 ? L[m].l : L[m].h;
  const entry = o.entry === 'close' ? L[i].c : ext - (ext - lo) * o.ote;
  if (o.pd && !inPD(h, dir, entry)) return null;
  if (o.ema && !(dir > 0 ? L[i].c > P.ema[i] : L[i].c < P.ema[i])) return null;
  const stop = lo * (1 - dir * 0.002);
  return { i, dir, entry, stop, type: o.entry === 'close' ? 'market' : 'limit', maxWait: 12, struct: dir > 0 ? h.hi : h.lo };
}

// ---- 模型 BF：BOS + FVG 回踩 ----
function modelBF(P, i, o) {
  const e = P.evAt.get(i); if (!e || e.type !== 'BOS' || !e.ob || !e.ob.fz) return null;
  const L = P.L, dir = e.dir, T = L[i].t + H, h = htfAt(P, T);
  if (!h || h.dir !== dir) return null;
  const f = e.ob.fz, entry = o.entry === 'mid' ? (f.lo + f.hi) / 2 : (dir > 0 ? f.hi : f.lo);
  if (o.pd && !inPD(h, dir, entry)) return null;
  if (o.ema && !(dir > 0 ? L[i].c > P.ema[i] : L[i].c < P.ema[i])) return null;
  const stop = (dir > 0 ? e.ob.lo : e.ob.hi) * (1 - dir * 0.002);
  if (dir > 0 ? stop >= entry : stop <= entry) return null;
  return { i, dir, entry, stop, type: 'limit', maxWait: 24, struct: dir > 0 ? h.hi : h.lo };
}

// ---- 模型 OB：現行策略（用網站的 analyze） ----
const OB_RULES = { swingLen: 3, htfSwing: 3, breakBy: 'close', obInvalid: 'close', fibMin: 0.618, emaLen: 50, lookback: 10, entry: 'close', minRR: 0, stopBuf: 0.2, target: 'htf', btcFilter: 'off', fundingMax: 0, side: 'both', stopMode: 'ob',
  pattern: 'engulf', cFib: 'need', cEma: 'need', cFvg: 'need', cSweep: 'score', cDaily: 'score', minScore: 0, beAt: 0, minQuality: 0, fvgEntry: 'on', fvgStop: 'ob', fvgFib: 0 };
function setupsOB(P, o) {
  const L = P.L, HH = P.HH, out = []; let hj = 0;
  for (let i = 300; i < L.length; i++) {
    if (!SMC.isEngulf(L, i, 1) && !SMC.isEngulf(L, i, -1)) continue;
    const T = L[i].t + H; while (hj < HH.length && HH[hj].t + H4 <= T) hj++;
    if (hj < 60) continue;
    const r = SMC.analyze('X', L.slice(i - 299, i + 1), { ...OB_RULES, ...o }, HH.slice(Math.max(0, hj - 500), hj));
    if (r.status !== 'trigger' || r.sigIdx !== 299) continue;
    out.push({ i, dir: r.dir, entry: r.entry, stop: r.stop, type: 'market', maxWait: 0, struct: r.target, q: r.quality && r.quality.score });
  }
  return out;
}

// ---- 共用模擬：成交 → 止損 / 分批 / 保本 / 目標 ----
function sim(L, s, o) {
  const up = s.dir > 0, risk = Math.abs(s.entry - s.stop); if (!(risk > 0)) return null;
  let tgt;
  if (o.tp === 'struct') { if (!s.struct || (s.struct - s.entry) * s.dir / risk < o.minRR) return null; tgt = s.struct; }
  else tgt = s.entry + s.dir * risk * o.tp;
  const Rt = (tgt - s.entry) * s.dir / risk;
  let fill = s.type === 'market' ? s.i : -1, j = s.i + 1;
  for (; fill < 0 && j < L.length; j++) {
    const b = L[j];
    if (j - s.i > s.maxWait) return { status: 'expired', end: j };
    if (up ? b.l <= s.entry : b.h >= s.entry) { fill = j; break; }
    if (up ? b.h >= tgt : b.l <= tgt) return { status: 'missed', end: j };
  }
  if (fill < 0) return null;
  const cost = 2 * FEE * s.entry / risk;
  let sl = s.stop, size = 1, got = 0, p1 = false, be = false;
  for (let k = fill; k < L.length; k++) {
    const b = L[k];
    if (up ? b.l <= sl : b.h >= sl) { const R = got + size * (sl - s.entry) * s.dir / risk - cost; return { status: R > 0 ? 'win' : R > -0.5 ? 'be' : 'loss', R, end: k }; }
    if (k === fill) continue;
    if (o.p1 && !p1 && (up ? b.h >= s.entry + risk * o.p1 : b.l <= s.entry - risk * o.p1)) { got += 0.5 * o.p1; size = 0.5; p1 = true; sl = s.entry; }
    if (up ? b.h >= tgt : b.l <= tgt) { const R = got + size * Rt - cost; return { status: 'win', R, end: k }; }
    if (o.be && !be && (up ? b.h >= s.entry + (tgt - s.entry) * o.be : b.l <= s.entry - (s.entry - tgt) * o.be)) { be = true; sl = s.entry; }
  }
  return { status: 'open', end: L.length };
}

function run(data, P, btc, cfg) {
  const trades = [];
  for (const sym of Object.keys(data)) {
    const p = P[sym]; if (!p || p.L.length < 400) continue;
    let setups;
    if (cfg.model === 'OB') setups = (p._ob ||= {})[JSON.stringify(cfg.m || {})] ||= setupsOB(p, cfg.m || {});
    else { setups = []; const fn = cfg.model === 'SC' ? modelSC : modelBF; for (let i = 300; i < p.L.length; i++) { const s = fn(p, i, cfg.m); if (s) setups.push(s); } }
    let busy = -1;
    for (const s of setups) {
      if (!cfg.overlap && s.i <= busy) continue;
      const T = p.L[s.i].t + H;
      if (cfg.btc !== false && sym !== 'BTC') { const b = htfAt(btc, T); if (!b || b.dir !== s.dir) continue; }
      const r = sim(p.L, s, cfg.s); if (!r) continue;
      busy = r.end;
      if (r.R != null) trades.push({ sym, dir: s.dir, t: T, closedT: p.L[Math.min(r.end, p.L.length - 1)].t + H, R: r.R, status: r.status });
    }
  }
  return trades;
}

function stats(tr) {
  const d = tr.slice().sort((a, b) => a.closedT - b.closedT);
  const w = d.filter(t => t.R > 0), sw = w.reduce((a, t) => a + t.R, 0), sl = d.filter(t => t.R <= 0).reduce((a, t) => a + t.R, 0);
  let eq = 0, pk = 0, dd = 0, st = 0, ms = 0;
  for (const t of d) { eq += t.R; pk = Math.max(pk, eq); dd = Math.min(dd, eq - pk); st = t.R <= 0 ? st + 1 : 0; ms = Math.max(ms, st); }
  return { n: d.length, wr: d.length ? w.length / d.length : 0, R: sw + sl, avg: d.length ? (sw + sl) / d.length : 0, pf: sl < 0 ? sw / -sl : 0, dd, ms };
}

(async () => {
  const data = await load();
  const P = {}; for (const s of Object.keys(data)) P[s] = prep(data[s]);
  const btc = P.BTC;
  let t0 = Infinity, t1 = 0; for (const s in P) { const L = P[s].L; if (L.length > 310) { t0 = Math.min(t0, L[300].t); t1 = Math.max(t1, L[L.length - 1].t); } }
  const mid = (t0 + t1) / 2;
  const configs = JSON.parse(fs.readFileSync(path.join(__dirname, 'models.json'), 'utf8'));
  const rows = [];
  for (const c of configs) {
    const tr = run(data, P, btc, c), a = stats(tr), h1 = stats(tr.filter(t => t.t < mid)), h2 = stats(tr.filter(t => t.t >= mid));
    const Lg = stats(tr.filter(t => t.dir > 0)), Sh = stats(tr.filter(t => t.dir < 0));
    rows.push({ name: c.name, ...a, h1, h2, lR: Lg.R, sR: Sh.R, lw: Lg.wr, sw: Sh.wr });
    console.log(c.name, a.n, (a.wr * 100).toFixed(0) + '%', a.R.toFixed(1));
  }
  const f = v => (v > 0 ? '+' : '') + v.toFixed(1), p = v => (v * 100).toFixed(0) + '%';
  const md = [`# 模型比較（${DAYS} 天，資料：${SOURCE === "ccxt" ? "ccxt / " + EXCHANGE : "BingX REST"}，${Object.keys(data).length} 幣，手續費 0.06%×2）`, '',
    '| 設定 | 筆數 | 勝率 | 平均R | 累計R | PF | 回撤 | 連虧 | 前半 R / 勝率 | 後半 R / 勝率 | 多 R / 勝率 | 空 R / 勝率 |', '|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map(r => `| ${r.name} | ${r.n} | ${p(r.wr)} | ${(r.avg > 0 ? '+' : '') + r.avg.toFixed(2)} | ${f(r.R)} | ${r.pf.toFixed(2)} | ${r.dd.toFixed(1)} | ${r.ms} | ${f(r.h1.R)} / ${p(r.h1.wr)} | ${f(r.h2.R)} / ${p(r.h2.wr)} | ${f(r.lR)} / ${p(r.lw)} | ${f(r.sR)} / ${p(r.sw)} |`)].join('\n');
  console.log('\n' + md);
  fs.writeFileSync(path.join(__dirname, '..', 'research-cache', `models-${SOURCE}-${DAYS}.md`), md);
})().catch(e => { console.error(e); process.exit(1); });
