// 策略① 4H 訊號 ＋ 小週期找進場（限價回踩、1H EMA20、15M BOS）；出場在 15M 上模擬
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


const FEE = 0.022 / 100;
// 4H 訊號＝策略①；止損價（base）＝訊號收盤 − 2ATR（跟直接進場同一個價位），小週期只負責找更好的進場價
const CONFIGS = [
  { name: '基準：4H 收盤直接進場', entry: 'mkt', stop: 'base' },
  { name: '① 限價掛訊號K 50%', entry: 'lim50', stop: 'base' },
  { name: '② 限價掛收盤往回 0.5ATR', entry: 'limAtr', stop: 'base' },
  { name: '③ 1H 回踩 EMA20 收盤站回', entry: 'ema1h', stop: 'base' },
  { name: '④ 15M 回檔後同方向 BOS', entry: 'bos15', stop: 'base' },
  { name: '④ 15M BOS＋1R 平一半保本', entry: 'bos15', stop: 'base', half: 1 },
  { name: '① 限價 50%＋止損縮到訊號K外', entry: 'lim50', stop: 'bar' },
];
const WIN = 48;   // 4H 收盤後 12 小時內（48 根 15M）沒進場就放棄
function run(sym, m15, h1, h4, cf, L15) {
  const H4 = 4 * 3600e3, i15 = new Map(m15.map((b, i) => [b.t, i])), i1 = new Map(h1.map((b, i) => [b.t, i]));
  const e20 = emaArr(h1.map(b => b.c), 20), out = []; let busyT = -1, sigs = signals(h4), evIdx = 0;
  const bosAt = new Map(); for (const e of L15.events) if (!bosAt.has(e.idx)) bosAt.set(e.idx, e);
  for (const s of sigs) {
    const sb = h4[s.i], closeT = sb.t + H4; if (closeT <= busyT) continue;
    const j0 = i15.get(closeT); if (j0 == null) continue;
    const dir = s.dir, a = s.atr, base = sb.c - dir * 2 * a, stop0 = cf.stop === 'bar' ? (dir > 0 ? sb.l : sb.h) - dir * 0.2 * a : base;
    let jE = -1, E = null;
    const lim = cf.entry === 'lim50' ? (sb.h + sb.l) / 2 : cf.entry === 'limAtr' ? sb.c - dir * 0.5 * a : null;
    for (let j = j0; j < Math.min(m15.length, j0 + WIN); j++) { const b = m15[j];
      if (cf.entry === 'mkt') { jE = j; E = b.o; break; }
      if (dir > 0 ? b.l <= stop0 : b.h >= stop0) break;   // 還沒進場就先打到止損價：放棄
      if (lim != null) { if (dir > 0 ? b.l <= lim : b.h >= lim) { jE = j; E = dir > 0 ? Math.min(b.o, lim) : Math.max(b.o, lim); break; } continue; }
      if (cf.entry === 'ema1h') { if ((b.t + 900e3) % 3600e3 !== 0) continue; const k = i1.get(b.t - 2700e3); if (k == null || e20[k] == null) continue; const h = h1[k];
        if (dir > 0 ? h.l <= e20[k] && h.c > e20[k] : h.h >= e20[k] && h.c < e20[k]) { if (j + 1 < m15.length) { jE = j + 1; E = m15[j + 1].o; } break; } continue; }
      if (cf.entry === 'bos15') { const e = bosAt.get(j); if (e && e.dir === dir && m15[e.from] && m15[e.from].t >= closeT - 900e3) { if (j + 1 < m15.length) { jE = j + 1; E = m15[j + 1].o; } break; } }
    }
    if (jE < 0 || (dir > 0 ? E <= stop0 : E >= stop0)) { out.push({ sym, miss: true, inT: closeT }); continue; }
    const risk = Math.abs(E - stop0); let stop = stop0, ext = E, mae = 0, got = 0, size = 1, hd = false, res = null;
    for (let j = jE; j < m15.length; j++) { const b = m15[j];
      mae = Math.max(mae, dir > 0 ? (E - b.l) / E : (b.h - E) / E);
      if (dir > 0 ? b.l <= stop : b.h >= stop) { res = { R: got + size * (stop - E) * dir / risk, j }; break; }
      if (cf.half && !hd && (dir > 0 ? b.h >= E + risk : b.l <= E - risk)) { hd = true; got = 0.5; size = 0.5; if (dir > 0 ? E > stop : E < stop) stop = E; }
      ext = dir > 0 ? Math.max(ext, b.h) : Math.min(ext, b.l); const ns = ext - dir * a * 3; if (dir > 0 ? ns > stop : ns < stop) stop = ns;
    }
    if (!res) break;
    out.push({ sym, inT: m15[jE].t, t: m15[res.j].t + 900e3, R: res.R - 2 * FEE * E / risk, mae: mae * 100, hours: (res.j - jE + 1) / 4, riskPct: risk / E * 100, better: (sb.c - E) * dir / sb.c * 100 });
    busyT = m15[res.j].t + 900e3;
  }
  return out;
}
function signals(h4) {   // 策略① 的 4H 訊號：{i, dir, atr}
  const c = h4.map(b => b.c), v = h4.map(b => b.v);
  const e50 = emaArr(c, 50), e200 = emaArr(c, 200), atr = atrArr(h4, 14), vma = smaArr(v, 20);
  const m12 = emaArr(c, 12), m26 = emaArr(c, 26), macd = c.map((_, i) => m12[i] != null && m26[i] != null ? m12[i] - m26[i] : null);
  const sg = emaArr(macd.map(x => x ?? 0), 9), hist = macd.map((x, i) => x == null ? null : x - sg[i]);
  const out = [];
  for (let i = 210; i < h4.length; i++) { if (atr[i] == null || hist[i - 1] == null) continue;
    const up = e50[i] > e200[i] && c[i] > e50[i], dn = e50[i] < e200[i] && c[i] < e50[i];
    if (up && hist[i - 1] <= 0 && hist[i] > 0 && v[i] > 1.5 * vma[i]) out.push({ i, dir: 1, atr: atr[i] });
    else if (dn && hist[i - 1] >= 0 && hist[i] < 0 && v[i] > 1.5 * vma[i]) out.push({ i, dir: -1, atr: atr[i] }); }
  return out;
}
const capN = (q, n) => { const acc = [], open = []; for (const r of [...q].sort((a, b) => a.inT - b.inT)) { while (open.length && open[0] <= r.inT) open.shift(); if (open.length >= n) continue; acc.push(r); open.push(r.t); open.sort((a, b) => a - b); } return acc; };
(async () => {
  const data = await load(); const syms = Object.keys(data).filter(s => data[s].htf && data[s].htf.length > 400 && data[s].ltf && data[s].ltf.length > 1000 && data[s].m15 && data[s].m15.length > 5000);
  const T6 = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE'].filter(s => syms.includes(s));
  const f1 = v => (v > 0 ? '+' : '') + v.toFixed(1), pct = (a, b) => b ? `${(a / b * 100).toFixed(0)}%` : '—';
  const t0 = Date.UTC(2025, 0, 1), t1 = Math.max(...syms.map(s => data[s].m15[data[s].m15.length - 1].t)), yrs = (t1 - t0) / (365 * 864e5);
  const L = {}; for (const s of syms) L[s] = SMC.structure(data[s].m15, { swingLen: 3, breakBy: 'close', obInvalid: 'close' });
  const out = [`# 策略① 的 4H 訊號 ＋ 小週期找進場（${EXCHANGE}，2025-01-01 ～ ${new Date(t1).toISOString().slice(0, 10)}，${syms.length} 個幣，手續費 0.022%×2）`, '',
    '止損價都一樣（訊號收盤 − 2ATR），只換進場價；12 小時內沒進場就放棄。成交率＝有訊號後真的進場的比例；進場價改善＝比 4H 收盤價好多少 %', '',
    '| 進場方法 | 幣 | 筆數 | 成交率 | 勝率 | 2025 | 2026 | 全部 | 每筆平均 | 最大回撤 | 最長連虧 | 卡瑪 | 賺錢月份 | 止損距離 | 平均浮虧 | 進場價改善 |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|'];
  const row = (name, g, q, nSig) => { q = [...q].sort((a, b) => a.t - b.t); let e = 0, p = 0, d = 0, s = 0, ms = 0; for (const r of q) { e += r.R; p = Math.max(p, e); d = Math.min(d, e - p); s = r.R <= 0 ? s + 1 : 0; ms = Math.max(ms, s); }
    const y = yr => f1(q.filter(r => new Date(r.t).getUTCFullYear() === yr).reduce((a, r) => a + r.R, 0)); const avg = k => q.length ? q.reduce((a, r) => a + r[k], 0) / q.length : 0;
    const mo = {}; for (const r of q) { const k = new Date(r.t + 8 * 3600e3).toISOString().slice(0, 7); mo[k] = (mo[k] || 0) + r.R; } const mv = Object.values(mo);
    out.push(`| ${name} | ${g} | ${q.length} | ${nSig ? pct(q.length, nSig) : '—'} | ${pct(q.filter(r => r.R > 0).length, q.length)} | ${y(2025)} | ${y(2026)} | ${f1(e)} | ${q.length ? (e / q.length).toFixed(3) : '—'} | ${d.toFixed(1)} | ${ms} | ${d < 0 ? ((e / yrs) / -d).toFixed(2) : '—'} | ${mv.filter(x => x > 0).length} / ${mv.length} | ${avg('riskPct').toFixed(2)}% | ${avg('mae').toFixed(2)}% | ${avg('better').toFixed(2)}% |`); };
  for (const cf of CONFIGS) {
    let all = []; for (const s of syms) all = all.concat(run(s, data[s].m15, data[s].ltf, data[s].htf, cf, L[s])); all = all.filter(r => r.inT >= t0);
    const done = all.filter(r => !r.miss);
    row(cf.name, '全部', done, all.length); row(cf.name, '全部｜同時最多 5 筆', capN(done, 5)); row(cf.name, '前 6 大', done.filter(r => T6.includes(r.sym)), all.filter(r => T6.includes(r.sym)).length);
    console.log(cf.name, 'done');
  }
  const md = out.join('\n'); console.log(md);
  fs.writeFileSync(path.join(__dirname, '..', 'research-cache', `strat4-${EXCHANGE}.md`), md);
})().catch(e => { console.error(e); fs.writeFileSync(path.join(__dirname, '..', 'research-cache', 'strat4-error.md'), String(e.stack)); process.exit(1); });
