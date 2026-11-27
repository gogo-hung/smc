// 掃幣範圍測試：策略只掃成交額前 60 名 vs 掃全部幣，冷門幣會不會拖累策略
// 依「目前」成交額排名分組（前 60／61～120／121 名以後），每組看平均每筆 R；再看同時最多 5 筆時，前 60 vs 全部
// 冷門幣滑價比較大：另外算「進出場各多 0.1% 滑價」的版本
const fs = require('fs'), path = require('path');
const { load, EXCHANGE } = require('./hist');
const { S } = require('./intraday2');
const { makeSim, pick } = require('./margin');
const T = require('../src/trend');
const OUT = path.join(__dirname, '..', 'research-cache', `universe-${EXCHANGE}.md`);
const H1 = 3600e3, H4 = 4 * H1, RISK = 50, FUND = 0.0001, FEE = 0.0005;
const ST = 'C｜對照：1H Supertrend(14,3) 翻轉（4H 順勢）｜反向才出';

(async () => {
  const data = await load();
  const ranked = Object.keys(data); // hist 依成交額排序放入
  const syms = ranked.filter(s => data[s].htf && data[s].htf.length > 400 && data[s].ltf && data[s].ltf.length > 1000);
  const rank = new Map(ranked.map((s, i) => [s, i + 1]));
  const t0 = Date.UTC(2025, 0, 1);
  const tier = s => rank.get(s) <= 60 ? 'A' : rank.get(s) <= 120 ? 'B' : 'C';
  const TIERS = { A: '前 60 名', B: '61～120 名', C: '121 名以後' };

  // 趨勢策略（上線版 src/trend.js，不限筆數＝網站實際做法）
  const trend = [];
  for (const sym of syms) {
    const h1 = data[sym].ltf, h4 = data[sym].htf, i1 = new Map(h1.map((b, i) => [b.t, i])), bos = T.bosMap(h1); let busy = -1;
    for (const sg of T.signals(h4)) {
      const closeT = sg.t + H4; if (closeT <= busy) continue; const jE = i1.get(closeT); if (jE == null) continue;
      const E = h1[jE].o, s = { dir: sg.dir, entry: E, stop0: E - sg.dir * 2 * sg.atr, stop: E - sg.dir * 2 * sg.atr, atr: sg.atr, ext: E, be: false, filledAt: h1[jE].t };
      let ex = null, j; for (j = jE; j < h1.length; j++) { const ev = T.step(s, h1[j], bos.get(h1[j].t)); ex = ev.find(e => e.k === 'exit'); if (ex) break; }
      if (!ex) break; const risk = Math.abs(E - s.stop0), hrs = (h1[j].t + H1 - h1[jE].t) / H1;
      const cost = (2 * FEE * E + FUND * hrs / 8 * E) / risk, slip = 2 * 0.001 * E / risk;
      trend.push({ sym, inT: h1[jE].t, t: h1[j].t + H1, R: ex.R - cost, Rs: ex.R - cost - slip, stopPct: risk / E * 100 }); busy = h1[j].t + H1;
    }
  }

  // 訊號策略（Supertrend 1:3＋60% 移保本、不限時間，含手續費；資金費率另扣）
  global.__FEE = FEE; global.__SIM = makeSim({ rr: 3, be: 0.6, maxBars: 1e6, cross: true });
  let sig = [];
  for (const s of syms) { global.__SYM = s; try { sig = sig.concat(S[ST](data[s]).map(r => ({ ...r, sym: s }))); } catch (e) {} }
  global.__SIM = null;
  sig = sig.map(r => { if (r.skip) return r; const R = r.R - FUND * ((r.t - r.inT) / H1 / 8) * r.N / RISK; return { ...r, R, Rs: R - 2 * 0.001 * r.N / RISK }; });

  const st = (q, k = 'R') => { q = q.filter(r => !r.skip && r.inT >= t0).sort((a, b) => a.t - b.t); let e = 0, p = 0, d = 0; const y = {};
    for (const r of q) { e += r[k]; p = Math.max(p, e); d = Math.min(d, e - p); const yy = new Date(r.t).getUTCFullYear(); y[yy] = (y[yy] || 0) + r[k]; }
    const w = q.filter(r => r[k] > 0).length;
    return { n: q.length, tot: e, dd: d, y, avg: q.length ? e / q.length : 0, win: q.length ? w / q.length * 100 : 0 }; };
  const g = x => (x >= 0 ? '+' : '') + x.toFixed(1);
  const rowT = (name, x) => `| ${name} | ${x.n} | ${x.win.toFixed(0)}% | ${g(x.avg * 1)}R | ${g(x.y[2025] || 0)}R | ${g(x.y[2026] || 0)}R | ${g(x.tot)}R | ${x.dd.toFixed(1)}R |\n`;
  const HD = `| 範圍 | 筆數 | 勝率 | 平均每筆 | 2025 | 2026 | 合計 | 最大回撤 |\n|---|---|---|---|---|---|---|---|\n`;

  const cnt = k => syms.filter(s => tier(s) === k).length;
  let md = `# 掃幣範圍測試：前 60 名 vs 全部幣（${EXCHANGE}，${syms.length} 幣有足夠資料，2025-01-01 起）\n\n`;
  md += `排名用「現在」的 24h 成交額（OKX、成交額 ≥ 500 萬 U 才收），各組幣數：前 60 名 ${cnt('A')}、61～120 名 ${cnt('B')}、121 名以後 ${cnt('C')}。手續費市價 0.05%×2＋資金費率每 8h 0.01%。「＋滑價」＝進出場各再多 0.1%（冷門幣掛單薄，市價單容易滑）。\n\n`;
  for (const [name, all, caps] of [['📈 趨勢策略（網站是不限筆數）', trend, [Infinity, 5]], ['⚡ 訊號策略（網站是同時最多 5 筆）', sig, [5]]]) {
    md += `## ${name}\n\n### 各組分開看（不限筆數，看每一組的幣本身有沒有優勢）\n\n` + HD;
    for (const k of ['A', 'B', 'C']) { const q = all.filter(r => tier(r.sym) === k); md += rowT(TIERS[k], st(q)); md += rowT(TIERS[k] + '＋滑價', st(q, 'Rs')); }
    md += `\n### 網站實際做法：掃前 60 名 vs 掃全部\n\n` + HD;
    for (const cap of caps) {
      const top = all.filter(r => tier(r.sym) === 'A'), lab = cap === Infinity ? '不限筆數' : `同時最多 ${cap} 筆`;
      md += rowT(`前 60 名・${lab}`, st(cap === Infinity ? top : pick(top, cap)));
      md += rowT(`全部・${lab}`, st(cap === Infinity ? all : pick(all, cap)));
      md += rowT(`全部・${lab}＋滑價`, st(cap === Infinity ? all : pick(all, cap), 'Rs'));
      md += rowT(`前 120 名・${lab}`, st(cap === Infinity ? all.filter(r => tier(r.sym) !== 'C') : pick(all.filter(r => tier(r.sym) !== 'C'), cap)));
    }
    md += '\n';
  }
  // 同時持倉數（趨勢策略不限筆數時，掃全部會同時開幾筆）
  const peak = q => { const ev = []; q.filter(r => r.inT >= t0).forEach(r => { ev.push([r.inT, 1]); ev.push([r.t, -1]); }); ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]); let c = 0, m = 0; for (const [, d] of ev) { c += d; m = Math.max(m, c); } return m; };
  md += `趨勢策略不限筆數時最多同時持倉：前 60 名 ${peak(trend.filter(r => tier(r.sym) === 'A'))} 筆、全部 ${peak(trend)} 筆。\n`;
  fs.writeFileSync(OUT, md); console.log(md);
})();
