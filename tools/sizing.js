// 資金模擬：本金 1000U、每筆固定虧 50U（1R=50U）、止盈 2R，價格走到止盈 60%（+1.2R）後止損移到「開倉價＋手續費」
// 訊號用 intraday2.js 的 Donchian 20 突破、1H Supertrend(14,3)；同時最多 5 筆 / 不限；手續費 0.05%（BingX 市價）與 0.022%
const fs = require('fs'), path = require('path');
const { S, H, load } = require('./intraday2');
const { EXCHANGE } = require('./hist');
const OUT = path.join(__dirname, '..', 'research-cache', `sizing-${EXCHANGE}.md`);
const CAP0 = 1000, RISK = 50;

// opt: { rr, be (0~1，走到止盈幾成移保本；0 = 不移), flip (true = 保留策略原本的反向出場), maxBars }
function makeSim(opt) {
  return (bars, sigs, tf, fee) => {
    const out = []; let busy = -1;
    for (const s of sigs) {
      if (s.i <= busy || s.i + 1 >= bars.length) continue;
      const e = bars[s.i + 1].o, risk = s.riskAbs ?? Math.abs(e - s.stop); if (!(risk > 0)) continue;
      const rr = opt.rr, tp = e + s.dir * rr * risk, trig = e + s.dir * opt.be * rr * risk, last = Math.min(bars.length - 1, s.i + (opt.maxBars || s.maxBars));
      let stop = e - s.dir * risk, moved = false, exit = null, why = '', j;
      for (j = s.i + 1; j <= last; j++) {
        const b = bars[j], hitS = s.dir > 0 ? b.l <= stop : b.h >= stop, hitT = s.dir > 0 ? b.h >= tp : b.l <= tp;
        if (hitS) { exit = stop; why = moved ? '保本' : '止損'; break; }
        if (hitT) { exit = tp; why = '止盈'; break; }
        // 這根碰到 60%，下一根起止損移到開倉價＋來回手續費（不知道同一根先後，保守處理）
        if (opt.be && !moved && (s.dir > 0 ? b.h >= trig : b.l <= trig)) { moved = true; stop = e + s.dir * 2 * fee * e * 1.05; }
        if (opt.flip && s.flip && s.flip(j)) { exit = b.c; why = '反向'; break; }
      }
      if (exit == null) { j = last; exit = bars[last].c; why = '時間到'; }
      const R = s.dir * (exit - e) / risk - 2 * fee * e / risk;
      out.push({ inT: bars[s.i + 1].t, t: bars[j].t + tf, R, why, notional: RISK * e / risk });
      busy = j;
    }
    return out;
  };
}

function pick(all, n) { const acc = [], open = []; for (const r of [...all].sort((a, b) => a.inT - b.inT)) { while (open.length && open[0] <= r.inT) open.shift(); if (open.length >= n) continue; acc.push(r); open.push(r.t); open.sort((a, b) => a - b); } return acc; }

function money(q, t0) {
  q = q.filter(r => r.inT >= t0);
  // 依出場時間記帳
  const ex = [...q].sort((a, b) => a.t - b.t);
  let eq = CAP0, peak = CAP0, dd = 0, ddPct = 0, low = CAP0, streak = 0, maxStreak = 0; const mon = {}, yr = {}, why = {};
  for (const r of ex) { const u = r.R * RISK; eq += u; peak = Math.max(peak, eq); dd = Math.min(dd, eq - peak); ddPct = Math.min(ddPct, (eq - peak) / peak); low = Math.min(low, eq);
    streak = r.R < 0 ? streak + 1 : 0; maxStreak = Math.max(maxStreak, streak);
    const d = new Date(r.t); const m = d.toISOString().slice(0, 7); mon[m] = (mon[m] || 0) + u; yr[d.getUTCFullYear()] = (yr[d.getUTCFullYear()] || 0) + u;
    why[r.why] = why[r.why] || { n: 0, u: 0 }; why[r.why].n++; why[r.why].u += u; }
  // 同時持倉：最多幾筆、最大合計名目價值（要開多大槓桿）、最大同時承擔風險
  const ev = []; for (const r of q) { ev.push([r.inT, 1, r.notional]); ev.push([r.t, -1, r.notional]); }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]); let nOpen = 0, maxOpen = 0, notl = 0, maxNotl = 0;
  for (const [, d, v] of ev) { nOpen += d; notl += d * v; maxOpen = Math.max(maxOpen, nOpen); maxNotl = Math.max(maxNotl, notl); }
  const ms = Object.values(mon);
  return { n: q.length, win: q.filter(r => r.R > 0).length / q.length, eq, dd, ddPct, low, maxStreak, y25: yr[2025] || 0, y26: yr[2026] || 0, posMon: ms.filter(x => x > 0).length, months: ms.length, worstMon: Math.min(...ms), why, maxOpen, maxNotl };
}

