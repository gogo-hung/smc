// 單一幣種分析（交易室搜尋）：BingX 所有 USDT 永續都能查；不在策略掃描名單的幣，當場抓 K 線來算
// 只做指標整理與規則打分，不是投資建議；兩個策略仍然只掃成交量前 TOP_N 名（回測就是用流動性好的幣）
const bingx = require('./bingx');
const TREND = require('./trend');
const SIGNAL = require('./signal');
const H1 = 3600e3, H4 = 4 * H1, D1 = 24 * H1;
const isTradfi = s => /^NC[A-Z0-9]*2USD-USDT$|^NC(CO|SK|SI|FX)/.test(s);

// ---- 指標 ----
const ema = (a, n) => { const k = 2 / (n + 1), o = new Array(a.length); let e = a[0]; for (let i = 0; i < a.length; i++) { e = i ? a[i] * k + e * (1 - k) : a[0]; o[i] = e; } return o; };
const sma = (a, n) => a.map((_, i) => i < n - 1 ? NaN : a.slice(i - n + 1, i + 1).reduce((s, x) => s + x, 0) / n);
function rsi(c, n = 14) { let g = 0, l = 0, o = NaN; for (let i = 1; i < c.length; i++) { const d = c[i] - c[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0); if (i <= n) { g += up / n; l += dn / n; } else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; } if (i >= n) o = l ? 100 - 100 / (1 + g / l) : 100; } return o; }
function macd(c) { const f = ema(c, 12), s = ema(c, 26), m = c.map((_, i) => f[i] - s[i]), sg = ema(m, 9); return m.map((x, i) => x - sg[i]); }
function toDaily(h4) { const m = new Map(); for (const b of h4) { const k = Math.floor((b.t + 8 * H1) / D1); const x = m.get(k); if (!x) m.set(k, { ...b }); else { x.h = Math.max(x.h, b.h); x.l = Math.min(x.l, b.l); x.c = b.c; x.v += b.v; } } return [...m.values()]; }
// 最近的擺動高低點（左右各 5 根），當作壓力／支撐
function levels(b, price, look = 150) {
  const hi = [], lo = [], s = Math.max(5, b.length - look);
  for (let i = s; i < b.length - 5; i++) { const w = b.slice(i - 5, i + 6); if (b[i].h === Math.max(...w.map(x => x.h))) hi.push(b[i].h); if (b[i].l === Math.min(...w.map(x => x.l))) lo.push(b[i].l); }
  const res = hi.filter(x => x > price).sort((a, c) => a - c)[0] ?? Math.max(...b.slice(-look).map(x => x.h));
  const sup = lo.filter(x => x < price).sort((a, c) => c - a)[0] ?? Math.min(...b.slice(-look).map(x => x.l));
  return { res, sup };
}

// ---- 快取 ----
let symCache = { at: 0, list: [] };
const coinCache = new Map();   // sym → { at, data }

// 所有可以搜尋的幣（依 24h 成交額排序）
async function symbols(scannerState) {
  if (Date.now() - symCache.at < 5 * 60e3 && symCache.list.length) return symCache.list;
  const [contracts, tickers] = await Promise.all([bingx.getContracts(), bingx.getTickers()]);
  const live = new Set(contracts), scanned = new Set(Object.keys((scannerState && scannerState.market) || {}));
  const list = tickers.filter(t => live.has(t.symbol) && !isTradfi(t.symbol))
    .sort((a, b) => b.quoteVolume - a.quoteVolume)
    .map((t, i) => ({ sym: t.symbol.replace(/-USDT$/, ''), price: t.last, chg: t.change, vol: t.quoteVolume, rank: i + 1, scanned: scanned.has(t.symbol.replace(/-USDT$/, '')) }));
  symCache = { at: Date.now(), list };
  return list;
}

