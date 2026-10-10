// 每個特徵切三等分，看平均 R：找出哪些特徵真的跟賺錢有關
const fs = require('fs'), path = require('path');
const SMC = require('../src/smc');
const { load, DAYS } = require('./hist');
const RULES = { swingLen:3, htfSwing:3, breakBy:'close', obInvalid:'close', fibMin:0.618, emaLen:50, lookback:10, entry:'close', minRR:3, stopBuf:0.2, target:'htf', btcFilter:'block', fundingMax:0.05, side:'both', stopMode:'ob',
  pattern:'engulf', cFib:'need', cEma:'need', cFvg:'need', cSweep:'score', cDaily:'score', minScore:0, beAt:0.5, ...(process.env.RULES ? JSON.parse(process.env.RULES) : {}) };
(async () => {
  const data = await load(); const syms = Object.keys(data);
  const btc = SMC.trendSeries(data.BTC.htf, RULES);
  let trades = [];
  for (const s of syms) trades = trades.concat(SMC.backtest(s, data[s].ltf, data[s].htf, RULES, { feePct: 0.06, maxWait: 24, btcDirAt: btc }).trades);
  const done = trades.filter(t => t.R != null && t.feat).sort((a, b) => a.t - b.t);
  const mid = done[Math.floor(done.length / 2)].t;
  const keys = Object.keys(done[0].feat);
  const f = v => (v > 0 ? '+' : '') + v.toFixed(2);
  const grp = a => a.length ? `${a.length} 筆 ${(a.filter(t => t.R > 0).length / a.length * 100).toFixed(0)}% ${f(a.reduce((x, t) => x + t.R, 0) / a.length)}` : '—';
  const out = [`# 特徵分析（${DAYS} 天，${done.length} 筆已結算，平均 ${f(done.reduce((x, t) => x + t.R, 0) / done.length)}R）`, '', '| 特徵 | 分組 | 範圍 | 全部 | 前半 | 後半 |', '|---|---|---|---|---|---|'];
  for (const k of keys) {
    const vals = [...new Set(done.map(t => t.feat[k]))];
    let groups;
    if (vals.length <= 2) groups = vals.sort().map(v => ({ name: `=${v}`, a: done.filter(t => t.feat[k] === v) }));
    else { const sv = done.map(t => t.feat[k]).sort((a, b) => a - b), q1 = sv[Math.floor(sv.length / 3)], q2 = sv[Math.floor(sv.length * 2 / 3)];
      groups = [{ name: `低 <${q1.toFixed(2)}`, a: done.filter(t => t.feat[k] < q1) }, { name: `中`, a: done.filter(t => t.feat[k] >= q1 && t.feat[k] < q2) }, { name: `高 ≥${q2.toFixed(2)}`, a: done.filter(t => t.feat[k] >= q2) }]; }
    groups.forEach((g, i) => out.push(`| ${i ? '' : k} | ${i} | ${g.name} | ${grp(g.a)} | ${grp(g.a.filter(t => t.t < mid))} | ${grp(g.a.filter(t => t.t >= mid))} |`));
  }
  const md = out.join('\n'); console.log(md);
  fs.writeFileSync(path.join(__dirname, '..', 'research-cache', `feat-${DAYS}.md`), md);
  fs.writeFileSync(path.join(__dirname, '..', 'research-cache', `trades-${DAYS}.json`), JSON.stringify(done.map(t => ({ t: t.t, sym: t.sym, dir: t.dir, R: +t.R.toFixed(3), s: t.status, ...t.feat }))));
})().catch(e => { console.error(e); process.exit(1); });
