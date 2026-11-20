// 用網站實際上線的 src/trend.js 回測一次，確認跟研究結果一致（同時最多 5 筆）
const fs = require('fs'), path = require('path');
const { load, EXCHANGE } = require('./hist');
const T = require('../src/trend');
const FEE = 0.022 / 100, H4 = 4 * 3600e3, H1 = 3600e3;
(async () => {
  const data = await load(); const syms = Object.keys(data).filter(s => data[s].htf && data[s].htf.length > 400 && data[s].ltf && data[s].ltf.length > 1000);
  const t0 = Date.UTC(2025, 0, 1), trades = [];
  for (const sym of syms) {
    const h1 = data[sym].ltf, h4 = data[sym].htf, i1 = new Map(h1.map((b, i) => [b.t, i])), bos = T.bosMap(h1); let busyT = -1;
    for (const sg of T.signals(h4)) {
      const closeT = sg.t + H4; if (closeT <= busyT) continue; const jE = i1.get(closeT); if (jE == null) continue;
      const E = h1[jE].o, s = { dir: sg.dir, entry: E, stop0: E - sg.dir * 2 * sg.atr, stop: E - sg.dir * 2 * sg.atr, atr: sg.atr, ext: E, be: false, filledAt: h1[jE].t };
      let ex = null, j; for (j = jE; j < h1.length; j++) { const ev = T.step(s, h1[j], bos.get(h1[j].t)); ex = ev.find(e => e.k === 'exit'); if (ex) break; }
      if (!ex) break; const risk = Math.abs(E - s.stop0);
      trades.push({ sym, inT: h1[jE].t, t: h1[j].t + H1, R: ex.R - 2 * FEE * E / risk }); busyT = h1[j].t + H1;
    }
  }
  const all = trades.filter(r => r.inT >= t0);
  const acc = [], open = []; for (const r of [...all].sort((a, b) => a.inT - b.inT)) { while (open.length && open[0] <= r.inT) open.shift(); if (open.length >= 5) continue; acc.push(r); open.push(r.t); open.sort((a, b) => a - b); }
  const st = q => { q = [...q].sort((a, b) => a.t - b.t); let e = 0, p = 0, d = 0; for (const r of q) { e += r.R; p = Math.max(p, e); d = Math.min(d, e - p); } const y = yr => q.filter(r => new Date(r.t).getUTCFullYear() === yr).reduce((a, r) => a + r.R, 0).toFixed(1);
    return `${q.length} 筆｜勝率 ${(q.filter(r => r.R > 0).length / q.length * 100).toFixed(0)}%｜2025 ${y(2025)}｜2026 ${y(2026)}｜累計 ${e.toFixed(1)}R｜回撤 ${d.toFixed(1)}R`; };
  const md = `# 上線版 src/trend.js 回測（${EXCHANGE}，2025-01-01 起，${syms.length} 幣）\n\n- 全部：${st(all)}\n- 同時最多 5 筆：${st(acc)}\n\n研究版（strat6「1H 結構延續 且 獲利 ≥ 0.5R 才保本」）：全部 1107 筆 +86.2R；同時最多 5 筆 699 筆 +68.9R`;
  // 50U 複利模擬：每筆風險 = 進場當下已實現資金 × r
  const sim = (q, r, start = 50) => {
    const ev = []; q.forEach((x, i) => { ev.push({ t: x.inT, k: 0, i }); ev.push({ t: x.t, k: 1, i }); });
    ev.sort((a, b) => a.t - b.t || b.k - a.k); let eq = start, peak = start, dd = 0, low = start; const size = {}, mon = {};
    for (const e of ev) { if (e.k === 0) { size[e.i] = eq * r; continue; } const pnl = size[e.i] * q[e.i].R; eq += pnl; peak = Math.max(peak, eq); dd = Math.min(dd, eq / peak - 1); low = Math.min(low, eq); const m = new Date(e.t).toISOString().slice(0, 7); mon[m] = (mon[m] || 0) + pnl; }
    const ye = yr => { let a = start; for (const e of ev) { if (e.k === 1 && new Date(e.t).getUTCFullYear() < yr) a += 0; } return a; };
    const months = Object.keys(mon).sort(); const neg = months.filter(m => mon[m] < 0).length;
    return { eq, dd, low, months, mon, neg };
  };
  let sm = '\n\n## 50U 複利模擬（扣 0.022% 手續費）\n\n| 組別 | 每筆風險 | 最後資金 | 報酬 | 最大回撤 | 最低時剩 | 虧損月 |\n|---|---|---|---|---|---|---|\n';
  const det = {};
  for (const [nm, q] of [['全部訊號', all], ['同時最多5筆', acc]]) for (const r of [0.005, 0.01, 0.02, 0.03, 0.05]) {
    const o = sim(q, r); det[nm + r] = o;
    sm += `| ${nm} | ${r * 100}% | ${o.eq.toFixed(1)}U | ${((o.eq / 50 - 1) * 100).toFixed(0)}% | ${(o.dd * 100).toFixed(0)}% | ${o.low.toFixed(1)}U | ${o.neg}/${o.months.length} |\n`;
  }
  for (const k of ['全部訊號0.01', '同時最多5筆0.01', '全部訊號0.02']) { const o = det[k]; let eq = 50; sm += `\n### ${k} 每月\n\n| 月 | 損益 | 月底資金 |\n|---|---|---|\n`; for (const m of o.months) { eq += o.mon[m]; sm += `| ${m} | ${o.mon[m].toFixed(2)}U | ${eq.toFixed(1)}U |\n`; } }
  const md2 = md + sm;
  console.log(md2); fs.writeFileSync(path.join(__dirname, '..', 'research-cache', `trend-50u-${EXCHANGE}.md`), md2);
  console.log(md); fs.writeFileSync(path.join(__dirname, '..', 'research-cache', `verify-trend-${EXCHANGE}.md`), md);
})().catch(e => { console.error(e); fs.writeFileSync(path.join(__dirname, '..', 'research-cache', 'verify-trend-error.md'), String(e.stack)); process.exit(1); });
