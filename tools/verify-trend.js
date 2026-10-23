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
  console.log(md); fs.writeFileSync(path.join(__dirname, '..', 'research-cache', `verify-trend-${EXCHANGE}.md`), md);
})().catch(e => { console.error(e); fs.writeFileSync(path.join(__dirname, '..', 'research-cache', 'verify-trend-error.md'), String(e.stack)); process.exit(1); });
