// 短線策略第二批：TradingView 常見指標策略（UT Bot、Chandelier Exit、Squeeze Momentum、Donchian、SSL、PSAR、RSI2、15M EMA 交叉）
// 資料與模擬方式跟 intraday.js 一樣（OKX 永續、訊號收盤→下一根開盤進場、同根先算止損、手續費 0.022%×2）
const fs = require('fs'), path = require('path');
const { load, EXCHANGE } = require('./hist');
const FEE = 0.022 / 100, H = 3600e3, M15 = 900e3, H4 = 4 * H, DAY = 24 * H;
const OUT = path.join(__dirname, '..', 'research-cache', `intraday2-${EXCHANGE}.md`);

// ---- 指標 ----
const ema = (a, n) => { const k = 2 / (n + 1), o = new Array(a.length); let e = a[0]; for (let i = 0; i < a.length; i++) { e = i ? a[i] * k + e * (1 - k) : a[0]; o[i] = e; } return o; };
const sma = (a, n) => { const o = new Array(a.length).fill(NaN); let s = 0; for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= n) s -= a[i - n]; if (i >= n - 1) o[i] = s / n; } return o; };
function atr(b, n = 14) { const o = new Array(b.length).fill(NaN); let a = 0; for (let i = 1; i < b.length; i++) { const tr = Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c)); a = i <= n ? a + tr / n : (a * (n - 1) + tr) / n; if (i >= n) o[i] = a; } return o; }
function macdHist(c) { const f = ema(c, 12), s = ema(c, 26), m = f.map((x, i) => x - s[i]), sig = ema(m, 9); return m.map((x, i) => x - sig[i]); }
function supertrend(b, n = 10, k = 3) {
  const A = atr(b, n), dir = new Array(b.length).fill(0), line = new Array(b.length).fill(NaN); let up = 0, dn = 0, d = 1;
  for (let i = 0; i < b.length; i++) { if (!isFinite(A[i])) continue; const m = (b[i].h + b[i].l) / 2; let u = m - k * A[i], l = m + k * A[i];
    if (i && isFinite(A[i - 1])) { u = b[i - 1].c > up ? Math.max(u, up) : u; l = b[i - 1].c < dn ? Math.min(l, dn) : l; if (d === 1 && b[i].c < up) d = -1; else if (d === -1 && b[i].c > dn) d = 1; }
    up = u; dn = l; dir[i] = d; line[i] = d === 1 ? u : l; }
  return { dir, line };
}
// 4H 趨勢（跟策略①一樣）：EMA50>EMA200 且收盤>EMA50 → +1
function trendSeries(h4) { const c = h4.map(b => b.c), e50 = ema(c, 50), e200 = ema(c, 200); return h4.map((b, i) => i < 200 ? 0 : e50[i] > e200[i] && b.c > e50[i] ? 1 : e50[i] < e200[i] && b.c < e50[i] ? -1 : 0); }
// 對齊：執行週期第 i 根收盤時，已收完的高週期最後一根
function aligner(hi, tfHi) { let j = -1; return closeT => { while (j + 1 < hi.length && hi[j + 1].t + tfHi <= closeT) j++; return j; }; }

// ---- 模擬：訊號在第 i 根收盤，下一根開盤進場；同一根同時碰止損和止盈算止損 ----
function simulate(bars, sigs, tf, fee = global.__FEE ?? FEE) {
  if (global.__SIM) return global.__SIM(bars, sigs, tf, fee);
  const out = []; let busy = -1;
  for (const s of sigs) {
    if (s.i <= busy || s.i + 1 >= bars.length) continue;
    const e = bars[s.i + 1].o, risk = s.riskAbs ?? Math.abs(e - s.stop); if (!(risk > 0)) continue;
    const stop = e - s.dir * risk, tp = e + s.dir * s.rr * risk, last = Math.min(bars.length - 1, s.i + s.maxBars);
    let exit = null, j;
    for (j = s.i + 1; j <= last; j++) {
      const b = bars[j], hitS = s.dir > 0 ? b.l <= stop : b.h >= stop, hitT = s.dir > 0 ? b.h >= tp : b.l <= tp;
      if (hitS) { exit = stop; break; } if (hitT) { exit = tp; break; }
      if (s.exitAt && b.t + tf >= s.exitAt) { exit = b.c; break; }
      if (s.flip && s.flip(j)) { exit = b.c; break; }
    }
    if (exit == null) { j = last; exit = bars[last].c; }
    const R = s.dir * (exit - e) / risk - 2 * fee * e / risk;
    out.push({ inT: bars[s.i + 1].t, t: bars[j].t + tf, R, dir: s.dir, hold: (bars[j].t + tf - bars[s.i + 1].t) / H });
    busy = j;
  }
  return out;
}


