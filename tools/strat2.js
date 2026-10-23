// 指標策略：均線、MACD、RSI、成交量，在 4H／日線上
const fs = require('fs'), path = require('path');
const { load, DAYS, EXCHANGE } = require('./hist');
// ---- 指標（只用到第 i 根為止的資料） ----
const emaArr = (v, n) => { const o = Array(v.length).fill(null), k = 2 / (n + 1); let e = null, s = 0; for (let i = 0; i < v.length; i++) { if (i < n - 1) { s += v[i]; continue; } if (e === null) e = (s + v[i]) / n; else e = v[i] * k + e * (1 - k); o[i] = e; } return o; };
const smaArr = (v, n) => { const o = Array(v.length).fill(null); let s = 0; for (let i = 0; i < v.length; i++) { s += v[i]; if (i >= n) s -= v[i - n]; if (i >= n - 1) o[i] = s / n; } return o; };
const stdArr = (v, n, m) => { const o = Array(v.length).fill(null); for (let i = n - 1; i < v.length; i++) { let s = 0; for (let j = i - n + 1; j <= i; j++) s += (v[j] - m[i]) ** 2; o[i] = Math.sqrt(s / n); } return o; };
function rsiArr(c, n = 14) { const o = Array(c.length).fill(null); let g = 0, l = 0; for (let i = 1; i < c.length; i++) { const d = c[i] - c[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0);
  if (i <= n) { g += up; l += dn; if (i === n) { g /= n; l /= n; o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } } else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } } return o; }
function atrArr(b, n = 14) { const o = Array(b.length).fill(null); let a = null; for (let i = 1; i < b.length; i++) { const tr = Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
  a = a === null ? tr : (a * (n - 1) + tr) / n; if (i >= n) o[i] = a; } return o; }
function adxArr(b, n = 14) { const o = Array(b.length).fill(null); let tr = 0, pd = 0, md = 0, adx = null, cnt = 0, dxs = [];
  for (let i = 1; i < b.length; i++) { const up = b[i].h - b[i - 1].h, dn = b[i - 1].l - b[i].l, t = Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
    const p = up > dn && up > 0 ? up : 0, m = dn > up && dn > 0 ? dn : 0;
    if (i <= n) { tr += t; pd += p; md += m; if (i < n) continue; } else { tr = tr - tr / n + t; pd = pd - pd / n + p; md = md - md / n + m; }
    const pdi = 100 * pd / tr, mdi = 100 * md / tr, dx = pdi + mdi ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0;
    if (adx === null) { dxs.push(dx); if (dxs.length === n) adx = dxs.reduce((a, x) => a + x, 0) / n; } else adx = (adx * (n - 1) + dx) / n;
    o[i] = adx; }
  return o; }


