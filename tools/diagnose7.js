// 只跑大幣：BTC/ETH、前 6 大、前 15 大、全部，2025 / 2026 分開看
const fs = require('fs'), path = require('path');
const SMC = require('../src/smc');
const { load, DAYS, EXCHANGE } = require('./hist');
const FEE = 0.035 / 100;
const B = { swingLen: 3, htfSwing: 3, breakBy: 'close', obInvalid: 'close', emaLen: 50, model: 'mtf', side: 'both', mtfFib: 0.715, mtfBand: 0.618, mtfEntry: 'edge', mtfWait: 48,
  mtfReanchor: 'on', mtfReLo: 0.382, mtfFvg: 'on', mtfMinRR: 1.0, p1: 0, beAt: 0, stopBuf: 1.0, btcFilter: 'off', mtfPois: 6, mtfSwing: 3, mtfPoiSrc: 'choch', mtfConf: 'on',
  mtfSweep: 'on', mtfReact: 'on', mtfBe: 'bos' };
const SETS = [['B 你改的版本', B], ['B 放寬（不要求獵取／反應）', { ...B, mtfSweep: 'off', mtfReact: 'off' }]];
const T2 = ['BTC', 'ETH'], T6 = [...T2, 'SOL', 'XRP', 'BNB', 'DOGE'], T15 = [...T6, 'ADA', 'LINK', 'AVAX', 'LTC', 'BCH', 'DOT', 'TRX', 'SUI', 'TON'];
const f1 = v => (v > 0 ? '+' : '') + v.toFixed(1), pct = (a, b) => b ? `${(a / b * 100).toFixed(0)}%` : '—';
function sim(m, bosAt, jf, dir, entry, stop, target, be) {
  const up = dir > 0, risk = Math.abs(entry - stop); let sl = stop;
  for (let j = jf; j < m.length; j++) { const b = m[j];
    if (up ? b.l <= sl : b.h >= sl) return { R: (sl - entry) * dir / risk, j };
    if (j > jf && (up ? b.h >= target : b.l <= target)) return { R: (target - entry) * dir / risk, j };
    if (be && j > jf && sl === stop) { const x = bosAt[j]; if (x && x.dir === dir && x.from > jf) sl = entry; }
  }
  return { R: null, j: m.length };
}
const CFG = ['B 原本（斐波 1 外 1%、15M 前高、套保）', '4H 區域外 1%＋0.5:1', '4H 區域外 1%＋0.5:1＋套保'];
(async () => {
  const data = await load(); const syms = Object.keys(data).filter(s => data[s].m15 && data[s].m15.length > 500 && data[s].htf.length > 60);
  const GROUPS = [['只有 BTC、ETH', T2], ['前 6 大', T6], ['前 15 大', T15], ['全部 60 個', syms]].map(([n, l]) => [n, l.filter(s => syms.includes(s))]);
  const out = [`# 只跑大幣（${EXCHANGE}，${DAYS} 天，手續費 0.035%×2）`, ''];
  for (const [g, l] of GROUPS) out.push(`- ${g}：${l.length} 個${l.length <= 15 ? `（${l.join('、')}）` : ''}`);
  for (const [setName, R0] of SETS) {
    const rows = [];   // {sym, cfg, t, R}
    for (const sym of syms) {
      const m = data[sym].m15, htf = data[sym].htf, idx = new Map(m.map((b, i) => [b.t, i]));
      const L = SMC.structure(m, { ...R0, swingLen: 3 }); const bosAt = {}; for (const x of L.events) if (x.type === 'BOS') bosAt[x.idx] = x;
      for (const t of SMC.backtest(sym, m, htf, R0, { feePct: 0 }).trades) {
        if (t.filledT == null || t.R == null) continue; const jf = idx.get(t.filledT); if (jf == null) continue;
        const dir = t.dir, up = dir > 0, E = t.entry, sZ = up ? t.poiLo * 0.99 : t.poiHi * 1.01, s1 = t.legLo - dir * t.legLo * 0.01;
        const cs = [[s1, t.target, true], [sZ, E + dir * Math.abs(E - sZ) * 0.5, false], [sZ, E + dir * Math.abs(E - sZ) * 0.5, true]];
        cs.forEach(([s, tg, be], ci) => { if (up ? s >= E : s <= E) return; const r = sim(m, bosAt, jf, dir, E, s, tg, be); if (r.R == null) return;
          rows.push({ sym, ci, t: m[r.j].t, R: r.R - 2 * FEE * E / Math.abs(E - s) }); });
      }
    }
    out.push('', `## ${setName}`, '', '| 幣 | 設定 | 筆數 | 勝率 | 2025 年 | 2026 年（到 10 月） | 全部 | 最大回撤 | 賺錢月份 |', '|---|---|---|---|---|---|---|---|---|');
    for (const [g, l] of GROUPS) for (let ci = 0; ci < CFG.length; ci++) {
      const q = rows.filter(r => r.ci === ci && l.includes(r.sym)).sort((a, b) => a.t - b.t);
      const y = yr => { const z = q.filter(r => new Date(r.t).getUTCFullYear() === yr); return `${f1(z.reduce((a, r) => a + r.R, 0))}（${z.length} 筆）`; };
      let e = 0, p = 0, d = 0; for (const r of q) { e += r.R; p = Math.max(p, e); d = Math.min(d, e - p); }
      const mo = {}; for (const r of q) { const k = new Date(r.t + 8 * 3600e3).toISOString().slice(0, 7); mo[k] = (mo[k] || 0) + r.R; }
      const mv = Object.values(mo);
      out.push(`| ${g} | ${CFG[ci]} | ${q.length} | ${pct(q.filter(r => r.R > 0).length, q.length)} | ${y(2025)} | ${y(2026)} | ${f1(e)} | ${d.toFixed(1)} | ${mv.filter(v => v > 0).length} / ${mv.length} |`);
    }
  }
  const md = out.join('\n'); console.log(md);
  fs.writeFileSync(path.join(__dirname, '..', 'research-cache', `diag7-${EXCHANGE}-${DAYS}.md`), md);
})().catch(e => { console.error(e); fs.writeFileSync(path.join(__dirname, '..', 'research-cache', 'diag7-error.md'), String(e.stack)); process.exit(1); });
