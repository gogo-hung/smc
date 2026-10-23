// 策略① 的保本（套保）時機：獲利到 xR、或 1H／4H 結構延續（同向 BOS）時把止損移到開倉價
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

const FEE = 0.022 / 100;
const CONFIGS = [
  { name: '原本（不保本）' },
  { name: '獲利 0.5R 保本', beR: 0.5 },
  { name: '獲利 1R 保本', beR: 1 },
  { name: '獲利 1.5R 保本', beR: 1.5 },
  { name: '獲利 2R 保本', beR: 2 },
  { name: '獲利 1R 保本（+0.1R 蓋手續費）', beR: 1, lock: 0.1 },
  { name: '1H 結構延續（同向 BOS）保本', beBos: '1h' },
  { name: '4H 結構延續（同向 BOS）保本', beBos: '4h' },
  { name: '1H 結構延續 且 獲利 ≥ 0.5R 才保本', beBos: '1h', beMin: 0.5 },
];
function run(sym, h1, h4, cf, S1, S4) {
  const H4 = 4 * 3600e3, H1 = 3600e3, idx1 = new Map(h1.map((b, i) => [b.t, i])), out = []; let busyT = -1;
  const bos1 = new Map(), bos4 = new Map();
  for (const e of S1.events) if (e.type === 'BOS') bos1.set(e.idx, e);
  for (const e of S4.events) if (e.type === 'BOS') { const j = idx1.get(h4[e.idx].t + H4 - H1); if (j != null) bos4.set(j, { dir: e.dir, fromT: h4[e.from].t }); }
  for (const s of signals(h4)) {
    const closeT = h4[s.i].t + H4; if (closeT <= busyT) continue;
    const jE = idx1.get(closeT); if (jE == null) continue;
    const dir = s.dir, a = s.atr, E = h1[jE].o, stop0 = E - dir * a * 2, risk = Math.abs(E - stop0);
    let stop = stop0, ext = E, be = false, res = null;
    for (let j = jE; j < h1.length; j++) { const b = h1[j];
      if (dir > 0 ? b.l <= stop : b.h >= stop) { res = { R: (stop - E) * dir / risk, j, be }; break; }
      ext = dir > 0 ? Math.max(ext, b.h) : Math.min(ext, b.l);
      const fav = (ext - E) * dir / risk, bePx = E + dir * risk * (cf.lock || 0);
      let trig = false;
      if (cf.beR && fav >= cf.beR) trig = true;
      if (cf.beBos === '1h') { const e = bos1.get(j); if (e && e.dir === dir && e.from >= jE && fav >= (cf.beMin || 0)) trig = true; }
      if (cf.beBos === '4h') { const e = bos4.get(j); if (e && e.dir === dir && e.fromT >= h1[jE].t - 3 * H1) trig = true; }
      if (trig && !be && (dir > 0 ? bePx > stop : bePx < stop) && (dir > 0 ? b.c > bePx : b.c < bePx)) { stop = bePx; be = true; }
      const ns = ext - dir * a * 3; if (dir > 0 ? ns > stop : ns < stop) stop = ns;
    }
    if (!res) break;
    out.push({ sym, inT: h1[jE].t, t: h1[res.j].t + H1, R: res.R - 2 * FEE * E / risk, real: res.R < -0.5, be: res.be && res.R > -0.5 && res.R < 0.3 }); busyT = h1[res.j].t + H1;
  }
  return out;
}
(async () => {
  const data = await load(); const syms = Object.keys(data).filter(s => data[s].htf && data[s].htf.length > 400 && data[s].ltf && data[s].ltf.length > 1000);
  const T6 = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE'].filter(s => syms.includes(s));
  const f1 = v => (v > 0 ? '+' : '') + v.toFixed(1), pct = (a, b) => b ? `${(a / b * 100).toFixed(0)}%` : '—';
  const t0 = Date.UTC(2025, 0, 1), t1 = Math.max(...syms.map(s => data[s].ltf[data[s].ltf.length - 1].t)), yrs = (t1 - t0) / (365 * 864e5);
  const S1 = {}, S4 = {}; for (const s of syms) { S1[s] = SMC.structure(data[s].ltf, { swingLen: 3, breakBy: 'close', obInvalid: 'close' }); S4[s] = SMC.structure(data[s].htf, { swingLen: 3, breakBy: 'close', obInvalid: 'close' }); }
  const out = [`# 策略① 保本（套保）時機（${EXCHANGE}，2025-01-01 ～ ${new Date(t1).toISOString().slice(0, 10)}，${syms.length} 個幣，手續費 0.022%×2）`, '',
    '整筆不先平倉，只把止損移到開倉價；移動止損照舊。「勝率」＝R>0；「保本出場」＝打回開倉價附近出場的比例；「連虧（含保本）」把保本扣手續費也算虧，「真的連虧」只算打到原本止損的', '',
    '| 保本時機 | 幣 | 筆數 | 勝率 | 保本出場 | 真的虧 | 2025 | 2026 | 全部 | 每筆平均 | 最大回撤 | 連虧（含保本） | 真的連虧 | 卡瑪 | 賺錢月份 |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|'];
  const row = (name, g, q) => { q = [...q].sort((a, b) => a.t - b.t); let e = 0, p = 0, d = 0, s = 0, ms = 0, s2 = 0, ms2 = 0; for (const r of q) { e += r.R; p = Math.max(p, e); d = Math.min(d, e - p); s = r.R <= 0 ? s + 1 : 0; ms = Math.max(ms, s); s2 = r.real ? s2 + 1 : (r.R > 0 ? 0 : s2); ms2 = Math.max(ms2, s2); }
    const y = yr => f1(q.filter(r => new Date(r.t).getUTCFullYear() === yr).reduce((a, r) => a + r.R, 0));
    const mo = {}; for (const r of q) { const k = new Date(r.t + 8 * 3600e3).toISOString().slice(0, 7); mo[k] = (mo[k] || 0) + r.R; } const mv = Object.values(mo);
    out.push(`| ${name} | ${g} | ${q.length} | ${pct(q.filter(r => r.R > 0).length, q.length)} | ${pct(q.filter(r => r.be).length, q.length)} | ${pct(q.filter(r => r.real).length, q.length)} | ${y(2025)} | ${y(2026)} | ${f1(e)} | ${q.length ? (e / q.length).toFixed(3) : '—'} | ${d.toFixed(1)} | ${ms} | ${ms2} | ${d < 0 ? ((e / yrs) / -d).toFixed(2) : '—'} | ${mv.filter(x => x > 0).length} / ${mv.length} |`); };
  for (const cf of CONFIGS) {
    let all = []; for (const s of syms) all = all.concat(run(s, data[s].ltf, data[s].htf, cf, S1[s], S4[s])); all = all.filter(r => r.inT >= t0);
    row(cf.name, '全部', all); row(cf.name, '同時最多 5 筆', capN(all, 5)); row(cf.name, '前 6 大', all.filter(r => T6.includes(r.sym)));
  }
  const md = out.join('\n'); console.log(md);
  fs.writeFileSync(path.join(__dirname, '..', 'research-cache', `strat6-${EXCHANGE}.md`), md);
})().catch(e => { console.error(e); fs.writeFileSync(path.join(__dirname, '..', 'research-cache', 'strat6-error.md'), String(e.stack)); process.exit(1); });