// 4H／日線指標策略：訊號在收盤確認，下一根開盤市價進場
// 出場：固定止損＋（固定止盈 或 移動止損：從持倉後最高點回落 trail 倍 ATR）
const toDaily = h4 => { const D = 864e5, o = []; let c = null; for (const b of h4) { const d = Math.floor(b.t / D) * D; if (!c || c.t !== d) { if (c) o.push(c); c = { t: d, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, n: 1 }; } else { c.h = Math.max(c.h, b.h); c.l = Math.min(c.l, b.l); c.c = b.c; c.v += b.v; c.n++; } } if (c && c.n === 6) o.push(c); return o; };
const CONFIGS = [
  { name: '① 4H 趨勢＋MACD 金叉＋爆量｜移動止損', tf: '4h', sig: 'macdVol', sl: 2, trail: 3 },
  { name: '② 4H 趨勢＋MACD 金叉＋爆量｜1:1 固定止盈', tf: '4h', sig: 'macdVol', sl: 2, tp: 2 },
  { name: '③ 4H 順勢回檔（EMA50>200、RSI<35）｜止損 2ATR 止盈 1ATR', tf: '4h', sig: 'pull', sl: 2, tp: 1 },
  { name: '④ 4H 順勢回檔＋縮量＋MACD 柱翻正才進｜止損 2ATR 止盈 1ATR', tf: '4h', sig: 'pullConf', sl: 2, tp: 1 },
  { name: '⑤ 日線 EMA20 穿 EMA50＋量｜移動止損', tf: '1d', sig: 'cross', sl: 2, trail: 3 },
  { name: '⑥ 日線順勢回檔（價在 EMA50 上、RSI<40）｜止損 2ATR 止盈 1ATR', tf: '1d', sig: 'pullD', sl: 2, tp: 1 },
];
function run(sym, bars, cf) {
  const c = bars.map(b => b.c), v = bars.map(b => b.v);
  const e20 = emaArr(c, 20), e50 = emaArr(c, 50), e200 = emaArr(c, 200), rsi = rsiArr(c, 14), atr = atrArr(bars, 14), vma = smaArr(v, 20);
  const m12 = emaArr(c, 12), m26 = emaArr(c, 26), macd = c.map((_, i) => m12[i] != null && m26[i] != null ? m12[i] - m26[i] : null);
  const sigL = emaArr(macd.map(x => x ?? 0), 9), hist = macd.map((x, i) => x == null ? null : x - sigL[i]);
  const out = []; let busy = -1; const st = cf.tf === '1d' ? 60 : 210;
  for (let i = st; i < bars.length - 1; i++) {
    if (i <= busy || atr[i] == null || hist[i - 1] == null) continue;
    let dir = 0; const up = e50[i] > (e200[i] ?? Infinity) && c[i] > e50[i], dn = e50[i] < (e200[i] ?? -Infinity) && c[i] < e50[i];
    if (cf.sig === 'macdVol') { if (up && hist[i - 1] <= 0 && hist[i] > 0 && v[i] > 1.5 * vma[i]) dir = 1; else if (dn && hist[i - 1] >= 0 && hist[i] < 0 && v[i] > 1.5 * vma[i]) dir = -1; }
    else if (cf.sig === 'pull') { const u = e50[i] > e200[i], d = e50[i] < e200[i]; if (u && rsi[i] < 35) dir = 1; else if (d && rsi[i] > 65) dir = -1; }
    else if (cf.sig === 'pullConf') { const u = e50[i] > e200[i], d = e50[i] < e200[i], lo = Math.min(...rsi.slice(i - 3, i + 1)), hi = Math.max(...rsi.slice(i - 3, i + 1)), quiet = v.slice(i - 3, i + 1).reduce((a, x) => a + x, 0) / 4 < vma[i];
      if (u && lo < 35 && quiet && hist[i - 1] <= hist[i] && hist[i - 1] < 0 && hist[i] > hist[i - 1]) dir = 1; else if (d && hi > 65 && quiet && hist[i - 1] > 0 && hist[i] < hist[i - 1]) dir = -1; }
    else if (cf.sig === 'cross') { if (e20[i - 1] <= e50[i - 1] && e20[i] > e50[i] && v[i] > vma[i]) dir = 1; else if (e20[i - 1] >= e50[i - 1] && e20[i] < e50[i] && v[i] > vma[i]) dir = -1; }
    else if (cf.sig === 'pullD') { if (c[i] > e50[i] && e20[i] > e50[i] && rsi[i] < 40) dir = 1; else if (c[i] < e50[i] && e20[i] < e50[i] && rsi[i] > 60) dir = -1; }
    if (!dir) continue;
    const j0 = i + 1, E = bars[j0].o, a = atr[i], stop0 = E - dir * a * cf.sl; let stop = stop0, ext = E, res = null;
    for (let j = j0; j < bars.length; j++) { const b = bars[j];
      if (dir > 0 ? b.l <= stop : b.h >= stop) { res = { x: stop, j }; break; }
      if (cf.tp && (dir > 0 ? b.h >= E + a * cf.tp : b.l <= E - a * cf.tp)) { res = { x: E + dir * a * cf.tp, j }; break; }
      if (cf.trail) { ext = dir > 0 ? Math.max(ext, b.h) : Math.min(ext, b.l); const ns = ext - dir * a * cf.trail; if (dir > 0 ? ns > stop : ns < stop) stop = ns; }
    }
    if (!res) break;
    const risk = Math.abs(E - stop0);
    out.push({ sym, t: bars[res.j].t, R: (res.x - E) * dir / risk, cost: 2 * E / risk }); busy = res.j;
  }
  return out;
}
(async () => {
  const data = await load(); const syms = Object.keys(data).filter(s => data[s].htf && data[s].htf.length > 400);
  const T6 = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE'].filter(s => syms.includes(s));
  const f1 = v => (v > 0 ? '+' : '') + v.toFixed(1), pct = (a, b) => b ? `${(a / b * 100).toFixed(0)}%` : '—';
  const t0 = Date.UTC(2025, 0, 1), t1 = Math.max(...syms.map(s => data[s].htf[data[s].htf.length - 1].t)), yrs = (t1 - t0) / (365 * 864e5);
  const out = [`# 指標策略（均線、MACD、RSI、成交量）4H／日線（${EXCHANGE}，2025-01-01 ～ ${new Date(t1).toISOString().slice(0, 10)}，${syms.length} 個幣，手續費 0.022%×2）`, '',
    '標準：2025、2026 都賺、卡瑪 > 1；「沒手續費」那欄是同樣的單不扣手續費的累計', '',
    '| 策略 | 幣 | 筆數 | 每月幾筆 | 勝率 | 2025 | 2026 | 全部 | 沒手續費 | 每筆平均 | 最大回撤 | 最長連虧 | 卡瑪 | 賺錢月份 |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const cf of CONFIGS) {
    let all = []; for (const s of syms) { const b = cf.tf === '1d' ? toDaily(data[s].htf) : data[s].htf; if (b.length > 80) all = all.concat(run(s, b, cf)); }
    all = all.filter(r => r.t >= t0); for (const r of all) { r.R0 = r.R; r.R -= 0.022 / 100 * r.cost; }
    for (const [g, l] of [['全部', syms], ['前 6 大', T6]]) {
      const q = all.filter(r => l.includes(r.sym)).sort((a, b) => a.t - b.t);
      let e = 0, p = 0, d = 0, s = 0, ms = 0; for (const r of q) { e += r.R; p = Math.max(p, e); d = Math.min(d, e - p); s = r.R <= 0 ? s + 1 : 0; ms = Math.max(ms, s); }
      const y = yr => f1(q.filter(r => new Date(r.t).getUTCFullYear() === yr).reduce((a, r) => a + r.R, 0));
      const mo = {}; for (const r of q) { const k = new Date(r.t + 8 * 3600e3).toISOString().slice(0, 7); mo[k] = (mo[k] || 0) + r.R; } const mv = Object.values(mo);
      out.push(`| ${cf.name} | ${g} | ${q.length} | ${(q.length / yrs / 12).toFixed(1)} | ${pct(q.filter(r => r.R > 0).length, q.length)} | ${y(2025)} | ${y(2026)} | ${f1(e)} | ${f1(q.reduce((a, r) => a + r.R0, 0))} | ${q.length ? (e / q.length).toFixed(3) : '—'} | ${d.toFixed(1)} | ${ms} | ${d < 0 ? ((e / yrs) / -d).toFixed(2) : '—'} | ${mv.filter(x => x > 0).length} / ${mv.length} |`);
    }
  }
  const md = out.join('\n'); console.log(md);
  fs.writeFileSync(path.join(__dirname, '..', 'research-cache', `strat2-${EXCHANGE}.md`), md);
})().catch(e => { console.error(e); fs.writeFileSync(path.join(__dirname, '..', 'research-cache', 'strat2-error.md'), String(e.stack)); process.exit(1); });
