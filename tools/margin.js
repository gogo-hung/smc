// 照使用者開單方式回測：本金 1000U、每筆定損 50U、保證金 100U（逐倉），槓桿 = 倉位 ÷ 100U
// 倉位 = 50U ÷ 止損距離%；槓桿超過上限就開不了（跳過）；爆倉價比止損近 → 先爆倉，虧掉整筆保證金
// 假設（BingX 實際以交易規則表為準）：BTC/ETH 最高 125 倍、維持保證金率 0.4%；其他幣 50 倍、1%；強平另扣 0.5% 名目當強平費
const fs = require('fs'), path = require('path');
const { S, load } = require('./intraday2');
const { EXCHANGE } = require('./hist');
const OUT = path.join(__dirname, '..', 'research-cache', `margin-${EXCHANGE}.md`);
const CAP0 = 1000, RISK = 50, MARGIN = 100;
const spec = sym => /^(BTC|ETH)/i.test(sym) ? { max: 125, mmr: 0.004 } : { max: 50, mmr: 0.01 };

function makeSim(opt) {
  return (bars, sigs, tf, fee) => {
    const out = []; let busy = -1; const sp = spec(global.__SYM);
    for (const s of sigs) {
      if (s.i <= busy || s.i + 1 >= bars.length) continue;
      const e = bars[s.i + 1].o, risk = s.riskAbs ?? Math.abs(e - s.stop); if (!(risk > 0)) continue;
      const dist = risk / e, N = RISK / dist, lev = N / MARGIN;
      if (opt.minDist && dist < opt.minDist) continue;
      if (lev > sp.max) { out.push({ inT: bars[s.i + 1].t, t: bars[s.i + 1].t, R: 0, why: '槓桿不夠跳過', skip: true, lev, N }); continue; }
      const liqDist = (MARGIN - sp.mmr * N) / N, liqFirst = liqDist <= dist;
      const tp = e + s.dir * opt.rr * risk, trig = e + s.dir * opt.be * opt.rr * risk, last = Math.min(bars.length - 1, s.i + (opt.maxBars || s.maxBars));
      let stop = liqFirst ? e - s.dir * liqDist * e : e - s.dir * risk, moved = false, exit = null, why = '', j;
      for (j = s.i + 1; j <= last; j++) {
        const b = bars[j], hitS = s.dir > 0 ? b.l <= stop : b.h >= stop, hitT = s.dir > 0 ? b.h >= tp : b.l <= tp;
        if (hitS) { exit = stop; why = moved ? '保本' : liqFirst ? '爆倉' : '止損'; break; }
        if (hitT) { exit = tp; why = '止盈'; break; }
        if (opt.be && !moved && (s.dir > 0 ? b.h >= trig : b.l <= trig)) { moved = true; stop = e + s.dir * 2 * fee * e * 1.05; }
      }
      if (exit == null) { j = last; exit = bars[last].c; why = '時間到'; }
      let U = why === '爆倉' ? -MARGIN - 0.005 * N : N * s.dir * (exit - e) / e;
      U -= 2 * fee * N;
      out.push({ inT: bars[s.i + 1].t, t: bars[j].t + tf, R: U / RISK, U, why, lev, N });
      busy = j;
    }
    return out;
  };
}

function pick(all, n) { const acc = [], open = []; for (const r of [...all].sort((a, b) => a.inT - b.inT)) { if (r.skip) { acc.push(r); continue; } while (open.length && open[0] <= r.inT) open.shift(); if (open.length >= n) continue; acc.push(r); open.push(r.t); open.sort((a, b) => a - b); } return acc; }

function money(q, t0) {
  q = q.filter(r => r.inT >= t0); const sk = q.filter(r => r.skip); q = q.filter(r => !r.skip);
  const ex = [...q].sort((a, b) => a.t - b.t);
  let eq = CAP0, peak = CAP0, dd = 0, low = CAP0, streak = 0, maxStreak = 0, bust = null; const mon = {}, yr = {}, why = {};
  for (const r of ex) { eq += r.U; peak = Math.max(peak, eq); dd = Math.min(dd, eq - peak); low = Math.min(low, eq); if (eq <= 0 && !bust) bust = new Date(r.t).toISOString().slice(0, 10);
    streak = r.U < 0 ? streak + 1 : 0; maxStreak = Math.max(maxStreak, streak);
    const d = new Date(r.t), m = d.toISOString().slice(0, 7); mon[m] = (mon[m] || 0) + r.U; yr[d.getUTCFullYear()] = (yr[d.getUTCFullYear()] || 0) + r.U;
    why[r.why] = (why[r.why] || 0) + 1; }
  const levs = q.map(r => r.lev).sort((a, b) => a - b), fees = q.reduce((a, r) => a + 2 * global.__FEE * r.N, 0);
  const ms = Object.values(mon);
  return { n: q.length, skip: sk.length, win: q.filter(r => r.U > 0).length / q.length, eq, dd, low, bust, maxStreak, y25: yr[2025] || 0, y26: yr[2026] || 0, posMon: ms.filter(x => x > 0).length, months: ms.length, why,
    levMed: levs[Math.floor(levs.length / 2)], lev90: levs[Math.floor(levs.length * 0.9)], fees };
}