// ---- 額外指標 ----
const hiN = (b, n) => b.map((_, i) => { if (i < n - 1) return NaN; let m = -Infinity; for (let k = i - n + 1; k <= i; k++) m = Math.max(m, b[k].h); return m; });
const loN = (b, n) => b.map((_, i) => { if (i < n - 1) return NaN; let m = Infinity; for (let k = i - n + 1; k <= i; k++) m = Math.min(m, b[k].l); return m; });
function rsi(c, n) { const o = new Array(c.length).fill(NaN); let g = 0, l = 0; for (let i = 1; i < c.length; i++) { const d = c[i] - c[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0); if (i <= n) { g += up / n; l += dn / n; } else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; } if (i >= n) o[i] = l ? 100 - 100 / (1 + g / l) : 100; } return o; }
function stdev(a, n) { const m = sma(a, n); return a.map((_, i) => { if (i < n - 1) return NaN; let s = 0; for (let k = i - n + 1; k <= i; k++) s += (a[k] - m[i]) ** 2; return Math.sqrt(s / n); }); }
function linreg(a, n) { return a.map((_, i) => { if (i < n - 1) return NaN; let sx = 0, sy = 0, sxy = 0, sxx = 0; for (let k = 0; k < n; k++) { const y = a[i - n + 1 + k]; sx += k; sy += y; sxy += k * y; sxx += k * k; } const m = (n * sxy - sx * sy) / (n * sxx - sx * sx), c0 = (sy - m * sx) / n; return c0 + m * (n - 1); }); }
// UT Bot Alerts（QuantNomad 版）：ATR 追蹤線，收盤穿越就翻向
function utbot(b, key, n) { const A = atr(b, n), tr = new Array(b.length).fill(NaN), dir = new Array(b.length).fill(0);
  for (let i = 1; i < b.length; i++) { if (!isFinite(A[i])) continue; const c = b[i].c, c1 = b[i - 1].c, p = isFinite(tr[i - 1]) ? tr[i - 1] : c, L = key * A[i];
    tr[i] = c > p && c1 > p ? Math.max(p, c - L) : c < p && c1 < p ? Math.min(p, c + L) : c > p ? c - L : c + L; dir[i] = c > tr[i] ? 1 : -1; }
  return { line: tr, dir }; }
// Chandelier Exit（everget 版）
function chandelier(b, n, k) { const A = atr(b, n), H_ = hiN(b, n), L_ = loN(b, n), dir = new Array(b.length).fill(0), line = new Array(b.length).fill(NaN); let ls = NaN, ss = NaN, d = 1;
  for (let i = 1; i < b.length; i++) { if (!isFinite(A[i]) || !isFinite(H_[i])) continue; let l = H_[i] - k * A[i], s = L_[i] + k * A[i];
    if (isFinite(ls)) { l = b[i - 1].c > ls ? Math.max(l, ls) : l; s = b[i - 1].c < ss ? Math.min(s, ss) : s; d = b[i].c > ss ? 1 : b[i].c < ls ? -1 : d; }
    ls = l; ss = s; dir[i] = d; line[i] = d > 0 ? l : s; }
  return { dir, line }; }
