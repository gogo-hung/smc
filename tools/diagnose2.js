// MTF 改良測試：同一批成交的單，換止損 / 止盈 / 被掃後再進場
const fs = require('fs'), path = require('path');
const SMC = require('../src/smc');
const { load, DAYS, EXCHANGE } = require('./hist');
const FEE = 0.035 / 100;
const RULES = { swingLen: 3, htfSwing: 3, breakBy: 'close', obInvalid: 'close', emaLen: 50, stopBuf: 0.2, btcFilter: 'block', side: 'both',
  model: 'mtf', mtfFib: 0.715, mtfWait: 48, mtfReanchor: 'on', mtfFvg: 'on', mtfMinRR: 1.5, mtfPoiSrc: 'choch', mtfSwing: 3, p1: 0, beAt: 0 };
const f2 = v => (v > 0 ? '+' : '') + v.toFixed(2), pct = (a, b) => b ? `${(a / b * 100).toFixed(0)}%` : '—';

function sim(bars, j0, dir, entry, stop, target) {
  const up = dir > 0, risk = Math.abs(entry - stop);
  for (let j = j0; j < bars.length; j++) {
    const b = bars[j];
    if (up ? b.l <= stop : b.h >= stop) return { R: -1, j };
    if (j > j0 && (up ? b.h >= target : b.l <= target)) return { R: (target - entry) * dir / risk, j };
  }
  return { R: null, j: bars.length };
}
const cost = (e, s) => 2 * FEE * e / Math.abs(e - s);

(async () => {
  const data = await load(); const syms = Object.keys(data).filter(s => data[s].m15 && data[s].m15.length > 500);
  const btc = SMC.trendSeries(data.BTC.htf, RULES);
  const V = {}; const add = (k, R, n = 1) => { (V[k] ||= { R: [], w: 0 }); if (R == null) return; V[k].R.push(R); if (R > 0) V[k].w++; };
  let n = 0, hunted = 0, reN = 0;
  const errs = [];
  for (const sym of syms) { try {
    const m = data[sym].m15, htf = data[sym].htf, idx = new Map(m.map((b, i) => [b.t, i]));
    const Hs = SMC.structure(htf, { swingLen: 3, breakBy: 'close', obInvalid: 'close' }), hbar = htf[1].t - htf[0].t;
    const { trades } = SMC.backtest(sym, m, htf, RULES, { feePct: 0, btcDirAt: btc });
    for (const t of trades) {
      if (t.filledT == null) continue;
      const jf = idx.get(t.filledT), dir = t.dir, up = dir > 0, risk = Math.abs(t.entry - t.stop);
      // 4H 區間極值（成交當下已收盤的 4H）
      let k = -1; while (k + 1 < htf.length && htf[k + 1].t + hbar <= t.filledT) k++;
      const ev = Hs.events.filter(e => e.idx <= k && e.dir === dir).pop(); if (!ev) continue;
      let hi = -Infinity, lo = Infinity; for (let j = ev.from; j <= k; j++) { hi = Math.max(hi, htf[j].h); lo = Math.min(lo, htf[j].l); }
      const htfT = up ? Math.max(hi, t.target) : Math.min(lo, t.target);
      const poiStop = up ? Math.min(t.stop, t.poiLo * (1 - 0.002)) : Math.max(t.stop, t.poiHi * (1 + 0.002)), pr = Math.abs(t.entry - poiStop);
      const base = sim(m, jf, dir, t.entry, t.stop, t.target); if (base.R == null) continue;
      n++;
      add('0 原本：止損 15M 前低、止盈 15M 前高', base.R - cost(t.entry, t.stop));
      const r1 = sim(m, jf, dir, t.entry, poiStop, htfT); add('1 止損 4H 區域外、止盈 4H 前高', r1.R == null ? null : r1.R - cost(t.entry, poiStop));
      for (const x of [2, 3]) { const r = sim(m, jf, dir, t.entry, poiStop, t.entry + dir * pr * x); add(`2 止損 4H 區域外、止盈固定 ${x}R`, r.R == null ? null : r.R - cost(t.entry, poiStop)); }
      const r1b = sim(m, jf, dir, t.entry, t.stop, htfT); add('（參考）止損 15M 前低、止盈 4H 前高', r1b.R == null ? null : r1b.R - cost(t.entry, t.stop));
      // 3. 被掃後再進場：打到止損後 16 根 15M 內，有一根收盤收回推動起點之上 → 收盤價再進場，止損放這次掃到的最低點外，目標不變
      let total = base.R - cost(t.entry, t.stop);
      if (base.R === -1) {
        let ext = up ? Infinity : -Infinity, re = null;
        for (let j = base.j; j < Math.min(m.length, base.j + 16); j++) {
          ext = up ? Math.min(ext, m[j].l) : Math.max(ext, m[j].h);
          if (j > base.j && (up ? m[j].c > t.legLo : m[j].c < t.legLo)) { re = { j, e: m[j].c, s: ext * (1 - dir * 0.002) }; break; }
          if (up ? m[j].h >= t.target : m[j].l <= t.target) break;
        }
        if (re && (t.target - re.e) * dir > 0 && Math.abs(re.e - re.s) > 0) {
          reN++;
          const r2 = sim(m, re.j + 1, dir, re.e, re.s, t.target);
          if (r2.R != null) total += r2.R - cost(re.e, re.s);
          if (r2.R != null && r2.R > 0) hunted++;
        }
      }
      add('3 止損 15M 前低，被掃後收回再進場一次（兩筆合計）', total);
    }
  } catch (e) { errs.push(`${sym}: ${e.message}`); } }
  const out = [`# MTF 改良測試（${EXCHANGE}，${DAYS} 天，同一批 ${n} 筆成交的單，手續費 0.035%×2）`, '', '| 做法 | 筆數 | 勝率 | 平均R | 累計R |', '|---|---|---|---|---|'];
  for (const k of Object.keys(V).sort()) { const v = V[k]; const s = v.R.reduce((a, b) => a + b, 0); out.push(`| ${k} | ${v.R.length} | ${pct(v.w, v.R.length)} | ${f2(s / v.R.length)} | ${f2(s)} |`); }
  out.push('', `被掃後收回再進場：觸發 ${reN} 次，其中 ${hunted} 次第二筆打到目標。（每筆都用 1R 計：再進場那筆的止損距離另外算，同樣是 1R 風險）`);
  if (errs.length) out.push('', `錯誤 ${errs.length} 個幣：${errs.slice(0, 5).join('；')}`);
  const md = out.join('\n'); console.log(md);
  fs.writeFileSync(path.join(__dirname, '..', 'research-cache', `diag2-${EXCHANGE}-${DAYS}.md`), md);
})().catch(e => { console.error(e); process.exit(1); });
