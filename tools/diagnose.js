// 拆解 MTF 策略（4H CHoCH 區域 → 15M CHoCH → 0.715）每一步的表現，找出虧在哪
const fs = require('fs'), path = require('path');
const SMC = require('../src/smc');
const { load, DAYS, EXCHANGE } = require('./hist');
const FEE = 0.035 / 100;   // 掛單手續費（單邊）
const RULES = { swingLen: 3, htfSwing: 3, breakBy: 'close', obInvalid: 'close', emaLen: 50, stopBuf: 0.2, btcFilter: 'block', side: 'both',
  model: 'mtf', mtfFib: 0.715, mtfWait: 48, mtfReanchor: 'on', mtfFvg: 'on', mtfMinRR: 1.5, mtfPoiSrc: 'choch', mtfSwing: 3, p1: 0, beAt: 0 };

const pct = (a, b) => b ? `${(a / b * 100).toFixed(0)}%` : '—';
const f2 = v => (v > 0 ? '+' : '') + v.toFixed(2);
const med = a => { if (!a.length) return NaN; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

// 給定 15M K 線、進場 bar、方向、進場/止損/目標，模擬到出場（同根兩邊都碰到算止損）
function sim(bars, j0, dir, entry, stop, target, maxBars = 2000) {
  const risk = Math.abs(entry - stop); let mfe = 0, mae = 0;
  for (let j = j0; j < Math.min(bars.length, j0 + maxBars); j++) {
    const b = bars[j], up = dir > 0;
    mfe = Math.max(mfe, ((up ? b.h : entry * 2 - b.l) - entry) / risk);
    mae = Math.max(mae, ((up ? entry * 2 - b.l : b.h) - entry) / risk);
    if (up ? b.l <= stop : b.h >= stop) return { R: -1, j, mfe, mae };
    if (j > j0 && (up ? b.h >= target : b.l <= target)) return { R: (target - entry) * dir / risk, j, mfe, mae };
  }
  return { R: null, j: bars.length, mfe, mae };
}

(async () => {
  const data = await load(); const syms = Object.keys(data).filter(s => data[s].m15 && data[s].m15.length > 500);
  const btc = SMC.trendSeries(data.BTC.htf, RULES);
  const rows = [];
  for (const sym of syms) {
    const m = data[sym].m15, idx = new Map(m.map((b, i) => [b.t, i]));
    const { trades } = SMC.backtest(sym, m, data[sym].htf, RULES, { feePct: 0, btcDirAt: btc });
    for (const t of trades) {
      const r = { ...t, sym };
      if (t.filledT != null) {
        const jf = idx.get(t.filledT), risk = Math.abs(t.entry - t.stop);
        const base = sim(m, jf, t.dir, t.entry, t.stop, t.target);
        r.base = base; r.stopPct = risk / t.entry * 100; r.cost = 2 * FEE * t.entry / risk;
        r.bars = base.j - jf; r.hour = new Date(t.filledT).getUTCHours();
        // 打到止損後，價格之後有沒有走到原本的目標（96 根 = 24 小時內）
        if (base.R === -1) { const after = sim(m, base.j + 1, t.dir, t.entry, t.dir > 0 ? -Infinity : Infinity, t.target, 96); r.hunted = after.R != null; }
        // 反事實：止損放 4H 區域外 / 止損放寬 1.5 倍 / 目標固定 2R
        const s2 = t.dir > 0 ? Math.min(t.stop, t.poiLo * (1 - 0.002)) : Math.max(t.stop, t.poiHi * (1 + 0.002));
        r.alt = {
          poiStop: sim(m, jf, t.dir, t.entry, s2, t.target),
          wide: sim(m, jf, t.dir, t.entry, t.entry - t.dir * risk * 1.5, t.target),
          fix2R: sim(m, jf, t.dir, t.entry, t.stop, t.entry + t.dir * risk * 2),
          fix1R: sim(m, jf, t.dir, t.entry, t.stop, t.entry + t.dir * risk * 1),
        };
        r.altCost = { poiStop: 2 * FEE * t.entry / Math.abs(t.entry - s2), wide: r.cost / 1.5 };
      }
      rows.push(r);
    }
  }
  const filled = rows.filter(r => r.base && r.base.R != null);
  const net = r => r.base.R - r.cost;
  const sum = a => a.reduce((x, y) => x + y, 0);
  const stat = (a, fR = net) => a.length ? `${a.length} 筆｜勝率 ${pct(a.filter(r => r.base.R > 0).length, a.length)}｜平均 ${f2(sum(a.map(fR)) / a.length)}R｜累計 ${f2(sum(a.map(fR)))}R` : '—';
  const out = [`# MTF 策略診斷（${EXCHANGE}，${DAYS} 天，${syms.length} 幣，手續費 0.035%×2）`, ''];

  out.push('## 1. 訊號流失在哪一步', '');
  const cnt = st => rows.filter(r => r.status === st).length;
  out.push(`- 4H 區域 + 15M CHoCH + FVG 成立：${rows.length} 次`,
    `- 等不到 0.715（超過 12 小時沒成交）：${cnt('expired')}（${pct(cnt('expired'), rows.length)}）`,
    `- 成交前收盤破推動起點（取消）：${cnt('invalid')}（${pct(cnt('invalid'), rows.length)}）`,
    `- 成交且有結果：${filled.length}（${pct(filled.length, rows.length)}）`, '');

  out.push('## 2. 成交後的結果', '', `- 整體：${stat(filled)}`, `- 不算手續費：${stat(filled, r => r.base.R)}`,
    `- 止損距離中位數：${med(filled.map(r => r.stopPct)).toFixed(2)}%，手續費平均吃掉 ${(sum(filled.map(r => r.cost)) / filled.length).toFixed(2)}R／筆`,
    `- 平均 RR（目標 / 止損）：${(sum(filled.map(r => (r.target - r.entry) * r.dir / Math.abs(r.entry - r.stop))) / filled.length).toFixed(2)}`, '');

  const losers = filled.filter(r => r.base.R < 0), winners = filled.filter(r => r.base.R > 0);
  out.push('## 3. 虧的單是怎麼虧的', '',
    `- 虧損 ${losers.length} 筆，打到止損前最多曾經賺到：`,
    `  - 不到 0.3R（幾乎一進場就往反方向）：${pct(losers.filter(r => r.base.mfe < 0.3).length, losers.length)}`,
    `  - 0.3–1R：${pct(losers.filter(r => r.base.mfe >= 0.3 && r.base.mfe < 1).length, losers.length)}`,
    `  - 曾經到 1R 以上又被打回止損：${pct(losers.filter(r => r.base.mfe >= 1).length, losers.length)}`,
    `- 虧損單從成交到止損的時間中位數：${(med(losers.map(r => r.bars)) * 15 / 60).toFixed(1)} 小時；獲利單到目標：${(med(winners.map(r => r.bars)) * 15 / 60).toFixed(1)} 小時`,
    `- **被掃止損**（打到止損後 24 小時內價格又走到原本目標）：${pct(losers.filter(r => r.hunted).length, losers.length)} 的虧損單`, '');

  const altStat = (k, costK) => { const a = filled.filter(r => r.alt[k].R != null); const R = a.map(r => r.alt[k].R - (costK === 'same' ? r.cost : costK ? r.altCost[costK] : r.cost)); return `${a.length} 筆｜勝率 ${pct(a.filter(r => r.alt[k].R > 0).length, a.length)}｜平均 ${f2(sum(R) / a.length)}R｜累計 ${f2(sum(R))}R`; };
  out.push('## 4. 換個止損 / 止盈會怎樣（同一批成交的單）', '',
    `- 原本（止損前低、止盈 15M 前高）：${stat(filled)}`,
    `- 止損改放 4H 區域外：${altStat('poiStop', 'poiStop')}`,
    `- 止損放寬 1.5 倍：${altStat('wide', 'wide')}`,
    `- 止盈改固定 2R：${altStat('fix2R', 'same')}`,
    `- 止盈改固定 1R：${altStat('fix1R', 'same')}`, '');

  const grp = (name, key, order) => { const m = {}; for (const r of filled) { const g = key(r); (m[g] ||= []).push(r); }
    out.push(`### ${name}`, '', ...Object.keys(m).sort(order).map(g => `- ${g}：${stat(m[g])}`), ''); };
  const terc = (k, fmt) => { const v = filled.map(k).sort((a, b) => a - b), q1 = v[Math.floor(v.length / 3)], q2 = v[Math.floor(v.length * 2 / 3)];
    return r => { const x = k(r); return x < q1 ? `1 低（< ${fmt(q1)}）` : x < q2 ? `2 中` : `3 高（≥ ${fmt(q2)}）`; }; };
  out.push('## 5. 分組看是哪一組在拖累', '');
  grp('方向', r => r.dir > 0 ? '做多' : '做空');
  grp('4H 區域種類', r => `4H ${r.poi}`);
  grp('0.715 有沒有落在 15M OB/FVG 裡', r => r.conf ? '有' : '沒有');
  grp('止損距離', terc(r => r.stopPct, v => v.toFixed(2) + '%'));
  grp('RR', terc(r => (r.target - r.entry) * r.dir / Math.abs(r.entry - r.stop), v => v.toFixed(2)));
  grp('時段（台灣時間）', r => { const h = (r.hour + 8) % 24; return h < 8 ? '1 00–08' : h < 15 ? '2 08–15 亞洲' : h < 21 ? '3 15–21 歐洲' : '4 21–24 美國'; });
  grp('幣種（BTC/ETH vs 其他）', r => ['BTC', 'ETH'].includes(r.sym) ? 'BTC / ETH' : '其他幣');

  const md = out.join('\n'); console.log(md);
  fs.writeFileSync(path.join(__dirname, '..', 'research-cache', `diag-${EXCHANGE}-${DAYS}.md`), md);
})().catch(e => { console.error(e); process.exit(1); });
