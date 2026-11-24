// 日內（短線）策略回測：每筆最多抱 1 天，2025、2026 分開看，含手續費，同時最多 5 筆／不限兩種
// 資料：OKX 永續 665 天（1H、4H、15M），跟 verify-trend.js 同一份快取
const fs = require('fs'), path = require('path');
const { load, EXCHANGE } = require('./hist');
const FEE = 0.022 / 100, H = 3600e3, M15 = 900e3, H4 = 4 * H, DAY = 24 * H;
const OUT = path.join(__dirname, '..', 'research-cache', `intraday-${EXCHANGE}.md`);

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
function simulate(bars, sigs, tf, fee = FEE) {
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

// ---- 策略 ----
function stStrat(n, k, rr, fee) { return (d) => {
  const b = d.ltf, A = atr(b), st = supertrend(b, n, k), tr = trendSeries(d.htf), al = aligner(d.htf, H4), sigs = [];
  for (let i = 210; i < b.length; i++) { const j = al(b[i].t + H); if (j < 0) continue; const dir = tr[j]; if (!dir) continue;
    if (st.dir[i] === dir && st.dir[i - 1] === -dir) { const dist = Math.max(Math.abs(b[i].c - st.line[i]), 0.5 * A[i]); sigs.push({ i, dir, riskAbs: dist, rr, maxBars: 24, flip: kk => st.dir[kk] === -dir }); } }
  return simulate(b, sigs, H, fee);
}; }
// ICT：亞洲盤（UTC 0–8）高低點被掃 → 15M 收盤破掉掃之前最後一個反向擺動點（CHoCH）→ 進場，止損在掃的極值外，當天平倉
function ictSweep(filter, rr) { return (d) => {
  const b = d.m15; if (!b) return [];
  const A = atr(b), tr = trendSeries(d.htf), al = aligner(d.htf, H4), sigs = [];
  let day = -1, hi = -Infinity, lo = Infinity, sw = null, done = false;
  for (let i = 6; i < b.length; i++) {
    const dd = Math.floor(b[i].t / DAY), hr = (b[i].t % DAY) / H;
    if (dd !== day) { day = dd; hi = -Infinity; lo = Infinity; sw = null; done = false; }
    if (hr < 8) { hi = Math.max(hi, b[i].h); lo = Math.min(lo, b[i].l); continue; }
    if (done || hr >= 16 || !isFinite(hi)) continue;
    if (!sw) {
      if (b[i].l < lo) sw = { dir: 1, ext: b[i].l, lvl: Math.max(...b.slice(i - 6, i).map(x => x.h)), at: i };
      else if (b[i].h > hi) sw = { dir: -1, ext: b[i].h, lvl: Math.min(...b.slice(i - 6, i).map(x => x.l)), at: i };
      continue;
    }
    if (sw.dir > 0) sw.ext = Math.min(sw.ext, b[i].l); else sw.ext = Math.max(sw.ext, b[i].h);
    if (i - sw.at > 16) { sw = null; continue; }
    const choch = sw.dir > 0 ? b[i].c > sw.lvl : b[i].c < sw.lvl; if (!choch) continue;
    if (filter) { const j = al(b[i].t + M15); if (j < 0 || tr[j] !== sw.dir) { sw = null; continue; } }
    done = true;
    sigs.push({ i, dir: sw.dir, stop: sw.ext - sw.dir * 0.1 * A[i], rr, maxBars: 96, exitAt: (day + 1) * DAY - M15 });
  }
  return simulate(b, sigs, M15);
}; }

const S = {
  'F｜ICT 亞洲盤掃流動性＋15M CHoCH（不分方向）｜2R': ictSweep(false, 2),
  'F｜ICT 亞洲盤掃流動性＋15M CHoCH（4H 順勢才做）｜2R': ictSweep(true, 2),
  'F｜ICT 亞洲盤掃流動性＋15M CHoCH（4H 順勢才做）｜3R': ictSweep(true, 3),
  'A｜1H 動能（4H 順勢＋1H MACD 交叉＋爆量）': (d) => {
    const b = d.ltf, c = b.map(x => x.c), h = macdHist(c), v = sma(b.map(x => x.v), 20), A = atr(b), e50 = ema(c, 50), tr = trendSeries(d.htf), al = aligner(d.htf, H4), sigs = [];
    for (let i = 210; i < b.length; i++) { const j = al(b[i].t + H); if (j < 0) continue; const dir = tr[j]; if (!dir) continue;
      if (dir * h[i] > 0 && dir * h[i - 1] <= 0 && b[i].v > 1.5 * v[i] && dir * (b[i].c - e50[i]) > 0) sigs.push({ i, dir, riskAbs: 1.5 * A[i], rr: 2, maxBars: 24 }); }
    return simulate(b, sigs, H);
  },
  'B｜15M 動能（4H＋1H 都順勢＋15M MACD 交叉＋爆量）': (d) => {
    const b = d.m15; if (!b) return [];
    const c = b.map(x => x.c), h = macdHist(c), v = sma(b.map(x => x.v), 20), A = atr(b);
    const h1 = d.ltf, c1 = h1.map(x => x.c), e50 = ema(c1, 50), e200 = ema(c1, 200), t1 = h1.map((x, i) => e50[i] > e200[i] && x.c > e50[i] ? 1 : e50[i] < e200[i] && x.c < e50[i] ? -1 : 0);
    const tr = trendSeries(d.htf), a4 = aligner(d.htf, H4), a1 = aligner(h1, H), sigs = [];
    for (let i = 40; i < b.length; i++) { const ct = b[i].t + M15, j4 = a4(ct), j1 = a1(ct); if (j4 < 0 || j1 < 200) continue; const dir = tr[j4]; if (!dir || t1[j1] !== dir) continue;
      if (dir * h[i] > 0 && dir * h[i - 1] <= 0 && b[i].v > 1.5 * v[i]) sigs.push({ i, dir, riskAbs: 1.5 * A[i], rr: 2, maxBars: 32 }); }
    return simulate(b, sigs, M15);
  },
  'C｜1H Supertrend 翻轉（4H 順勢）': (d) => {
    const b = d.ltf, A = atr(b), st = supertrend(b), tr = trendSeries(d.htf), al = aligner(d.htf, H4), sigs = [];
    for (let i = 210; i < b.length; i++) { const j = al(b[i].t + H); if (j < 0) continue; const dir = tr[j]; if (!dir) continue;
      if (st.dir[i] === dir && st.dir[i - 1] === -dir) { const dist = Math.max(Math.abs(b[i].c - st.line[i]), 0.5 * A[i]); sigs.push({ i, dir, riskAbs: dist, rr: 2, maxBars: 24, flip: k => st.dir[k] === -dir }); } }
    return simulate(b, sigs, H);
  },
  'D｜亞洲盤區間突破（台灣 08–16 點的高低點，4H 順勢）': (d) => {
    const b = d.m15; if (!b) return [];
    const tr = trendSeries(d.htf), al = aligner(d.htf, H4), sigs = []; let day = -1, hi = -Infinity, lo = Infinity, done = false;
    for (let i = 1; i < b.length; i++) {
      const dd = Math.floor(b[i].t / DAY), hr = (b[i].t % DAY) / H;
      if (dd !== day) { day = dd; hi = -Infinity; lo = Infinity; done = false; }
      if (hr < 8) { hi = Math.max(hi, b[i].h); lo = Math.min(lo, b[i].l); continue; }
      if (done || hr >= 20 || !isFinite(hi)) continue;
      const j = al(b[i].t + M15); if (j < 0) continue; const dir = tr[j]; if (!dir) continue;
      const brk = dir > 0 ? b[i].c > hi : b[i].c < lo; if (!brk) continue;
      const mid = (hi + lo) / 2; done = true;
      sigs.push({ i, dir, stop: mid, rr: 1.5, maxBars: 96, exitAt: (day + 1) * DAY - M15 });
    }
    return simulate(b, sigs, M15);
  },
  'E｜VWAP 回踩（4H 順勢，15M 碰 VWAP 後收回）': (d) => {
    const b = d.m15; if (!b) return [];
    const A = atr(b), tr = trendSeries(d.htf), al = aligner(d.htf, H4), sigs = []; let day = -1, pv = 0, vv = 0, used = false, vw = NaN;
    for (let i = 1; i < b.length; i++) {
      const dd = Math.floor(b[i].t / DAY), hr = (b[i].t % DAY) / H, tp = (b[i].h + b[i].l + b[i].c) / 3;
      if (dd !== day) { day = dd; pv = 0; vv = 0; used = false; }
      const prev = vw; pv += tp * b[i].v; vv += b[i].v; vw = vv ? pv / vv : NaN;
      if (used || hr < 2 || hr >= 20 || !isFinite(prev)) continue;
      const j = al(b[i].t + M15); if (j < 0) continue; const dir = tr[j]; if (!dir) continue;
      const touch = dir > 0 ? b[i].l <= vw && b[i].c > vw && b[i].c > b[i].o && b[i - 1].c > prev : b[i].h >= vw && b[i].c < vw && b[i].c < b[i].o && b[i - 1].c < prev;
      if (!touch) continue; used = true;
      const stop = dir > 0 ? b[i].l - 0.2 * A[i] : b[i].h + 0.2 * A[i];
      sigs.push({ i, dir, stop, rr: 2, maxBars: 96, exitAt: (day + 1) * DAY - M15 });
    }
    return simulate(b, sigs, M15);
  },
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

(async () => {
  const data = await load();
  const syms = Object.keys(data).filter(s => data[s].htf && data[s].htf.length > 400 && data[s].ltf && data[s].ltf.length > 1000);
  for (const s of syms) if (data[s].m15 && Array.isArray(data[s].m15[0])) data[s].m15 = data[s].m15.map(r => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] }));
  const t0 = Date.UTC(2025, 0, 1), rows = [];
  let md = `# 日內策略回測（${EXCHANGE}，${syms.length} 幣，2025-01-01 起，手續費 0.022%×2，每筆最多抱 1 天）\n\n單位 R＝每筆止損的金額。「同時 5 筆」＝同一時間最多 5 筆，多的訊號跳過。\n\n`;
  md += '| 策略 | 組別 | 筆數 | 每月幾筆 | 平均抱幾小時 | 勝率 | 平均每筆 | 2025 | 2026 | 合計 | 最大回撤 | 賺錢月份 | 最長連虧 |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|\n';
  for (const [name, fn] of Object.entries(S)) {
    let all = []; for (const s of syms) { try { all = all.concat(fn(data[s]).map(r => ({ ...r, sym: s }))); } catch (e) { console.error(name, s, e.message); } }
    for (const [g, q] of [['不限', all], ['同時 5 筆', cap(all, 5)]]) {
      const x = stat(q, t0); if (!x) { md += `| ${name} | ${g} | 0 |\n`; continue; }
      md += `| ${name} | ${g} | ${x.n} | ${x.perMon.toFixed(0)} | ${x.hold.toFixed(1)} | ${(x.win * 100).toFixed(0)}% | ${f(x.avg, 3)}R | ${f(x.y25)}R | ${f(x.y26)}R | ${f(x.tot)}R | ${x.dd.toFixed(1)}R | ${x.posMon}/${x.months} | ${x.maxStreak} |\n`;
      rows.push({ name, g, ...x });
    }
    console.log(name, 'done', all.length);
  }
  // ---- C 穩定度測試 ----
  md += `\n## C（1H Supertrend）穩定度\n\n### 1. 換參數（同時 5 筆）\n\n| Supertrend | 止盈 | 手續費 | 筆數 | 2025 | 2026 | 合計 | 回撤 | 平均每筆 |\n|---|---|---|---|---|---|---|---|---|\n`;
  const runAll = fn => { let all = []; for (const s of syms) all = all.concat(fn(data[s])); return all; };
  for (const [n, k] of [[10, 2], [10, 3], [14, 3], [10, 4], [20, 3]]) for (const rr of [1.5, 2, 3, 99]) for (const fee of rr === 2 && n === 10 && k === 3 ? [FEE, 0.05 / 100] : [FEE]) {
    const x = stat(cap(runAll(stStrat(n, k, rr, fee)), 5), t0); if (!x) continue;
    md += `| (${n}, ${k}) | ${rr === 99 ? '翻色才出' : rr + 'R'} | ${(fee * 100).toFixed(3)}% | ${x.n} | ${f(x.y25)}R | ${f(x.y26)}R | ${f(x.tot)}R | ${x.dd.toFixed(1)}R | ${f(x.avg, 3)}R |\n`;
  }
  { const all = runAll(stStrat(10, 3, 2, FEE)).filter(r => r.inT >= t0); let pos = 0, both = 0; const tots = [];
    for (let k = 0; k < 200; k++) { const sh = all.map(r => ({ ...r, key: r.inT + Math.random() * H * 0.999 })).sort((a, b) => a.key - b.key); const acc = [], open = [];
      for (const r of sh) { while (open.length && open[0] <= r.inT) open.shift(); if (open.length >= 5) continue; acc.push(r); open.push(r.t); open.sort((a, b) => a - b); }
      const x = stat(acc, t0); tots.push(x.tot); if (x.tot > 0) pos++; if (x.y25 > 0 && x.y26 > 0) both++; }
    tots.sort((a, b) => a - b);
    md += `\n### 2. 同一小時內誰先進場隨機打亂 200 次（同時 5 筆）\n\n合計賺錢 ${pos}/200 次、兩年都賺 ${both}/200 次；合計 R 的中位數 ${f(tots[100])}R，最差 5% ${f(tots[10])}R，最好 5% ${f(tots[189])}R\n`; }
  const ok = rows.filter(r => r.g === '同時 5 筆' && r.y25 > 0 && r.y26 > 0);
  md += `\n**兩年都賺（同時 5 筆）**：${ok.length ? ok.map(r => r.name).join('、') : '沒有'}\n`;
  console.log(md); fs.writeFileSync(OUT, md);
})().catch(e => { console.error(e); fs.writeFileSync(OUT.replace('.md', '-error.md'), String(e.stack)); process.exit(1); });
