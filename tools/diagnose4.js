// 止損放哪裡比較不會被掃：同一批 B 版成交的單（進場、止盈不變），換不同止損位置
// 另外量「最後有到止盈的單，中途最深掃到斐波 1 外面多少」
const fs = require('fs'), path = require('path');
const SMC = require('../src/smc');
const { load, DAYS, EXCHANGE } = require('./hist');
const FEE = 0.035 / 100, SPLIT = Date.parse('2026-06-20');
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
  const out = [`# 止損＋止盈位置測試（${EXCHANGE}，${DAYS} 天，手續費 0.035%×2；進場跟 B 版一樣）`, ''];
  for (const [setName, R0] of SETS) {
    const V = {}, order = []; const add = (k, r, swept, per, open) => { if (!V[k]) { V[k] = { R: [], w: 0, a: 0, b: 0, open: 0, rr: [] }; order.push(k); } if (open) { V[k].open++; return; } if (r == null) return; V[k].R.push(r.R); V[k][per] += r.R; if (r.R > 0) V[k].w++; };
    let n = 0; const errs = [];
    for (const sym of syms) { try {
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
        let hiR = null; { const ev = Hs.events.filter(x => x.idx <= hk && x.dir === dir).pop(); if (ev) { let a = -Infinity, b = Infinity; for (let j = ev.from; j <= hk; j++) { a = Math.max(a, htf[j].h); b = Math.min(b, htf[j].l); } hiR = up ? a : b; } }
        const h4hi = (up ? Hs.sw.hi : Hs.sw.lo).filter(x => x.conf <= hk && (up ? x.price > T : x.price < T)).sort((a, c) => up ? a.price - c.price : c.price - a.price)[0];
        const T4 = h4hi ? h4hi.price : (hiR != null && (up ? hiR > T : hiR < T) ? hiR : null);
        const TR = hiR != null && (up ? hiR > T : hiR < T) ? hiR : T;
        const stops = [['斐波 1 外 1%（現在）', away(F1, F1 * 0.01)], ['斐波 1 外 3%', away(F1, F1 * 0.03)], ['4H 區域外 1%', up ? t.poiLo * (1 - 0.01) : t.poiHi * (1 + 0.01)]];
        const tgts = [['15M 前高（現在）', T, null], ['4H 前高', T4 ?? T, null], ['4H 整段區間高點', TR, null], ['15M 前高平一半＋剩下抱到 4H 前高', T, T4 ?? T]];
        n++; const per = t.filledT < SPLIT ? 'a' : 'b';
        for (const [sk, sp] of stops) { if (up ? sp >= E : sp <= E) continue;
          for (const [tk, t1, t2] of tgts) for (const be of [false, true]) {
            let r;
            if (t2 == null || t2 === t1) r = sim(m, bosAt, jf, dir, E, sp, t1, be);
            else { const a = sim(m, bosAt, jf, dir, E, sp, t1, be);
              if (a.R == null) r = a; else if (a.hit !== 'target') r = a;
              else { const b2 = sim(m, {}, a.j + 1, dir, E, E, t2, false); const risk = Math.abs(E - sp);
                r = b2.R == null ? { R: null } : { R: 0.5 * a.R + 0.5 * (b2.hit === 'target' ? Math.abs(t2 - E) / risk : 0), hit: 'target', j: b2.j }; } }
            if (r.R == null) { add(`${sk}｜${tk}${be ? '｜套保' : ''}`, null, false, per, true); continue; }
            r.R -= 2 * FEE * E / Math.abs(E - sp);
            add(`${sk}｜${tk}${be ? '｜套保' : ''}`, r, false, per);
          } }
      }
    } catch (e) { errs.push(`${sym}: ${e.stack.split('\n').slice(0, 3).join(' / ')}`); } }
    out.push(`## ${setName}（${n} 筆成交）`, '', '| 止損｜止盈 | 筆數 | 勝率 | 累計R | 平均R | 前 8 個月 / 後 4 個月 | 還沒結束 |', '|---|---|---|---|---|---|---|');
    for (const k of order) { const v = V[k], s = v.R.reduce((a, b) => a + b, 0); out.push(`| ${k} | ${v.R.length} | ${pct(v.w, v.R.length)} | ${f1(s)} | ${f2(s / Math.max(1, v.R.length))} | ${f1(v.a)} / ${f1(v.b)} | ${v.open} |`); }
    out.push('', ...(errs.length ? [`（${errs.length} 個幣資料太短略過）`, ''] : []));
  }
  const md = out.join('\n'); console.log(md);
  fs.writeFileSync(path.join(__dirname, '..', 'research-cache', `diag4-${EXCHANGE}-${DAYS}.md`), md);
})().catch(e => { console.error(e); fs.mkdirSync(path.join(__dirname, '..', 'research-cache'), { recursive: true }); fs.writeFileSync(path.join(__dirname, '..', 'research-cache', 'diag4-error.md'), String(e.stack)); process.exit(1); });