function analyzeBars(sym, h1, h4, extra = {}) {
  const c4 = h4.map(b => b.c), c1 = h1.map(b => b.c), last1 = c1[c1.length - 1], price = extra.price > 0 && Math.abs(extra.price / last1 - 1) < 0.2 ? extra.price : last1, n4 = h4.length - 1;
  const e50 = ema(c4, 50), e200 = ema(c4, 200), hist = macd(c4), atr4 = SIGNAL.atr(h4, 14)[n4], vma = sma(h4.map(b => b.v), 20)[n4];
  const d = toDaily(h4), dc = d.map(b => b.c), de50 = ema(dc, Math.min(50, Math.max(5, dc.length - 1)));
  const st = SIGNAL.supertrend(h1), stDir = st.dir[h1.length - 1], stLine = st.line[h1.length - 1];
  const r4 = rsi(c4), r1 = rsi(c1), mid = sma(c4, 20)[n4], sd = Math.sqrt(c4.slice(-20).reduce((s, x) => s + (x - mid) ** 2, 0) / 20), pctB = sd ? (price - (mid - 2 * sd)) / (4 * sd) : 0.5;
  const trend4 = e50[n4] > e200[n4] && c4[n4] > e50[n4] ? 1 : e50[n4] < e200[n4] && c4[n4] < e50[n4] ? -1 : 0;
  const trendD = dc.length > 20 ? (dc[dc.length - 1] > de50[de50.length - 1] ? 1 : -1) : 0;
  let crossAgo = null; for (let i = n4; i > Math.max(1, n4 - 60); i--) if (Math.sign(hist[i]) !== Math.sign(hist[i - 1])) { crossAgo = n4 - i; break; }
  const chg7 = h4.length > 42 ? (price / c4[n4 - 42] - 1) * 100 : null, volR = vma ? h4[n4].v / vma : null;
  const lv = levels(h4, price), fund = extra.funding;
  const f = [];   // 每個因子：分數、白話說明
  const add = (g, s, txt) => f.push({ g, s, txt });
  add('趨勢', trend4 * 2, trend4 > 0 ? '4H 多頭排列：EMA50 在 EMA200 上方，收盤也在 EMA50 上方' : trend4 < 0 ? '4H 空頭排列：EMA50 在 EMA200 下方，收盤也在 EMA50 下方' : '4H 均線沒有排列整齊，屬於盤整或轉折');
  add('趨勢', trendD, trendD > 0 ? '日線收盤在日線 EMA50 上方，大方向偏多' : trendD < 0 ? '日線收盤在日線 EMA50 下方，大方向偏空' : '日線資料不夠，先不判斷');
  add('動能', stDir, stDir > 0 ? `1H Supertrend 綠色（多方），線在 ${+stLine.toPrecision(6)}` : `1H Supertrend 紅色（空方），線在 ${+stLine.toPrecision(6)}`);
  const hs = Math.sign(hist[n4]), hUp = hist[n4] > hist[n4 - 1];
  add('動能', hs > 0 && hUp ? 1 : hs < 0 && !hUp ? -1 : 0, `4H MACD 柱${hs > 0 ? '在零軸上' : '在零軸下'}、${hUp ? '變長（往多）' : '變短（往空）'}${crossAgo != null ? `，${crossAgo} 根前${hist[n4 - crossAgo] > 0 ? '金叉' : '死叉'}` : ''}`);
  add('動能', r4 > 70 ? -1 : r4 < 30 ? 1 : r4 >= 55 ? 1 : r4 <= 45 ? -1 : 0, r4 > 70 ? `4H RSI ${r4.toFixed(0)} 超買，短線容易回檔` : r4 < 30 ? `4H RSI ${r4.toFixed(0)} 超賣，短線可能反彈` : r4 >= 55 ? `4H RSI ${r4.toFixed(0)} 偏強` : r4 <= 45 ? `4H RSI ${r4.toFixed(0)} 偏弱` : `4H RSI ${r4.toFixed(0)} 中性`);
  if (extra.btcChg7 != null && chg7 != null && sym !== 'BTC') { const rs = chg7 - extra.btcChg7; add('強弱', rs > 3 ? 1 : rs < -3 ? -1 : 0, `近 7 天 ${chg7 >= 0 ? '+' : ''}${chg7.toFixed(1)}%，比 BTC ${rs >= 0 ? '強' : '弱'} ${Math.abs(rs).toFixed(1)}%`); }
  if (volR != null) add('量能', volR > 1.5 ? Math.sign(c4[n4] - h4[n4].o) : 0, volR > 1.5 ? `最近一根 4H 爆量（${volR.toFixed(1)} 倍均量），${c4[n4] >= h4[n4].o ? '收紅' : '收黑'}` : `成交量 ${volR.toFixed(1)} 倍均量，沒有特別放量`);
  if (fund != null) add('籌碼', fund > 0.0005 ? -1 : fund < -0.0003 ? 1 : 0, `資金費率 ${(fund * 100).toFixed(4)}%${fund > 0.0005 ? '，多方擁擠，小心多殺多' : fund < -0.0003 ? '，空方擁擠，小心軋空' : '，正常'}`);
  const score = f.reduce((s, x) => s + x.s, 0), max = f.reduce((s, x) => s + (x.g === '趨勢' && x.txt.startsWith('4H') ? 2 : 1), 0);
  const verdict = score >= 4 ? '偏多' : score >= 2 ? '略偏多' : score <= -4 ? '偏空' : score <= -2 ? '略偏空' : '震盪';
  const advice = { 偏多: '趨勢和動能都偏多。等策略訊號，或回檔到支撐附近再考慮做多，不要追高。', 略偏多: '稍微偏多但不夠一致，倉位放小，或等更多條件對齊。', 震盪: '多空訊號互相抵銷，屬於盤整。順勢策略在這種時候容易來回被掃，建議觀望。', 略偏空: '稍微偏空但不夠一致，倉位放小，或等更多條件對齊。', 偏空: '趨勢和動能都偏空。等策略訊號，或反彈到壓力附近再考慮做空，不要追空。' }[verdict];
  const ta = TREND.analyze(sym, h4), sa = SIGNAL.analyze(sym, h1, h4);
  const miss = [];
  if (!ta.trend) miss.push('4H 趨勢還沒排列（EMA50／200 同向）');
  else if (ta.state === 'watch') { miss.push(`MACD ${ta.trend > 0 ? '金叉' : '死叉'}`); if ((ta.volRatio || 0) < TREND.P.volMult) miss.push(`爆量（現在 ${(ta.volRatio || 0).toFixed(1)} 倍，要 1.5 倍）`); }
  const chart = h4.slice(-120).map((b, i, a) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, e50: e50[h4.length - a.length + i], e200: e200[h4.length - a.length + i] }));
  return {
    sym, price, at: Date.now(),
    basic: { chg24: extra.chg24 ?? null, vol24: extra.vol24 ?? null, rank: extra.rank ?? null, funding: fund ?? null, chg7, atrPct: atr4 / price * 100, high30: Math.max(...h4.slice(-180).map(b => b.h)), low30: Math.min(...h4.slice(-180).map(b => b.l)) },
    ind: { e50: e50[n4], e200: e200[n4], trend4, trendD, rsi4: r4, rsi1: r1, macd: hist[n4], macdUp: hUp, crossAgo, stDir, stLine, pctB, volR, ...lv },
    verdict: { score, max, verdict, advice, factors: f },
    strategies: {
      trend: { state: ta.state, trend: ta.trend, sig: ta.sig, miss, txt: ta.sig ? `4H 剛觸發${ta.sig > 0 ? '做多' : '做空'}訊號` : ta.state === 'watch' ? `4H ${ta.trend > 0 ? '多頭' : '空頭'}，等 MACD ${ta.trend > 0 ? '金叉' : '死叉'}＋爆量` : ta.trend ? 'MACD 已經順勢，這段錯過，等下一次回檔後再交叉' : '4H 沒有明確趨勢，不會出訊號' },
      signal: { state: sa.state, trend: sa.trend, txt: sa.state === 'trigger' ? `1H 剛翻向，${sa.sig > 0 ? '做多' : '做空'}訊號` : sa.state === 'watch' ? `4H ${sa.trend > 0 ? '多頭' : '空頭'}，等 1H Supertrend 翻${sa.trend > 0 ? '多' : '空'}（差 ${(sa.dist || 0).toFixed(2)} ATR）` : sa.state === 'running' ? '已經順勢，等下一次回檔後再翻向' : sa.state === 'nodata' ? 'K 線不夠，無法判斷' : '4H 沒有明確趨勢，不會出訊號' },
    },
    scanned: !!extra.scanned, chart,
  };
}