const u = x => (x >= 0 ? '+' : '') + Math.round(x) + 'U';
(async () => {
  const data = await load();
  const syms = Object.keys(data).filter(s => data[s].htf && data[s].htf.length > 400 && data[s].ltf && data[s].ltf.length > 1000);
  const t0 = Date.UTC(2025, 0, 1);
  const STRATS = { 'Donchian 20 突破': 'J1｜Donchian 20 突破（海龜，4H 順勢，10 根反向出）', '1H Supertrend': 'C｜對照：1H Supertrend(14,3) 翻轉（4H 順勢）｜反向才出' };
  const RULES = [
    ['你的規則：1:2、走到 60% 移保本', { rr: 2, be: 0.6, flip: false }],
    ['1:2、不移保本', { rr: 2, be: 0, flip: false }],
    ['你的規則＋策略原本的反向出場', { rr: 2, be: 0.6, flip: true }],
    ['1:2、走到 50% 移保本', { rr: 2, be: 0.5, flip: false }],
    ['1:2、走到 75% 移保本', { rr: 2, be: 0.75, flip: false }],
  ];
  let md = `# 1000U 本金、每筆虧損固定 50U 的資金模擬（${EXCHANGE}，${syms.length} 幣，2025-01-01 起）\n\n` +
    `- 1R = 50U（止損打到虧 50U＋手續費）；止盈 2R = 賺 100U\n- 「移保本」：價格走到止盈的 60%（＝賺 1.2R）那根收完後，止損移到開倉價＋來回手續費\n` +
    `- 每筆最多抱 24 小時，到時間市價出場；不複利（每筆都是 50U）\n- 最大名目價值＝同時持倉的倉位總值，除以 1000U 就是至少要開的槓桿\n\n`;
  for (const fee of [0.05 / 100, 0.022 / 100]) {
    global.__FEE = fee;
    md += `## 手續費 ${(fee * 100).toFixed(3)}%${fee > 0.0003 ? '（BingX 市價單）' : '（掛單／有返佣）'}\n\n| 策略 | 規則 | 同時筆數 | 筆數 | 勝率 | 2025 | 2026 | 最後本金 | 最大回撤 | 最低本金 | 最慘月份 | 賺錢月份 | 最長連虧 | 止盈／保本／止損／時間到／反向 | 最多同時 | 最大名目價值 |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n`;
    for (const [sn, key] of Object.entries(STRATS)) for (const [rn, opt] of RULES) {
      global.__SIM = makeSim(opt);
      let all = []; for (const s of syms) { try { all = all.concat(S[key](data[s])); } catch (e) { console.error(sn, s, e.message); } }
      global.__SIM = null;
      for (const [g, n] of [['最多 5 筆', 5], ['不限', 1e9]]) {
        const x = money(pick(all, n), t0); const w = k => x.why[k] ? `${x.why[k].n}` : '0';
        md += `| ${sn} | ${rn} | ${g} | ${x.n} | ${(x.win * 100).toFixed(0)}% | ${u(x.y25)} | ${u(x.y26)} | ${Math.round(x.eq)}U | ${u(x.dd)}（${(x.ddPct * 100).toFixed(0)}%） | ${Math.round(x.low)}U | ${u(x.worstMon)} | ${x.posMon}/${x.months} | ${x.maxStreak} | ${w('止盈')}／${w('保本')}／${w('止損')}／${w('時間到')}／${w('反向')} | ${x.maxOpen} | ${Math.round(x.maxNotl)}U（${(x.maxNotl / CAP0).toFixed(0)}x） |\n`;
      }
      console.log(fee, sn, rn, 'done');
    }
    md += '\n';
  }
  console.log(md); fs.writeFileSync(OUT, md);
})().catch(e => { console.error(e); fs.writeFileSync(OUT.replace('.md', '-error.md'), String(e.stack)); process.exit(1); });
