// 止損放哪裡比較不會被掃：同一批 B 版成交的單（進場、止盈不變），換不同止損位置
// 另外量「最後有到止盈的單，中途最深掃到斐波 1 外面多少」
const fs = require('fs'), path = require('path');
const SMC = require('../src/smc');
const { load, DAYS, EXCHANGE } = require('./hist');
const FEE = 0.035 / 100;
const B = { swingLen: 3, htfSwing: 3, breakBy: 'close', obInvalid: 'close', emaLen: 50, model: 'mtf', side: 'both', mtfFib: 0.715, mtfBand: 0.618, mtfEntry: 'edge', mtfWait: 48,
  mtfReanchor: 'on', mtfReLo: 0.382, mtfFvg: 'on', mtfMinRR: 1.0, p1: 0, beAt: 0, stopBuf: 1.0, btcFilter: 'off', mtfPois: 6, mtfSwing: 3, mtfPoiSrc: 'choch', mtfConf: 'on',
  mtfSweep: 'on', mtfReact: 'on', mtfBe: 'bos' };
const SETS = [['B 你改的版本', B], ['B 不要求獵取／反應（樣本多一點）', { ...B, mtfSweep: 'off', mtfReact: 'off' }]];
const f1 = v => (v > 0 ? '+' : '') + v.toFixed(1), f2 = v => (v > 0 ? '+' : '') + v.toFixed(2), pct = (a, b) => b ? `${(a / b * 100).toFixed(0)}%` : '—';
const atrAt = (c, i) => { let a = 0, n = 0; for (let j = Math.max(1, i - 13); j <= i; j++) { a += Math.max(c[j].h - c[j].l, Math.abs(c[j].h - c[j - 1].c), Math.abs(c[j].l - c[j - 1].c)); n++; } return a / n; };

// 回傳 {R, j, hit:'stop'|'target'|null}；be=true 時成交後出現同向 BOS（打破成交後才形成的前低/高）就把止損移到開倉價
function sim(m, bosAt, jf, dir, entry, stop, target, be) {
  const up = dir > 0, risk = Math.abs(entry - stop); let sl = stop;
  for (let j = jf; j < m.length; j++) { const b = m[j];
    if (up ? b.l <= sl : b.h >= sl) return { R: (sl - entry) * dir / risk, j, hit: sl === stop ? 'stop' : 'be' };
    if (j > jf && (up ? b.h >= target : b.l <= target)) return { R: (target - entry) * dir / risk, j, hit: 'target' };
    if (be && j > jf && sl === stop) { const x = bosAt[j]; if (x && x.dir === dir && x.from > jf) sl = entry; }
  }
  return { R: null, j: m.length, hit: null };
}
const reach = (m, j0, dir, target, n = 96) => { for (let j = j0 + 1; j < Math.min(m.length, j0 + n); j++) if (dir > 0 ? m[j].h >= target : m[j].l <= target) return true; return false; };