// SSL Channel
function ssl(b, n) { const sh = sma(b.map(x => x.h), n), sl = sma(b.map(x => x.l), n), dir = new Array(b.length).fill(0), line = new Array(b.length).fill(NaN); let d = 0;
  for (let i = 0; i < b.length; i++) { if (!isFinite(sh[i])) continue; d = b[i].c > sh[i] ? 1 : b[i].c < sl[i] ? -1 : d; dir[i] = d; line[i] = d > 0 ? sl[i] : sh[i]; } return { dir, line }; }
// Parabolic SAR (0.02, 0.2)
function psar(b, st = 0.02, mx = 0.2) { const dir = new Array(b.length).fill(0), line = new Array(b.length).fill(NaN); let d = 1, sar = b[0].l, ep = b[0].h, af = st;
  for (let i = 1; i < b.length; i++) { sar = sar + af * (ep - sar);
    if (d > 0) { sar = Math.min(sar, b[i - 1].l, b[Math.max(0, i - 2)].l); if (b[i].l < sar) { d = -1; sar = ep; ep = b[i].l; af = st; } else if (b[i].h > ep) { ep = b[i].h; af = Math.min(af + st, mx); } }
    else { sar = Math.max(sar, b[i - 1].h, b[Math.max(0, i - 2)].h); if (b[i].h > sar) { d = 1; sar = ep; ep = b[i].h; af = st; } else if (b[i].l < ep) { ep = b[i].l; af = Math.min(af + st, mx); } }
    dir[i] = d; line[i] = sar; } return { dir, line }; }

// ---- 通用：「指標翻向」型（翻向進場，止損在指標線外，指標反向出場） ----
// filt: 'h4' 4H 順勢才做 / 'none' 不過濾；rr: 止盈幾 R（99 = 只靠反向或 24 小時出場）
function flipStrat(ind, filt, rr, maxBars = 24, extra) { return (d) => {
  const b = d.ltf, A = atr(b), x = ind(b), tr = trendSeries(d.htf), al = aligner(d.htf, H4), sigs = [];
  for (let i = 210; i < b.length; i++) { if (!(x.dir[i] && x.dir[i - 1] === -x.dir[i])) continue; const dir = x.dir[i];
    if (filt === 'h4') { const j = al(b[i].t + H); if (j < 0 || tr[j] !== dir) continue; }
    if (extra && !extra(b, i, dir)) continue;
    const dist = Math.max(Math.abs(b[i].c - x.line[i]), 0.5 * A[i]); if (dist > 4 * A[i]) continue;
    sigs.push({ i, dir, riskAbs: dist, rr, maxBars, flip: k => x.dir[k] === -dir }); }
  return simulate(b, sigs, H);
}; }
const above200 = (() => { const cache = new WeakMap(); return (b, i, dir) => { let e = cache.get(b); if (!e) { e = ema(b.map(x => x.c), 200); cache.set(b, e); } return dir * (b[i].c - e[i]) > 0; }; })();

