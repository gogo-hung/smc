// 短線策略②上線前的穩定度測試（單位 R，同時最多 5 筆，手續費 0.05% 市價）
// 1. 每半年都要賺嗎  2. 參數換一換還賺嗎  3. 同時觸發時誰先進場隨機打亂 200 次  4. 加上資金費率（每 8 小時 0.01%，一律當成要付）
const fs = require('fs'), path = require('path');
const { S, load } = require('./intraday2');
const { EXCHANGE } = require('./hist');
const { makeSim, pick } = require('./margin');
const OUT = path.join(__dirname, '..', 'research-cache', `robust2-${EXCHANGE}.md`);
const H = 3600e3, RISK = 50;
const FUND = 0.0001; // 每 8 小時

function stats(q, t0, funding) {
  q = q.filter(r => !r.skip && r.inT >= t0).map(r => ({ ...r, R: r.R - (funding ? FUND * ((r.t - r.inT) / H / 8) * r.N / RISK : 0) }));
  const ex = [...q].sort((a, b) => a.t - b.t); let e = 0, p = 0, dd = 0; const half = {};
  for (const r of ex) { e += r.R; p = Math.max(p, e); dd = Math.min(dd, e - p); const d = new Date(r.t), k = `${d.getUTCFullYear()}${d.getUTCMonth() < 6 ? '上' : '下'}`; half[k] = (half[k] || 0) + r.R; }
  const hold = q.reduce((a, r) => a + (r.t - r.inT) / H, 0) / q.length;
  return { n: q.length, tot: e, dd, half, hold, avg: e / q.length };
}
const f = x => (x >= 0 ? '+' : '') + x.toFixed(0) + 'R';
const HALVES = ['2025上', '2025下', '2026上', '2026下'];

