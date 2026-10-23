// hyperopt 用的回測工人：資料只載入一次，之後從 stdin 一行一個 JSON {id, rules}，回一行 JSON 結果
// 回傳 train（SPLIT 之前）和 test（SPLIT 之後）分開的統計，找參數只能看 train
const readline = require('readline');
const SMC = require('../src/smc');
const { load } = require('./hist');
const SPLIT = Date.parse(process.env.SPLIT || '2026-06-20');
const FEE = +(process.env.FEE || 0.035);

function stats(tr) {
  const d = tr.filter(t => t.R != null).sort((a, b) => a.closedT - b.closedT);
  const n = d.length; if (!n) return { n: 0, wr: 0, R: 0, avg: 0, sd: 0, pf: 0, dd: 0 };
  let eq = 0, pk = 0, dd = 0, w = 0, gw = 0, gl = 0;
  for (const t of d) { eq += t.R; pk = Math.max(pk, eq); dd = Math.min(dd, eq - pk); if (t.R > 0) { w++; gw += t.R; } else gl -= t.R; }
  const avg = eq / n, sd = Math.sqrt(d.reduce((a, t) => a + (t.R - avg) ** 2, 0) / Math.max(1, n - 1));
  return { n, wr: w / n, R: eq, avg, sd, pf: gl > 0 ? gw / gl : 0, dd };
}

(async () => {
  const data = await load();
  const syms = Object.keys(data).filter(s => data[s].m15 && data[s].m15.length > 500);
  const base = require('./base.json');
  process.stdout.write(JSON.stringify({ ready: true, syms: syms.length }) + '\n');
  const rl = readline.createInterface({ input: process.stdin });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const { id, rules: r } = JSON.parse(line);
    try {
      const rules = { ...base, ...r };
      const btc = data.BTC ? SMC.trendSeries(data.BTC.htf, rules) : null;
      let tr = [];
      for (const s of syms) tr = tr.concat(SMC.backtest(s, data[s].m15, data[s].htf, rules, { feePct: FEE, btcDirAt: btc }).trades);
      process.stdout.write(JSON.stringify({ id, train: stats(tr.filter(t => t.t < SPLIT)), test: stats(tr.filter(t => t.t >= SPLIT)) }) + '\n');
    } catch (e) { process.stdout.write(JSON.stringify({ id, error: e.message }) + '\n'); }
  }
})().catch(e => { console.error(e); process.exit(1); });