const S = {
  'G1｜UT Bot（key 1, ATR 10）4H 順勢｜2R': flipStrat(b => utbot(b, 1, 10), 'h4', 2),
  'G2｜UT Bot（key 2, ATR 10）4H 順勢｜2R': flipStrat(b => utbot(b, 2, 10), 'h4', 2),
  'G3｜UT Bot（key 2, ATR 10）4H 順勢｜反向才出': flipStrat(b => utbot(b, 2, 10), 'h4', 99),
  'G4｜UT Bot（key 2, ATR 10）不過濾｜2R': flipStrat(b => utbot(b, 2, 10), 'none', 2),
  'H1｜Chandelier Exit（22, 3）4H 順勢｜2R': flipStrat(b => chandelier(b, 22, 3), 'h4', 2),
  'H2｜Chandelier Exit（22, 3）4H 順勢｜反向才出': flipStrat(b => chandelier(b, 22, 3), 'h4', 99),
  'H3｜Chandelier Exit（22, 3）不過濾｜2R': flipStrat(b => chandelier(b, 22, 3), 'none', 2),
  'K1｜SSL Channel（10）4H 順勢＋EMA200｜2R': flipStrat(b => ssl(b, 10), 'h4', 2, 24, above200),
  'K2｜SSL Channel（10）4H 順勢＋EMA200｜反向才出': flipStrat(b => ssl(b, 10), 'h4', 99, 24, above200),
  'P1｜Parabolic SAR＋EMA200（4H 順勢）｜2R': flipStrat(b => psar(b), 'h4', 2, 24, above200),
  'P2｜Parabolic SAR＋EMA200（4H 順勢）｜反向才出': flipStrat(b => psar(b), 'h4', 99, 24, above200),
  'I1｜Squeeze Momentum 擠壓釋放（4H 順勢）｜2R': (d) => {
    const b = d.ltf, c = b.map(x => x.c), A = atr(b), n = 20, m = sma(c, n), sd = stdev(c, n), trr = b.map((x, i) => i ? Math.max(x.h - x.l, Math.abs(x.h - b[i - 1].c), Math.abs(x.l - b[i - 1].c)) : x.h - x.l), rng = sma(trr, n);
    const hh = hiN(b, n), ll = loN(b, n), val = linreg(c.map((x, i) => x - ((hh[i] + ll[i]) / 2 + m[i]) / 2), n);
    const on = c.map((_, i) => m[i] - 2 * sd[i] > m[i] - 1.5 * rng[i] && m[i] + 2 * sd[i] < m[i] + 1.5 * rng[i]);
    const tr = trendSeries(d.htf), al = aligner(d.htf, H4), sigs = [];
    for (let i = 210; i < b.length; i++) { if (!(on[i - 1] && !on[i]) || !isFinite(val[i])) continue; const dir = Math.sign(val[i]); const j = al(b[i].t + H); if (j < 0 || tr[j] !== dir) continue;
      sigs.push({ i, dir, riskAbs: 1.5 * A[i], rr: 2, maxBars: 24, flip: k => dir * val[k] < 0 }); }
    return simulate(b, sigs, H);
  },
  'J1｜Donchian 20 突破（海龜，4H 順勢，10 根反向出）': (d) => {
    const b = d.ltf, A = atr(b), h20 = hiN(b, 20), l20 = loN(b, 20), h10 = hiN(b, 10), l10 = loN(b, 10), tr = trendSeries(d.htf), al = aligner(d.htf, H4), sigs = [];
    for (let i = 210; i < b.length; i++) { const j = al(b[i].t + H); if (j < 0) continue; const dir = tr[j]; if (!dir) continue;
      const brk = dir > 0 ? b[i].c > h20[i - 1] && b[i - 1].c <= h20[i - 2] : b[i].c < l20[i - 1] && b[i - 1].c >= l20[i - 2]; if (!brk) continue;
      sigs.push({ i, dir, riskAbs: 2 * A[i], rr: 3, maxBars: 24, flip: k => dir > 0 ? b[k].c < l10[k - 1] : b[k].c > h10[k - 1] }); }
    return simulate(b, sigs, H);
  },
  'R1｜RSI(2) 回檔（Connors，4H 順勢＋1H 在 SMA200 同側）': (d) => {
    const b = d.ltf, c = b.map(x => x.c), A = atr(b), r = rsi(c, 2), s200 = sma(c, 200), s5 = sma(c, 5), tr = trendSeries(d.htf), al = aligner(d.htf, H4), sigs = [];
    for (let i = 210; i < b.length; i++) { const j = al(b[i].t + H); if (j < 0) continue; const dir = tr[j]; if (!dir || dir * (c[i] - s200[i]) <= 0) continue;
      if (!(dir > 0 ? r[i] < 10 : r[i] > 90)) continue;
      sigs.push({ i, dir, riskAbs: 2 * A[i], rr: 99, maxBars: 24, flip: k => dir * (c[k] - s5[k]) > 0 }); }
    return simulate(b, sigs, H);
  },
  'L1｜15M EMA 9/21 交叉（15M EMA200＋4H 順勢）｜2R': (d) => {
    const b = d.m15; if (!b) return [];
    const c = b.map(x => x.c), e9 = ema(c, 9), e21 = ema(c, 21), e200 = ema(c, 200), A = atr(b), tr = trendSeries(d.htf), al = aligner(d.htf, H4), sigs = [];
    for (let i = 210; i < b.length; i++) { const j = al(b[i].t + M15); if (j < 0) continue; const dir = tr[j]; if (!dir || dir * (c[i] - e200[i]) <= 0) continue;
      if (!(dir * (e9[i] - e21[i]) > 0 && dir * (e9[i - 1] - e21[i - 1]) <= 0)) continue;
      sigs.push({ i, dir, riskAbs: 1.5 * A[i], rr: 2, maxBars: 96 }); }
    return simulate(b, sigs, M15);
  },
  'C｜對照：1H Supertrend(14,3) 翻轉（4H 順勢）｜反向才出': flipStrat(b => supertrend(b, 14, 3), 'h4', 99),
};
// ---- 統計 ----
function cap(all, n) { const acc = [], open = []; for (const r of [...all].sort((a, b) => a.inT - b.inT)) { while (open.length && open[0] <= r.inT) open.shift(); if (open.length >= n) continue; acc.push(r); open.push(r.t); open.sort((a, b) => a - b); } return acc; }
function stat(q, t0) {
  q = q.filter(r => r.inT >= t0).sort((a, b) => a.t - b.t); if (!q.length) return null;
  let e = 0, p = 0, dd = 0, streak = 0, maxStreak = 0; const mon = {};
  for (const r of q) { e += r.R; p = Math.max(p, e); dd = Math.min(dd, e - p); streak = r.R < 0 ? streak + 1 : 0; maxStreak = Math.max(maxStreak, streak); const m = new Date(r.t).toISOString().slice(0, 7); mon[m] = (mon[m] || 0) + r.R; }
  const y = yr => q.filter(r => new Date(r.t).getUTCFullYear() === yr).reduce((a, r) => a + r.R, 0);
  const ms = Object.values(mon), months = ms.length;
  return { n: q.length, win: q.filter(r => r.R > 0).length / q.length, y25: y(2025), y26: y(2026), tot: e, dd, avg: e / q.length, hold: q.reduce((a, r) => a + r.hold, 0) / q.length, perMon: q.length / months, posMon: ms.filter(x => x > 0).length, months, maxStreak };
}
const f = (x, d = 1) => (x >= 0 ? '+' : '') + x.toFixed(d);


