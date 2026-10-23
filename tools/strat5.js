// 4H 用均線／MACD／RSI／成交量判斷方向狀態，1H 回檔後吞沒K進場
const fs = require('fs'), path = require('path');
const { load, DAYS, EXCHANGE } = require('./hist');
const SMC = require('../src/smc');
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

const capN = (q, n) => { const acc = [], open = []; for (const r of [...q].sort((a, b) => a.inT - b.inT)) { while (open.length && open[0] <= r.inT) open.shift(); if (open.length >= n) continue; acc.push(r); open.push(r.t); open.sort((a, b) => a - b); } return acc; };

const FEE = 0.022 / 100;
const B3 = { pull: 1, vol: 1, stop: 'bar', exit: 'half' };
const CONFIGS = [
  { name: '1 4H 方向＋1H 吞沒', pull: 0, vol: 0, stop: 'bar', exit: 'half' },
  { name: '2 ＋先回檔（1H RSI 曾 <45）', pull: 1, vol: 0, stop: 'bar', exit: 'half' },
  { name: '3 ＋吞沒K放量', ...B3 },
  { name: '4 ＋4H RSI 50～70', ...B3, rsi4: 1 },
  { name: '5 同 3｜止損改 2ATR(1H)', ...B3, stop: 'atr' },
  { name: '6 同 3｜固定 1R 出場', ...B3, exit: 'r1' },
  { name: '7 同 3｜固定 1.5R 出場', ...B3, exit: 'r15' },
  { name: '8 同 3｜純移動止損', ...B3, exit: 'trail' },
];
function run(sym, h1, h4, cf) {
  const H4 = 4 * 3600e3, H1 = 3600e3;
  const c4 = h4.map(b => b.c), e50 = emaArr(c4, 50), e200 = emaArr(c4, 200), r4 = rsiArr(c4, 14);
  const m12 = emaArr(c4, 12), m26 = emaArr(c4, 26), macd = c4.map((_, i) => m12[i] != null && m26[i] != null ? m12[i] - m26[i] : null), sg = emaArr(macd.map(x => x ?? 0), 9), hist = macd.map((x, i) => x == null ? null : x - sg[i]);
  const c1 = h1.map(b => b.c), r1 = rsiArr(c1, 14), a1 = atrArr(h1, 14), v1 = smaArr(h1.map(b => b.v), 20);
  const out = []; let k = -1, busy = -1;
  for (let i = 30; i < h1.length - 1; i++) {
    const T = h1[i].t + H1; while (k + 1 < h4.length && h4[k + 1].t + H4 <= T) k++;
    if (k < 210 || i <= busy || a1[i] == null || hist[k] == null) continue;
    let dir = 0;
    if (e50[k] > e200[k] && c4[k] > e50[k] && hist[k] > 0 && (!cf.rsi4 || (r4[k] >= 50 && r4[k] <= 70))) dir = 1;
    else if (e50[k] < e200[k] && c4[k] < e50[k] && hist[k] < 0 && (!cf.rsi4 || (r4[k] <= 50 && r4[k] >= 30))) dir = -1;
    if (!dir || !SMC.isEngulf(h1, i, dir)) continue;
    if (cf.pull) { let ok = false; for (let j = i - 6; j <= i; j++) if (r1[j] != null && (dir > 0 ? r1[j] < 45 : r1[j] > 55)) ok = true; if (!ok) continue; }
    if (cf.vol && !(h1[i].v > 1.2 * v1[i])) continue;
    const j0 = i + 1, E = h1[j0].o, a = a1[i];
    const stop0 = cf.stop === 'atr' ? E - dir * 2 * a : (dir > 0 ? Math.min(h1[i].l, h1[i - 1].l) - 0.5 * a : Math.max(h1[i].h, h1[i - 1].h) + 0.5 * a);
    if (dir > 0 ? stop0 >= E : stop0 <= E) continue;
    const risk = Math.abs(E - stop0); let stop = stop0, ext = E, mae = 0, got = 0, size = 1, hd = false, res = null;
    const tp = cf.exit === 'r1' ? 1 : cf.exit === 'r15' ? 1.5 : null;
    for (let j = j0; j < h1.length; j++) { const b = h1[j];
      mae = Math.max(mae, dir > 0 ? (E - b.l) / E : (b.h - E) / E);
      if (dir > 0 ? b.l <= stop : b.h >= stop) { res = { R: got + size * (stop - E) * dir / risk, j }; break; }
      if (tp && (dir > 0 ? b.h >= E + risk * tp : b.l <= E - risk * tp)) { res = { R: tp, j }; break; }
      if (cf.exit === 'half' && !hd && (dir > 0 ? b.h >= E + risk : b.l <= E - risk)) { hd = true; got = 0.5; size = 0.5; if (dir > 0 ? E > stop : E < stop) stop = E; }
      if (cf.exit === 'half' || cf.exit === 'trail') { ext = dir > 0 ? Math.max(ext, b.h) : Math.min(ext, b.l); const ns = ext - dir * a * 3; if (dir > 0 ? ns > stop : ns < stop) stop = ns; }
    }
    if (!res) break;
    out.push({ sym, inT: h1[j0].t, t: h1[res.j].t + H1, R: res.R - 2 * FEE * E / risk, mae: mae * 100, hours: res.j - j0 + 1, riskPct: risk / E * 100 }); busy = res.j;
  }
  return out;
}
(async () => {
  const data = await load(); const syms = Object.keys(data).filter(s => data[s].htf && data[s].htf.length > 400 && data[s].ltf && data[s].ltf.length > 1000);
  const T6 = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE'].filter(s => syms.includes(s));
  const f1 = v => (v > 0 ? '+' : '') + v.toFixed(1), pct = (a, b) => b ? `${(a / b * 100).toFixed(0)}%` : '—';
  const t0 = Date.UTC(2025, 0, 1), t1 = Math.max(...syms.map(s => data[s].ltf[data[s].ltf.length - 1].t)), yrs = (t1 - t0) / (365 * 864e5);
  const out = [`# 4H 方向（均線／MACD／RSI）＋ 1H 回檔吞沒進場（${EXCHANGE}，2025-01-01 ～ ${new Date(t1).toISOString().slice(0, 10)}，${syms.length} 個幣，手續費 0.022%×2）`, '',
    '| 設定 | 幣 | 筆數 | 每月 | 勝率 | 2025 | 2026 | 全部 | 每筆平均 | 最大回撤 | 最長連虧 | 卡瑪 | 賺錢月份 | 止損距離 | 平均浮虧 | 平均持倉 |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|'];
  const row = (name, g, q) => { q = [...q].sort((a, b) => a.t - b.t); let e = 0, p = 0, d = 0, s = 0, ms = 0; for (const r of q) { e += r.R; p = Math.max(p, e); d = Math.min(d, e - p); s = r.R <= 0 ? s + 1 : 0; ms = Math.max(ms, s); }
    const y = yr => f1(q.filter(r => new Date(r.t).getUTCFullYear() === yr).reduce((a, r) => a + r.R, 0)); const avg = k => q.length ? q.reduce((a, r) => a + r[k], 0) / q.length : 0;
    const mo = {}; for (const r of q) { const k = new Date(r.t + 8 * 3600e3).toISOString().slice(0, 7); mo[k] = (mo[k] || 0) + r.R; } const mv = Object.values(mo);
    out.push(`| ${name} | ${g} | ${q.length} | ${(q.length / yrs / 12).toFixed(1)} | ${pct(q.filter(r => r.R > 0).length, q.length)} | ${y(2025)} | ${y(2026)} | ${f1(e)} | ${q.length ? (e / q.length).toFixed(3) : '—'} | ${d.toFixed(1)} | ${ms} | ${d < 0 ? ((e / yrs) / -d).toFixed(2) : '—'} | ${mv.filter(x => x > 0).length} / ${mv.length} | ${avg('riskPct').toFixed(2)}% | ${avg('mae').toFixed(2)}% | ${avg('hours').toFixed(0)} 小時 |`); };
  for (const cf of CONFIGS) {
    let all = []; for (const s of syms) all = all.concat(run(s, data[s].ltf, data[s].htf, cf)); all = all.filter(r => r.inT >= t0);
    row(cf.name, '全部', all); row(cf.name, '全部｜同時最多 5 筆', capN(all, 5)); row(cf.name, '前 6 大', all.filter(r => T6.includes(r.sym)));
  }
  const md = out.join('\n'); console.log(md);
  fs.writeFileSync(path.join(__dirname, '..', 'research-cache', `strat5-${EXCHANGE}.md`), md);
})().catch(e => { console.error(e); fs.writeFileSync(path.join(__dirname, '..', 'research-cache', 'strat5-error.md'), String(e.stack)); process.exit(1); });
