// 研究用回測：抓 BingX 歷史（快取到 research-cache/），跑 tools/configs.json 裡的每組設定，輸出比較表
const fs = require('fs'), path = require('path');
const SMC = require('../src/smc');
const OLD = require('./smc_old');
const { load, DAYS } = require('./hist');

const f2 = v => (v > 0 ? '+' : '') + v.toFixed(1);
function stats(trades) {
  const done = trades.filter(t => t.R != null).sort((a, b) => a.closedT - b.closedT);
  const wins = done.filter(t => t.R > 0), sw = wins.reduce((a, t) => a + t.R, 0), sl = done.filter(t => t.R <= 0).reduce((a, t) => a + t.R, 0);
  let eq = 0, pk = 0, dd = 0, st = 0, ms = 0;
  for (const t of done) { eq += t.R; pk = Math.max(pk, eq); dd = Math.min(dd, eq - pk); st = t.R <= 0 ? st + 1 : 0; ms = Math.max(ms, st); }
  return { n: done.length, wr: done.length ? wins.length / done.length : 0, R: sw + sl, avg: done.length ? (sw + sl) / done.length : 0, pf: sl < 0 ? sw / -sl : 0, dd, ms, be: done.filter(t => t.status === 'be').length };
}

(async () => {
  const data = await load();
  const syms = Object.keys(data);
  let t0 = Infinity, t1 = 0;
  for (const s of syms) { const l = data[s].ltf; if (l.length > 310) { t0 = Math.min(t0, l[300].t); t1 = Math.max(t1, l[l.length - 1].t); } }
  const mid = (t0 + t1) / 2;
  const base = JSON.parse(fs.readFileSync(path.join(__dirname, 'base.json'), 'utf8'));
  const configs = JSON.parse(fs.readFileSync(path.join(__dirname, 'configs.json'), 'utf8'));
  const rows = [];
  for (const c of configs) {
    const E = c.engine === 'old' ? OLD : SMC;
    let trades = [];
    for (const part of (c.parts || [c.rules])) {   // parts：多單、空單用不同設定，合併成一個帳戶
      const rules = { ...base, ...part };
      const btc = data.BTC ? E.trendSeries(data.BTC.htf, rules) : null;
      for (const s of syms) trades = trades.concat(E.backtest(s, data[s].ltf, data[s].htf, rules, { feePct: 0.06, maxWait: 24, btcDirAt: btc, htfWindow: c.engine === 'old' ? 200 : 500 }).trades);
    }
    const all = stats(trades), h1 = stats(trades.filter(t => t.t < mid)), h2 = stats(trades.filter(t => t.t >= mid));
    const L = stats(trades.filter(t => t.dir > 0)), S = stats(trades.filter(t => t.dir < 0));
    const Z = stats(trades.filter(t => t.zone === 'fvg')), O = stats(trades.filter(t => t.zone !== 'fvg'));
    rows.push({ name: c.name, ...all, r1: h1.R, r2: h2.R, lR: L.R, sR: S.R, zf: `${Z.n}筆 ${f2(Z.R)}`, zo: `${O.n}筆 ${f2(O.R)}` });
    console.log(`${c.name}: n=${all.n} wr=${(all.wr * 100).toFixed(0)}% R=${all.R.toFixed(1)} pf=${all.pf.toFixed(2)}`);
  }
  const f = v => (v > 0 ? '+' : '') + v.toFixed(1);
  const md = ['| 設定 | 筆數 | 勝率 | 累計R | 平均R | PF | 回撤 | 連虧 | 保本 | 前半/後半 | 多/空 | FVG進場 | OB進場 |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map(r => `| ${r.name} | ${r.n} | ${(r.wr * 100).toFixed(0)}% | ${f(r.R)} | ${f(r.avg)} | ${r.pf.toFixed(2)} | ${r.dd.toFixed(1)} | ${r.ms} | ${r.be} | ${f(r.r1)} / ${f(r.r2)} | ${f(r.lR)} / ${f(r.sR)} | ${r.zf} | ${r.zo} |`)].join('\n');
  console.log('\n' + md);
  fs.writeFileSync(path.join(__dirname, '..', 'research-cache', `result-${DAYS}.md`), md);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## ${new Date(t0).toISOString().slice(0, 10)} – ${new Date(t1).toISOString().slice(0, 10)}（${syms.length} 幣）\n\n${md}\n`);
})().catch(e => { console.error(e); process.exit(1); });
