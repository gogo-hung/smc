// 本金變多就把定損加大（複利）：本金 1000U、起始定損 50U、槓桿不限（全倉不會單筆爆倉）、同時最多 5 筆
// 每筆的 R（含手續費）跟倉位大小無關，所以先算出每筆幾 R，再依「進場當下的本金」決定這筆定損多少 U
const fs = require('fs'), path = require('path');
const { S, load } = require('./intraday2');
const { EXCHANGE } = require('./hist');
const { makeSim, pick } = require('./margin');
const OUT = path.join(__dirname, '..', 'research-cache', `compound-${EXCHANGE}.md`);
const CAP0 = 1000;

// 定損規則：輸入進場時的本金，回傳這筆要虧多少 U
const SIZING = [
  ['固定 50U（對照）', eq => 50],
  ['每多 1000U 定損加 50U（1000→50、2000→100、3000→150…，跌回去就降）', eq => 50 * Math.max(1, Math.floor(eq / 1000))],
  ['本金翻倍才加倍（1000→50、2000→100、4000→200…，跌回去就降）', eq => 50 * Math.pow(2, Math.max(0, Math.floor(Math.log2(Math.max(eq, 1) / 1000))))],
  ['每筆本金的 5%（隨時跟著本金調）', eq => eq * 0.05],
  ['每筆本金的 3%', eq => eq * 0.03],
  ['每筆本金的 2%', eq => eq * 0.02],
  ['每筆本金的 10%', eq => eq * 0.10],
];

function run(trades, sizing, t0) {
  const q = trades.filter(r => !r.skip && r.inT >= t0);
  const ev = []; q.forEach((r, k) => { ev.push([r.inT, 1, k]); ev.push([r.t, 0, k]); }); ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let eq = CAP0, peak = CAP0, ddPct = 0, low = CAP0, bust = null, maxRisk = 0; const risk = {}, yr = {}, mon = {}, start = {}, eqAt = {};
  for (const [t, isIn, k] of ev) {
    if (bust) break;
    const d = new Date(t), y = d.getUTCFullYear(), m = d.toISOString().slice(0, 7);
    if (!(y in start)) start[y] = eq; if (!(m in mon)) mon[m] = eq;
    if (isIn) { risk[k] = Math.max(0, sizing(eq)); maxRisk = Math.max(maxRisk, risk[k]); continue; }
    if (!(k in risk)) continue;
    eq += q[k].R * risk[k]; peak = Math.max(peak, eq); ddPct = Math.min(ddPct, (eq - peak) / peak); low = Math.min(low, eq);
    if (eq <= 0) { bust = m; eq = 0; }
  }
  const ys = Object.keys(start).map(Number).sort(); const yEnd = y => start[y + 1] ?? eq;
  const ms = Object.keys(mon).sort(); let posMon = 0; ms.forEach((m, i) => { const e = i + 1 < ms.length ? mon[ms[i + 1]] : eq; if (e > mon[m]) posMon++; });
  return { eq, low, ddPct, bust, maxRisk, y25: start[2025] != null ? yEnd(2025) / start[2025] : 1, y26: start[2026] != null ? yEnd(2026) / start[2026] : 1, e25: yEnd(2025), posMon, months: ms.length };
}

const fx = x => x >= 100 ? Math.round(x) + ' 倍' : x.toFixed(2) + ' 倍';
(async () => {
  const data = await load();
  const syms = Object.keys(data).filter(s => data[s].htf && data[s].htf.length > 400 && data[s].ltf && data[s].ltf.length > 1000);
  const t0 = Date.UTC(2025, 0, 1);
  const CFG = [
    ['Supertrend 1:3＋60% 移保本、不限時間', 'C｜對照：1H Supertrend(14,3) 翻轉（4H 順勢）｜反向才出', { rr: 3, be: 0.6, cross: true, maxBars: 1e6 }],
    ['Donchian 1:3＋60% 移保本、最多抱 24 小時', 'J1｜Donchian 20 突破（海龜，4H 順勢，10 根反向出）', { rr: 3, be: 0.6, cross: true }],
  ];
  let md = `# 本金變多就加大定損（複利）回測（${EXCHANGE}，${syms.length} 幣，2025-01-01 起，同時最多 5 筆）\n\n` +
    `- 本金 1000U，起始定損 50U；槓桿不限（全倉、不會單筆爆倉）；每筆定損看「進場當下已實現的本金」決定\n` +
    `- 本金歸零就停（爆倉）；手續費按倉位收（倉位 = 定損 ÷ 止損距離）\n- 「2025」「2026」是那一年本金變成幾倍\n\n`;
  for (const fee of [0.05 / 100, 0.02 / 100]) {
    global.__FEE = fee;
    md += `## 手續費 ${(fee * 100).toFixed(2)}%${fee > 0.0003 ? '（市價單）' : '（限價掛單）'}\n\n`;
    for (const [name, key, opt] of CFG) {
      global.__SIM = makeSim(opt); let all = [];
      for (const s of syms) { global.__SYM = s; try { all = all.concat(S[key](data[s])); } catch (e) { console.error(name, s, e.message); } }
      global.__SIM = null;
      const trades = pick(all, 5);
      md += `### ${name}\n\n| 加碼方式 | 最後本金 | 2025 | 2026 | 本金最低 | 最大回撤 | 爆倉 | 賺錢月份 | 單筆定損最大到 |\n|---|---|---|---|---|---|---|---|---|\n`;
      for (const [sn, fn] of SIZING) {
        const x = run(trades, fn, t0);
        md += `| ${sn} | ${Math.round(x.eq).toLocaleString()}U | ${fx(x.y25)} | ${fx(x.y26)} | ${Math.round(x.low)}U | ${(x.ddPct * 100).toFixed(0)}% | ${x.bust || '沒有'} | ${x.posMon}/${x.months} | ${Math.round(x.maxRisk).toLocaleString()}U |\n`;
      }
      md += '\n'; console.log(fee, name, 'done');
    }
  }
  console.log(md); fs.writeFileSync(OUT, md);
})().catch(e => { console.error(e); fs.writeFileSync(OUT.replace('.md', '-error.md'), String(e.stack)); process.exit(1); });