(async () => {
  const data = await load(); const syms = Object.keys(data).filter(s => data[s].m15 && data[s].m15.length > 500);
  const out = [`# 止損位置測試（${EXCHANGE}，${DAYS} 天，手續費 0.035%×2；進場、止盈都跟 B 版一樣，只換止損）`, ''];
  for (const [setName, R0] of SETS) {
    const V = {}, order = []; const add = (k, r, swept) => { if (!V[k]) { V[k] = { R: [], w: 0, st: 0, sw: 0 }; order.push(k); } if (r == null) return; V[k].R.push(r.R); if (r.R > 0) V[k].w++; if (r.hit === 'stop') { V[k].st++; if (swept) V[k].sw++; } };
    const mae = []; let n = 0;
    for (const sym of syms) {
      const m = data[sym].m15, htf = data[sym].htf, idx = new Map(m.map((b, i) => [b.t, i])), hbar = htf[1].t - htf[0].t;
      const L = SMC.structure(m, { ...R0, swingLen: 3 }), Hs = SMC.structure(htf, { ...R0, swingLen: 3 });
      const bosAt = {}; for (const x of L.events) if (x.type === 'BOS') bosAt[x.idx] = x;
      const { trades } = SMC.backtest(sym, m, htf, R0, { feePct: 0 });
      for (const t of trades) {
        if (t.filledT == null || t.R == null) continue;
        const jf = idx.get(t.filledT); if (jf == null) continue;
        const dir = t.dir, up = dir > 0, E = t.entry, T = t.target, F1 = t.legLo, span = Math.abs(T - F1), atr = atrAt(m, jf);
        const away = (p, x) => p - dir * x;   // 往止損方向推 x
        let hk = -1; while (hk + 1 < htf.length && htf[hk + 1].t + hbar <= t.filledT) hk++;
        const h4 = (up ? Hs.sw.lo : Hs.sw.hi).filter(x => x.conf <= hk && (up ? x.price < F1 : x.price > F1)).pop();
        const m15 = (up ? L.sw.lo : L.sw.hi).filter(x => x.conf <= jf && (up ? x.price < F1 * (1 - 0.001) : x.price > F1 * (1 + 0.001))).pop();
        const stops = [];
        for (const b of [0, 0.3, 0.5, 1, 1.5, 2, 3]) stops.push([`斐波 1 外 ${b}%`, away(F1, F1 * b / 100)]);
        for (const k of [0.5, 1, 1.5, 2, 3]) stops.push([`斐波 1 外 ${k} 倍 ATR(15M)`, away(F1, atr * k)]);
        for (const r of [1.13, 1.272, 1.414, 1.618]) stops.push([`斐波延伸 ${r}`, away(T, -dir * 0) - dir * span * r]);
        stops.push(['4H 區域外 0.3%', up ? t.poiLo * (1 - 0.003) : t.poiHi * (1 + 0.003)]);
        stops.push(['4H 區域外 1%', up ? t.poiLo * (1 - 0.01) : t.poiHi * (1 + 0.01)]);
        if (h4) stops.push(['4H 前低／前高外 0.3%', away(h4.price, h4.price * 0.003)]);
        if (m15) stops.push(['再下一個 15M 前低／前高外 0.3%', away(m15.price, m15.price * 0.003)]);
        n++;
        for (const [k, s] of stops) {
          if (up ? s >= E : s <= E) { continue; }
          for (const be of [false, true]) {
            const r = sim(m, bosAt, jf, dir, E, s, T, be); if (r.R == null) continue;
            r.R -= 2 * FEE * E / Math.abs(E - s);
            add(`${k}${be ? '｜套保' : ''}`, r, r.hit === 'stop' && reach(m, r.j, dir, T));
          }
        }
        // MAE：不設止損，看到止盈之前最深掃到哪（超過斐波 2 或 2000 根沒到就算沒到）
        let ext = E, ok = false;
        for (let j = jf; j < Math.min(m.length, jf + 2000); j++) { const b = m[j]; ext = up ? Math.min(ext, b.l) : Math.max(ext, b.h);
          if (up ? ext < T - span * 2 : ext > T + span * 2) break;
          if (j > jf && (up ? b.h >= T : b.l <= T)) { ok = true; break; } }
        if (ok) mae.push({ pct: (up ? F1 - ext : ext - F1) / F1 * 100, atr: (up ? F1 - ext : ext - F1) / atr, fib: (up ? T - ext : ext - T) / span });
      }
    }
    out.push(`## ${setName}（${n} 筆成交）`, '', '| 止損位置 | 筆數 | 勝率 | 累計R | 平均R | 打到止損 | 其中「被掃」（止損後 24h 內又到止盈） |', '|---|---|---|---|---|---|---|');
    for (const k of order) { const v = V[k], s = v.R.reduce((a, b) => a + b, 0); out.push(`| ${k} | ${v.R.length} | ${pct(v.w, v.R.length)} | ${f1(s)} | ${f2(s / Math.max(1, v.R.length))} | ${v.st} | ${v.sw}（${pct(v.sw, v.st)}） |`); }
    const q = (a, p) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
    const P = mae.map(x => x.pct), A = mae.map(x => x.atr), Fb = mae.map(x => x.fib);
    out.push('', `**不設止損時，最後有到止盈的 ${mae.length} 筆，中途最深掃到哪：**（負數＝沒碰到斐波 1）`, '', '| | 一半的單 | 75% 的單 | 90% 的單 | 95% 的單 |', '|---|---|---|---|---|',
      `| 超過斐波 1 多少 % | ${q(P, .5).toFixed(2)}% | ${q(P, .75).toFixed(2)}% | ${q(P, .9).toFixed(2)}% | ${q(P, .95).toFixed(2)}% |`,
      `| 超過斐波 1 幾倍 ATR | ${q(A, .5).toFixed(2)} | ${q(A, .75).toFixed(2)} | ${q(A, .9).toFixed(2)} | ${q(A, .95).toFixed(2)} |`,
      `| 回到斐波幾 | ${q(Fb, .5).toFixed(3)} | ${q(Fb, .75).toFixed(3)} | ${q(Fb, .9).toFixed(3)} | ${q(Fb, .95).toFixed(3)} |`, '',
      `有掃破斐波 1 的：${pct(P.filter(x => x > 0).length, P.length)}；破 1% 以上：${pct(P.filter(x => x > 1).length, P.length)}；破 2% 以上：${pct(P.filter(x => x > 2).length, P.length)}`, '');
  }
  const md = out.join('\n'); console.log(md);
  fs.writeFileSync(path.join(__dirname, '..', 'research-cache', `diag3-${EXCHANGE}-${DAYS}.md`), md);
})().catch(e => { console.error(e); process.exit(1); });
