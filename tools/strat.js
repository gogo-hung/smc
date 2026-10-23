// 高勝率候選策略回測：A 順勢回檔、B 區間均值回歸（1H 進場、4H 判斷大方向／盤整）
// 訊號在 1H 收盤確認，下一根開盤市價進場；止損／止盈用 ATR；同一根同時碰到止損止盈算止損；超過 maxBars 根收盤出場
const fs = require('fs'), path = require('path');
const { load, DAYS, EXCHANGE } = require('./hist');
let FEE = 0.05 / 100;   // 市價單單邊（下面會換不同費率各跑一次）

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

// ---- 策略 ----
// A 順勢回檔：4H 收盤在 EMA200 上、EMA50 > EMA200 → 只做多；1H RSI 跌破 rsiLo 後重新站回（或直接在超賣時）進場
// B 區間均值回歸：4H ADX < adxMax（盤整）；1H 收盤跌出布林下軌且 RSI < 30 做多，止盈回到中軌
const CONFIGS = [
  { name: 'A 順勢回檔｜RSI<30｜止損 1.5ATR｜止盈 1ATR', type: 'A', rsi: 30, sl: 1.5, tp: 1, maxBars: 24 },
  { name: 'A 順勢回檔｜RSI<30｜止損 2ATR｜止盈 1ATR', type: 'A', rsi: 30, sl: 2, tp: 1, maxBars: 24 },
  { name: 'A 順勢回檔｜RSI<25｜止損 2ATR｜止盈 1ATR', type: 'A', rsi: 25, sl: 2, tp: 1, maxBars: 24 },
  { name: 'A 順勢回檔｜RSI<30｜止損 2ATR｜止盈回到 1H EMA20', type: 'A', rsi: 30, sl: 2, tp: 'ema', maxBars: 24 },
  { name: 'B 區間回歸｜4H ADX<20｜止損 1.5ATR｜止盈中軌', type: 'B', adx: 20, sl: 1.5, tp: 'mid', maxBars: 24 },
  { name: 'B 區間回歸｜4H ADX<20｜止損 2ATR｜止盈中軌', type: 'B', adx: 20, sl: 2, tp: 'mid', maxBars: 24 },
  { name: 'B 區間回歸｜4H ADX<25｜止損 2ATR｜止盈中軌', type: 'B', adx: 25, sl: 2, tp: 'mid', maxBars: 24 },
  { name: 'B 區間回歸｜4H ADX<20｜止損 2ATR｜止盈 1ATR', type: 'B', adx: 20, sl: 2, tp: 1, maxBars: 24 },
];

function run(sym, h1, h4, cf) {
  const c1 = h1.map(b => b.c), c4 = h4.map(b => b.c), H4 = 4 * 3600e3, H1 = 3600e3;
  const e50 = emaArr(c4, 50), e200 = emaArr(c4, 200), adx4 = adxArr(h4, 14);
  const rsi = rsiArr(c1, 14), atr = atrArr(h1, 14), e20 = emaArr(c1, 20), mid = smaArr(c1, 20), sd = stdArr(c1, 20, mid);
  const out = []; let k = -1, busy = -1;
  for (let i = 210; i < h1.length - 1; i++) {
    const T = h1[i].t + H1; while (k + 1 < h4.length && h4[k + 1].t + H4 <= T) k++;
    if (k < 210 || i <= busy || atr[i] == null) continue;
    let dir = 0;
    if (cf.type === 'A') {
      const up = c4[k] > e200[k] && e50[k] > e200[k], dn = c4[k] < e200[k] && e50[k] < e200[k];
      if (up && rsi[i] < cf.rsi) dir = 1; else if (dn && rsi[i] > 100 - cf.rsi) dir = -1;
    } else {
      if (adx4[k] == null || adx4[k] >= cf.adx || sd[i] == null) continue;
      if (c1[i] < mid[i] - 2 * sd[i] && rsi[i] < 30) dir = 1; else if (c1[i] > mid[i] + 2 * sd[i] && rsi[i] > 70) dir = -1;
    }
    if (!dir) continue;
    const j0 = i + 1, E = h1[j0].o, a = atr[i], stop = E - dir * a * cf.sl;
    let res = null;
    for (let j = j0; j < h1.length; j++) { const b = h1[j];
      const tgt = cf.tp === 'mid' ? mid[j - 1] : cf.tp === 'ema' ? e20[j - 1] : E + dir * a * cf.tp;   // 動態止盈用上一根收盤時的值
      if (dir > 0 ? b.l <= stop : b.h >= stop) { res = { x: stop, j }; break; }
      if (tgt != null && (dir > 0 ? tgt > E && b.h >= tgt : tgt < E && b.l <= tgt)) { res = { x: tgt, j }; break; }
      if (j - j0 + 1 >= cf.maxBars) { res = { x: b.c, j }; break; }
    }
    if (!res) break;
    const risk = Math.abs(E - stop), R = (res.x - E) * dir / risk - 2 * FEE * E / risk;
    out.push({ sym, t: h1[res.j].t, R, dir }); busy = res.j;
  }
  return out;
}