// 可調參數版（給 robust2.js 換參數用）
const flipST = (n, k) => flipStrat(b => supertrend(b, n, k), 'h4', 99);
const donchian = (nb, am) => (d) => {
  const b = d.ltf, A = atr(b), hN = hiN(b, nb), lN = loN(b, nb), xh = Math.max(5, Math.round(nb / 2)), hX = hiN(b, xh), lX = loN(b, xh), tr = trendSeries(d.htf), al = aligner(d.htf, H4), sigs = [];
  for (let i = 210; i < b.length; i++) { const j = al(b[i].t + H); if (j < 0) continue; const dir = tr[j]; if (!dir) continue;
    const brk = dir > 0 ? b[i].c > hN[i - 1] && b[i - 1].c <= hN[i - 2] : b[i].c < lN[i - 1] && b[i - 1].c >= lN[i - 2]; if (!brk) continue;
    sigs.push({ i, dir, riskAbs: am * A[i], rr: 3, maxBars: 24, flip: k => dir > 0 ? b[k].c < lX[k - 1] : b[k].c > hX[k - 1] }); }
  return simulate(b, sigs, H);
};
module.exports = { S, stat, cap, H, load, flipST, donchian };
if (require.main === module) (async () => {
  const data = await load();
  const syms = Object.keys(data).filter(s => data[s].htf && data[s].htf.length > 400 && data[s].ltf && data[s].ltf.length > 1000);
  for (const s of syms) if (data[s].m15 && Array.isArray(data[s].m15[0])) data[s].m15 = data[s].m15.map(r => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] }));
  const t0 = Date.UTC(2025, 0, 1), rows = [], runs = {};
  let md = `# 短線策略第二批（${EXCHANGE}，${syms.length} 幣，2025-01-01 起，手續費 0.022%×2，每筆最多抱 1 天）\n\nTradingView 常見的指標策略，都是 1H（L1 是 15M）。單位 R＝每筆止損的金額。「同時 5 筆」＝同一時間最多 5 筆。最後一列是之前的 1H Supertrend 當對照。\n\n`;
  md += '| 策略 | 組別 | 筆數 | 每月幾筆 | 平均抱幾小時 | 勝率 | 平均每筆 | 2025 | 2026 | 合計 | 最大回撤 | 賺錢月份 | 最長連虧 |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|\n';
  for (const [name, fn] of Object.entries(S)) {
    let all = []; for (const s of syms) { try { all = all.concat(fn(data[s]).map(r => ({ ...r, sym: s }))); } catch (e) { console.error(name, s, e.message); } }
    runs[name] = all;
    for (const [g, q] of [['不限', all], ['同時 5 筆', cap(all, 5)]]) {
      const x = stat(q, t0); if (!x) { md += `| ${name} | ${g} | 0 |\n`; continue; }
      md += `| ${name} | ${g} | ${x.n} | ${x.perMon.toFixed(0)} | ${x.hold.toFixed(1)} | ${(x.win * 100).toFixed(0)}% | ${f(x.avg, 3)}R | ${f(x.y25)}R | ${f(x.y26)}R | ${f(x.tot)}R | ${x.dd.toFixed(1)}R | ${x.posMon}/${x.months} | ${x.maxStreak} |\n`;
      rows.push({ name, g, ...x });
    }
    console.log(name, 'done', all.length);
  }
  const ok = rows.filter(r => r.g === '同時 5 筆' && r.y25 > 0 && r.y26 > 0);
  md += `\n**兩年都賺（同時 5 筆）**：${ok.length ? ok.map(r => r.name).join('、') : '沒有'}\n`;
  // 兩年都賺的：隨機打亂同一小時內進場順序 200 次 + 手續費加倍
  if (ok.length) md += `\n## 穩定度（兩年都賺的才測）\n\n| 策略 | 打亂 200 次：合計賺錢 | 兩年都賺 | 中位數 | 最差 5% | 手續費 0.05%：2025 | 2026 |\n|---|---|---|---|---|---|---|\n`;
  for (const r of ok) {
    const all = runs[r.name].filter(x => x.inT >= t0); let pos = 0, both = 0; const tots = [];
    for (let k = 0; k < 200; k++) { const sh = all.map(x => ({ ...x, key: x.inT + Math.random() * H * 0.999 })).sort((a, b) => a.key - b.key); const acc = [], open = [];
      for (const x of sh) { while (open.length && open[0] <= x.inT) open.shift(); if (open.length >= 5) continue; acc.push(x); open.push(x.t); open.sort((a, b) => a - b); }
      const s = stat(acc, t0); tots.push(s.tot); if (s.tot > 0) pos++; if (s.y25 > 0 && s.y26 > 0) both++; }
    tots.sort((a, b) => a - b);
    global.__FEE = 0.05 / 100; let all2 = []; for (const s of syms) { try { all2 = all2.concat(S[r.name](data[s])); } catch (e) {} } global.__FEE = undefined;
    const hf = stat(cap(all2, 5), t0);
    md += `| ${r.name} | ${pos}/200 | ${both}/200 | ${f(tots[100])}R | ${f(tots[10])}R | ${f(hf.y25)}R | ${f(hf.y26)}R |\n`;
  }
  console.log(md); fs.writeFileSync(OUT, md);
})().catch(e => { console.error(e); fs.writeFileSync(OUT.replace('.md', '-error.md'), String(e.stack)); process.exit(1); });