const u = x => (x >= 0 ? '+' : '') + Math.round(x) + 'U';
(async () => {
  const data = await load();
  const syms = Object.keys(data).filter(s => data[s].htf && data[s].htf.length > 400 && data[s].ltf && data[s].ltf.length > 1000);
  const t0 = Date.UTC(2025, 0, 1);
  const STRATS = { 'Donchian 20 突破': 'J1｜Donchian 20 突破（海龜，4H 順勢，10 根反向出）', '1H Supertrend': 'C｜對照：1H Supertrend(14,3) 翻轉（4H 順勢）｜反向才出' };
  const RULES = [
    ['1:2＋走到 60% 移保本（對照）', { rr: 2, be: 0.6 }],
    ['1:2、不移保本（對照）', { rr: 2, be: 0 }],
    ['1:3＋走到 60% 移保本', { rr: 3, be: 0.6 }],
    ['1:3、不移保本', { rr: 3, be: 0 }],
    ['1:3＋60% 移保本＋止損 < 0.8% 不做', { rr: 3, be: 0.6, minDist: 0.008 }],
    ['1:3、不移保本、最多抱 48 小時', { rr: 3, be: 0, maxBars: 48 }],
  ];
  const UNIV = [['全部幣', syms], ['只做 BTC', syms.filter(s => /^BTC/i.test(s))]];
  let md = `# 照你的開單方式回測：盈虧比 1:2 vs 1:3（${EXCHANGE}，2025-01-01 起，同時最多 5 筆）\n\n` +
    `- 本金 1000U；每筆定損 50U；每筆保證金 100U（逐倉）；倉位 = 50U ÷ 止損距離；槓桿 = 倉位 ÷ 100U\n` +
    `- 假設：BTC/ETH 最高 125 倍、維持保證金率 0.4%；其他幣最高 50 倍、1%（BingX 實際以交易規則表為準）\n` +
    `- 槓桿超過上限 → 開不了（跳過）；爆倉價比止損近 → 先被強平，虧掉 100U 保證金＋強平費\n` +
    `- 手續費 0.05%（市價）按倉位收，進出各一次；每筆最多抱 24 小時（有註明的除外）；不複利\n\n`;
  for (const fee of [0.05 / 100, 0.02 / 100]) {
    global.__FEE = fee;
    md += `## 手續費 ${(fee * 100).toFixed(2)}%${fee > 0.0003 ? '（市價單）' : '（限價掛單）'}\n\n| 策略 | 幣 | 規則 | 開單 | 槓桿不夠跳過 | 勝率 | 2025 | 2026 | 最後本金 | 本金最低 | 爆倉日 | 最大回撤 | 賺錢月份 | 最長連虧 | 止盈／保本／止損／爆倉／時間到 | 槓桿中位數 | 9 成單在幾倍內 | 手續費合計 |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n`;
    for (const [sn, key] of Object.entries(STRATS)) for (const [un, list] of UNIV) for (const [rn, opt] of RULES) {
      global.__SIM = makeSim(opt);
      let all = []; for (const s of list) { global.__SYM = s; try { all = all.concat(S[key](data[s])); } catch (e) { console.error(sn, s, e.message); } }
      global.__SIM = null;
      const x = money(pick(all, 5), t0); if (!x.n) { md += `| ${sn} | ${un} | ${rn} | 0 |\n`; continue; }
      const w = k => x.why[k] || 0;
      md += `| ${sn} | ${un} | ${rn} | ${x.n} | ${x.skip} | ${(x.win * 100).toFixed(0)}% | ${u(x.y25)} | ${u(x.y26)} | ${Math.round(x.eq)}U | ${Math.round(x.low)}U | ${x.bust || '沒有'} | ${u(x.dd)} | ${x.posMon}/${x.months} | ${x.maxStreak} | ${w('止盈')}／${w('保本')}／${w('止損')}／${w('爆倉')}／${w('時間到')} | ${x.levMed.toFixed(0)}x | ${x.lev90.toFixed(0)}x | ${u(-x.fees)} |\n`;
      console.log(fee, sn, un, rn, 'done');
    }
    md += '\n';
  }
  console.log(md); fs.writeFileSync(OUT, md);
})().catch(e => { console.error(e); fs.writeFileSync(OUT.replace('.md', '-error.md'), String(e.stack)); process.exit(1); });