(async () => {
  const data = await load(); const syms = Object.keys(data).filter(s => data[s].ltf && data[s].ltf.length > 500 && data[s].htf.length > 400);
  const T6 = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE'].filter(s => syms.includes(s));
  const f1 = v => (v > 0 ? '+' : '') + v.toFixed(1), pct = (a, b) => b ? `${(a / b * 100).toFixed(0)}%` : '—';
  const t0 = Math.min(...syms.map(s => data[s].ltf[210].t)), t1 = Math.max(...syms.map(s => data[s].ltf[data[s].ltf.length - 1].t)), yrs = (t1 - t0) / (365 * 864e5);
  const out = [`# 高勝率候選策略（${EXCHANGE}，${new Date(t0).toISOString().slice(0, 10)} ～ ${new Date(t1).toISOString().slice(0, 10)}，${syms.length} 個幣，市價手續費兩種費率）`, '',
    '標準：勝率 ≥ 60%、最長連虧 ≤ 5、2025 和 2026 都賺、卡瑪 > 1（R 當 %，每筆風險 1%）', '',
    '| 策略 | 幣 | 筆數 | 每月幾筆 | 勝率 | 2025 | 2026 | 全部 | 每筆平均 | 最大回撤 | 最長連虧 | 卡瑪 | 賺錢月份 |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const [feeName, fee] of [['你的費率 0.022%', 0.022], ['完全沒手續費', 0]]) { FEE = fee / 100; out.push('', `**${feeName}**`, '', out[4], out[5]);
  for (const cf of CONFIGS) {
    let all = []; for (const s of syms) all = all.concat(run(s, data[s].ltf, data[s].htf, cf));
    for (const [g, l] of [['全部', syms], ['前 6 大', T6]]) {
      const q = all.filter(r => l.includes(r.sym)).sort((a, b) => a.t - b.t);
      let e = 0, p = 0, d = 0, st = 0, ms = 0; for (const r of q) { e += r.R; p = Math.max(p, e); d = Math.min(d, e - p); st = r.R <= 0 ? st + 1 : 0; ms = Math.max(ms, st); }
      const y = yr => f1(q.filter(r => new Date(r.t).getUTCFullYear() === yr).reduce((a, r) => a + r.R, 0));
      const mo = {}; for (const r of q) { const k = new Date(r.t + 8 * 3600e3).toISOString().slice(0, 7); mo[k] = (mo[k] || 0) + r.R; } const mv = Object.values(mo);
      const cal = d < 0 ? (e / yrs) / -d : 0;
      out.push(`| ${cf.name} | ${g} | ${q.length} | ${(q.length / yrs / 12).toFixed(0)} | ${pct(q.filter(r => r.R > 0).length, q.length)} | ${y(2025)} | ${y(2026)} | ${f1(e)} | ${q.length ? (e / q.length).toFixed(3) : '—'} | ${d.toFixed(1)} | ${ms} | ${cal.toFixed(2)} | ${mv.filter(v => v > 0).length} / ${mv.length} |`);
    }
    console.log(cf.name, 'done');
  } }
  out.splice(4, 2); const md = out.join('\n'); console.log(md);
  fs.writeFileSync(path.join(__dirname, '..', 'research-cache', `strat-${EXCHANGE}-${DAYS}.md`), md);
})().catch(e => { console.error(e); fs.mkdirSync(path.join(__dirname, '..', 'research-cache'), { recursive: true }); fs.writeFileSync(path.join(__dirname, '..', 'research-cache', 'strat-error.md'), String(e.stack)); process.exit(1); });