(async () => {
  const data = await load();
  const syms = Object.keys(data).filter(s => data[s].htf && data[s].htf.length > 400 && data[s].ltf && data[s].ltf.length > 1000);
  const t0 = Date.UTC(2025, 0, 1);
  global.__FEE = 0.05 / 100;
  const run = (key, opt, extraSyms) => { global.__SIM = makeSim({ ...opt, cross: true }); let all = []; for (const s of (extraSyms || syms)) { global.__SYM = s; try { all = all.concat(S[key](data[s])); } catch (e) {} } global.__SIM = null; return all; };
  const ST = 'C｜對照：1H Supertrend(14,3) 翻轉（4H 順勢）｜反向才出', DC = 'J1｜Donchian 20 突破（海龜，4H 順勢，10 根反向出）';
  let md = `# 短線策略② 穩定度測試（${EXCHANGE}，${syms.length} 幣，2025-01-01 起，同時最多 5 筆，手續費 0.05% 市價，單位 R＝每筆定損）\n\n`;
  md += `「半年」欄＝那半年賺幾 R；2026下 只到資料最後一天。資金費率用每 8 小時 0.01%、一律當成要付（偏保守）。\n\n`;

  // 1+4. 主要候選：每半年 + 資金費率
  md += `## 1. 每半年都賺嗎（含／不含資金費率）\n\n| 策略 | 資金費率 | 筆數 | 平均抱幾小時 | 平均每筆 | ${HALVES.join(' | ')} | 合計 | 最大回撤 |\n|---|---|---|---|---|${HALVES.map(() => '---').join('|')}|---|---|\n`;
  const MAIN = [
    ['Supertrend 1:3＋60% 移保本、不限時間', ST, { rr: 3, be: 0.6, maxBars: 1e6 }],
    ['Supertrend 1:3、抱 48 小時', ST, { rr: 3, be: 0, maxBars: 48 }],
    ['Donchian 1:3＋60% 移保本、抱 24 小時', DC, { rr: 3, be: 0.6 }],
    ['Donchian 1:2＋60% 移保本、不限時間', DC, { rr: 2, be: 0.6, maxBars: 1e6 }],
  ];
  const cache = {};
  for (const [name, key, opt] of MAIN) {
    const all = run(key, opt); cache[name] = all; const q = pick(all, 5);
    for (const fund of [false, true]) { const x = stats(q, t0, fund);
      md += `| ${name} | ${fund ? '有' : '沒有'} | ${x.n} | ${x.hold.toFixed(0)} | ${(x.avg >= 0 ? '+' : '') + x.avg.toFixed(3)}R | ${HALVES.map(h => f(x.half[h] || 0)).join(' | ')} | ${f(x.tot)} | ${x.dd.toFixed(0)}R |\n`; }
    console.log(name, 'main done');
  }

  // 2. 換參數
  md += `\n## 2. 換參數還賺嗎（含資金費率）\n\n`;
  const I2 = require('./intraday2');
  md += `### Supertrend（ATR 週期, 倍數）× 盈虧比 × 移保本位置，不限時間\n\n| Supertrend | 盈虧比 | 移保本 | 筆數 | ${HALVES.join(' | ')} | 合計 | 回撤 | 4 個半年都賺 |\n|---|---|---|---|${HALVES.map(() => '---').join('|')}|---|---|---|\n`;
  let stOk = 0, stTot = 0, stPos = 0;
  for (const [n, k] of [[10, 3], [14, 3], [20, 3], [14, 2.5], [14, 4]]) for (const rr of [2, 3, 4]) for (const be of [0.5, 0.6, 0.75]) {
    const key = `__st_${n}_${k}`; if (!S[key]) S[key] = I2.flipST(n, k);
    const x = stats(pick(run(key, { rr, be, maxBars: 1e6 }), 5), t0, true); const all4 = HALVES.every(h => (x.half[h] || 0) > 0);
    stTot++; if (x.tot > 0) stPos++; if (all4) stOk++;
    md += `| (${n}, ${k}) | 1:${rr} | ${be * 100}% | ${x.n} | ${HALVES.map(h => f(x.half[h] || 0)).join(' | ')} | ${f(x.tot)} | ${x.dd.toFixed(0)}R | ${all4 ? '✅' : ''} |\n`;
  }
  md += `\n**Supertrend：${stTot} 組裡 ${stPos} 組合計賺錢、${stOk} 組 4 個半年都賺**\n\n`;
  md += `### Donchian（突破幾根 × 止損幾倍 ATR）× 盈虧比，60% 移保本、抱 24 小時\n\n| 突破 | 止損 | 盈虧比 | 筆數 | ${HALVES.join(' | ')} | 合計 | 回撤 | 4 個半年都賺 |\n|---|---|---|---|${HALVES.map(() => '---').join('|')}|---|---|---|\n`;
  let dcOk = 0, dcTot = 0, dcPos = 0;
  for (const nb of [15, 20, 30, 55]) for (const am of [1.5, 2, 3]) for (const rr of [2, 3]) {
    const key = `__dc_${nb}_${am}`; if (!S[key]) S[key] = I2.donchian(nb, am);
    const x = stats(pick(run(key, { rr, be: 0.6 }), 5), t0, true); const all4 = HALVES.every(h => (x.half[h] || 0) > 0);
    dcTot++; if (x.tot > 0) dcPos++; if (all4) dcOk++;
    md += `| ${nb} | ${am}×ATR | 1:${rr} | ${x.n} | ${HALVES.map(h => f(x.half[h] || 0)).join(' | ')} | ${f(x.tot)} | ${x.dd.toFixed(0)}R | ${all4 ? '✅' : ''} |\n`;
  }
  md += `\n**Donchian：${dcTot} 組裡 ${dcPos} 組合計賺錢、${dcOk} 組 4 個半年都賺**\n\n`;

  // 3. 隨機打亂
  md += `## 3. 同時觸發時誰先進場，隨機打亂 200 次（含資金費率）\n\n| 策略 | 合計賺錢 | 4 個半年都賺 | 合計中位數 | 最差 5% | 最好 5% |\n|---|---|---|---|---|---|\n`;
  for (const [name] of MAIN) {
    const all = cache[name].filter(r => !r.skip && r.inT >= t0); let pos = 0, all4 = 0; const tots = [];
    for (let k = 0; k < 200; k++) { const sh = all.map(r => ({ ...r, inT: r.inT + Math.random() * H * 0.999 })); const x = stats(pick(sh, 5), t0, true); tots.push(x.tot); if (x.tot > 0) pos++; if (HALVES.every(h => (x.half[h] || 0) > 0)) all4++; }
    tots.sort((a, b) => a - b);
    md += `| ${name} | ${pos}/200 | ${all4}/200 | ${f(tots[100])} | ${f(tots[10])} | ${f(tots[189])} |\n`;
  }
  console.log(md); fs.writeFileSync(OUT, md);
})().catch(e => { console.error(e); fs.writeFileSync(OUT.replace('.md', '-error.md'), String(e.stack)); process.exit(1); });
