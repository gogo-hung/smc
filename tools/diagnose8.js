// 同一套邏輯：4H 找區域＋15M 進場 vs 1H 找區域＋5M 進場（同一批幣、同一段時間）
const fs = require('fs'), path = require('path');
const SMC = require('../src/smc');
const { load, DAYS, EXCHANGE } = require('./hist');
const FEE = 0.035 / 100;
const B = { swingLen: 3, htfSwing: 3, breakBy: 'close', obInvalid: 'close', emaLen: 50, model: 'mtf', side: 'both', mtfFib: 0.715, mtfBand: 0.618, mtfEntry: 'edge', mtfWait: 48,
  mtfReanchor: 'on', mtfReLo: 0.382, mtfFvg: 'on', mtfMinRR: 1.0, p1: 0, beAt: 0, stopBuf: 1.0, btcFilter: 'off', mtfPois: 6, mtfSwing: 3, mtfPoiSrc: 'choch', mtfConf: 'on',
  mtfSweep: 'on', mtfReact: 'on', mtfBe: 'bos' };
const SETS = [['4H 找區域＋15M 進場', B, 'm15', 'htf'], ['1H 找區域＋5M 進場', { ...B, mtfWait: 144 }, 'm5', 'ltf']];
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
  const d5 = await load(); const d15 = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research-cache', 'hist-ccxt-okx-665-m15.json'), 'utf8'));
  for (const k in d15) if (d15[k].m15 && Array.isArray(d15[k].m15[0])) d15[k].m15 = d15[k].m15.map(a => ({ t: a[0], o: a[1], h: a[2], l: a[3], c: a[4], v: a[5] }));
  const syms = Object.keys(d5).filter(s => d5[s].m5 && d5[s].m5.length > 2000 && d15[s] && d15[s].m15 && d15[s].m15.length > 2000);
  const S0 = Object.fromEntries(syms.map(s => [s, d5[s].m5[300].t])), T0 = Math.min(...Object.values(S0)), T1 = Math.max(...syms.map(s => d5[s].m5[d5[s].m5.length - 1].t)), months = (T1 - T0) / (30.4 * 864e5);
  const GROUPS = [['只有 BTC、ETH', T2], ['前 6 大', T6], [`全部 ${syms.length} 個`, syms]].map(([n, l]) => [n, l.filter(s => syms.includes(s))]);
  const out = [`# 4H＋15M vs 1H＋5M（${EXCHANGE}，${new Date(T0).toISOString().slice(0, 10)} ～ ${new Date(T1).toISOString().slice(0, 10)}，約 ${months.toFixed(1)} 個月，手續費 0.035%×2）`, ''];
  for (const [g, l] of GROUPS) out.push(`- ${g}：${l.length <= 20 ? l.join('、') : l.length}`);
  out.push('', `各幣 5M 資料起點：${syms.map(s => `${s} ${new Date(S0[s]).toISOString().slice(0, 7)}`).join('、')}`);
  out.push('', '| 週期 | 幣 | 設定 | 筆數 | 每月幾筆 | 勝率 | 累計R | 每筆平均 | 最大回撤 | 賺錢月份 |', '|---|---|---|---|---|---|---|---|---|---|');
  for (const [setName, R0, lk, hk] of SETS) {
    const rows = [];
    for (const sym of syms) {
      const src = lk === 'm5' ? d5[sym] : d15[sym], m = src[lk], htf = src[hk], idx = new Map(m.map((b, i) => [b.t, i]));
      const L = SMC.structure(m, { ...R0, swingLen: 3 }); const bosAt = {}; for (const x of L.events) if (x.type === 'BOS') bosAt[x.idx] = x;
      for (const t of SMC.backtest(sym, m, htf, R0, { feePct: 0 }).trades) {
        if (t.filledT == null || t.R == null || t.filledT < S0[sym]) continue; const jf = idx.get(t.filledT); if (jf == null) continue;
        const dir = t.dir, up = dir > 0, E = t.entry, sZ = up ? t.poiLo * 0.99 : t.poiHi * 1.01, s1 = t.legLo - dir * t.legLo * 0.01;
        const cs = [[s1, t.target, true], [sZ, E + dir * Math.abs(E - sZ) * 0.5, false], [sZ, E + dir * Math.abs(E - sZ) * 0.5, true]];
        cs.forEach(([s, tg, be], ci) => { if (up ? s >= E : s <= E) return; const r = sim(m, bosAt, jf, dir, E, s, tg, be); if (r.R == null) return;
          rows.push({ sym, ci, t: m[r.j].t, R: r.R - 2 * FEE * E / Math.abs(E - s) }); });
      }
    }
    for (const [g, l] of GROUPS) for (let ci = 0; ci < CFG.length; ci++) {
      const q = rows.filter(r => r.ci === ci && l.includes(r.sym)).sort((a, b) => a.t - b.t);
      let e = 0, p = 0, d = 0; for (const r of q) { e += r.R; p = Math.max(p, e); d = Math.min(d, e - p); }
      const mo = {}; for (const r of q) { const k = new Date(r.t + 8 * 3600e3).toISOString().slice(0, 7); mo[k] = (mo[k] || 0) + r.R; }
      const mv = Object.values(mo);
      out.push(`| ${setName} | ${g} | ${CFG[ci]} | ${q.length} | ${(q.length / months).toFixed(1)} | ${pct(q.filter(r => r.R > 0).length, q.length)} | ${f1(e)} | ${q.length ? (e / q.length >= 0 ? '+' : '') + (e / q.length).toFixed(2) : '—'} | ${d.toFixed(1)} | ${mv.filter(v => v > 0).length} / ${mv.length} |`);
    }
  }
  const md = out.join('\n'); console.log(md);
  fs.writeFileSync(path.join(__dirname, '..', 'research-cache', `diag8-${EXCHANGE}.md`), md);
})().catch(e => { console.error(e); fs.writeFileSync(path.join(__dirname, '..', 'research-cache', 'diag8-error.md'), String(e.stack)); process.exit(1); });