async function analyze(sym, scannerState, trackerState) {
  sym = String(sym || '').toUpperCase().replace(/[-_/]?USDT$/, '').replace(/[^A-Z0-9]/g, '');
  if (!sym) throw Object.assign(new Error('請輸入幣種'), { code: 400 });
  const c = coinCache.get(sym); if (c && Date.now() - c.at < 3 * 60e3) return withPositions(c.data, sym, trackerState);
  const list = await symbols(scannerState), info = list.find(x => x.sym === sym);
  if (!info) throw Object.assign(new Error(`BingX 找不到 ${sym}-USDT 永續合約`), { code: 404 });
  const m = scannerState && scannerState.market && scannerState.market[sym];
  let h1 = m && m.ltf, h4 = m && m.htf;
  if (!h1 || h1.length < 220 || !h4 || h4.length < 210) [h1, h4] = await Promise.all([bingx.getKlines(`${sym}-USDT`, '1h', 300), bingx.getKlines(`${sym}-USDT`, '4h', 500)]);
  if (!h1.length || !h4.length) throw Object.assign(new Error(`${sym} 抓不到 K 線`), { code: 502 });
  const btc = scannerState && scannerState.market && scannerState.market.BTC, b4 = btc && btc.htf, btcChg7 = b4 && b4.length > 42 ? (b4[b4.length - 1].c / b4[b4.length - 43].c - 1) * 100 : null;
  const fund = scannerState && scannerState.ctx && scannerState.ctx.funding ? scannerState.ctx.funding[sym] : undefined;
  const data = analyzeBars(sym, h1, h4, { price: info.price, chg24: info.chg, vol24: info.vol, rank: info.rank, funding: fund, btcChg7, scanned: info.scanned });
  data.short = h4.length < 210 ? '上市時間短，4H K 線不到 210 根，長期指標（EMA200、策略）參考性低' : null;
  coinCache.set(sym, { at: Date.now(), data }); if (coinCache.size > 200) coinCache.delete(coinCache.keys().next().value);
  return withPositions(data, sym, trackerState);
}
function withPositions(data, sym, trackerState) {
  const pos = ((trackerState && trackerState.signals) || []).filter(s => s.sym === sym && s.status === 'filled' && (s.model === 'trend' || s.model === 'signal'))
    .map(s => ({ model: s.model, dir: s.dir, entry: s.entry, stop: s.stop, stop0: s.stop0, tp: s.tp ?? s.tp1, be: !!s.be, filledAt: s.filledAt }));
  return { ...data, positions: pos };
}

module.exports = { symbols, analyze, analyzeBars };
