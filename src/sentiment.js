// 市場情緒三個儀表：市場平均 RSI（掃描中的幣，日線 RSI14）、恐懼貪婪指數（alternative.me）、整體市場漲跌家數（BingX 全部 USDT 永續 24h 漲跌）
const SMC = require('./smc');

const state = { rsi: null, fng: null, breadth: null, ls: null, oi: null, funding: null, updatedAt: null, fngAt: 0, derivAt: 0 };

function rsiLast(closes, n = 14) {   // Wilder RSI，回傳最後一根
  if (closes.length <= n) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= n; l /= n;
  for (let i = n + 1; i < closes.length; i++) { const d = closes[i] - closes[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const rsiLabel = v => v == null ? '—' : v < 30 ? '超賣' : v < 45 ? '偏弱' : v <= 55 ? '中性' : v <= 70 ? '偏強' : '超買';
const FNG_ZH = { 'Extreme Fear': '極度恐懼', Fear: '恐懼', Neutral: '中性', Greed: '貪婪', 'Extreme Greed': '極度貪婪' };

// 每輪掃描後呼叫：market = 掃描到的幣（含 4H），tickers = BingX 全部合約的 24h 行情
function update(market, tickers) {
  const now = [], yday = [];
  for (const m of Object.values(market)) {
    if (!m.htf || m.htf.length < 120) continue;
    const d = SMC.toDaily(m.htf).map(b => b.c);   // 已收完的日線
    const live = isFinite(m.price) ? m.price : m.htf[m.htf.length - 1].c;
    const a = rsiLast([...d, live]), b = rsiLast(d);   // 今天（含即時價）／昨天收盤
    if (a != null) now.push(a); if (b != null) yday.push(b);
  }
  const r = avg(now), y = avg(yday);
  if (r != null) state.rsi = { now: +r.toFixed(1), yday: y != null ? +y.toFixed(1) : null, label: rsiLabel(r), n: now.length };
  if (tickers && tickers.length) {
    let up = 0, flat = 0, down = 0;
    for (const t of tickers) { if (!isFinite(t.change)) continue; if (t.change > 1) up++; else if (t.change < -1) down++; else flat++; }
    const total = up + flat + down, pct = up + down ? up / (up + down) * 100 : 50;   // 上漲佔「有動的」家數（平盤不算），才不會被平盤拉低
    state.breadth = { up, flat, down, total, pct: Math.round(pct), label: pct >= 60 ? '偏多' : pct <= 40 ? '偏空' : '中性' };
  }
  state.updatedAt = Date.now();
}

// 恐懼貪婪指數：一小時抓一次（官方一天更新一次）
async function refreshFng(force) {
  if (!force && Date.now() - state.fngAt < 3600e3) return;
  try {
    const res = await fetch('https://api.alternative.me/fng/?limit=2');
    const j = await res.json(), [a, b] = j.data || [];
    if (a) state.fng = { now: +a.value, yday: b ? +b.value : null, label: FNG_ZH[a.value_classification] || a.value_classification };
    state.fngAt = Date.now();
  } catch (e) { console.error('恐懼貪婪指數：', e.message); }
}


// ---- 合約數據（BTC）：多空比、未平倉量、資金費率；先抓 Binance，被擋（例如 451 地區限制）就改用 OKX ----
const getJson = async (url) => { const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 12000);
  try { const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'jubaopen-scanner' } }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return await r.json(); } finally { clearTimeout(t); } };
const BN = 'https://fapi.binance.com', OKX = 'https://www.okx.com';
const lsLabel = p => p >= 60 ? '偏多擁擠' : p >= 52 ? '偏多' : p > 48 ? '均衡' : p > 40 ? '偏空' : '偏空擁擠';

async function viaBinance() {
  const q = 'symbol=BTCUSDT&period=1h&limit=25';
  const [g, top, oi, prem] = await Promise.all([getJson(`${BN}/futures/data/globalLongShortAccountRatio?${q}`), getJson(`${BN}/futures/data/topLongShortPositionRatio?${q}`),
    getJson(`${BN}/futures/data/openInterestHist?${q}`), getJson(`${BN}/fapi/v1/premiumIndex`)]);
  const side = a => { const now = a[a.length - 1], y = a[0]; return { long: +(now.longAccount * 100).toFixed(1), ratio: +(+now.longShortRatio).toFixed(2), yday: +(y.longAccount * 100).toFixed(1) }; };
  const fr = {}; for (const x of prem) if (/USDT$/.test(x.symbol) && x.lastFundingRate !== '') fr[x.symbol.replace(/USDT$/, '')] = +x.lastFundingRate;
  return { src: 'Binance', ls: { global: side(g), top: side(top) }, oi: oi.map(x => ({ t: +x.timestamp, v: +x.sumOpenInterestValue })), fr };
}
async function viaOkx(bingxFunding) {
  const [g, top, oi, fb, fe] = await Promise.all([getJson(`${OKX}/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=BTC&period=1H`), getJson(`${OKX}/api/v5/rubik/stat/contracts/long-short-account-ratio-contract-top-trader?instId=BTC-USDT-SWAP&period=1H`),
    getJson(`${OKX}/api/v5/rubik/stat/contracts/open-interest-volume?ccy=BTC&period=1H`), getJson(`${OKX}/api/v5/public/funding-rate?instId=BTC-USDT-SWAP`), getJson(`${OKX}/api/v5/public/funding-rate?instId=ETH-USDT-SWAP`)]);
  const side = rows => { const now = +rows[0][1], y = +(rows[24] || rows[rows.length - 1])[1], pct = r => +(r / (1 + r) * 100).toFixed(1); return { long: pct(now), ratio: +now.toFixed(2), yday: pct(y) }; };   // OKX 由新到舊、只給比值
  const fr = { ...(bingxFunding || {}) }; if (fb.data && fb.data[0]) fr.BTC = +fb.data[0].fundingRate; if (fe.data && fe.data[0]) fr.ETH = +fe.data[0].fundingRate;
  return { src: 'OKX', ls: { global: side(g.data), top: side(top.data) }, oi: oi.data.slice(0, 25).reverse().map(r => ({ t: +r[0], v: +r[1] })), fr };
}
async function refreshDeriv(bingxFunding, force) {
  if (!force && Date.now() - state.derivAt < 10 * 60e3) return;
  let d = null, err = [];
  for (const f of [viaBinance, () => viaOkx(bingxFunding)]) { try { d = await f(); break; } catch (e) { err.push(`${f === viaBinance ? 'Binance' : 'OKX'}：${e.message}`); } }
  state.derivAt = Date.now();
  if (!d) { console.error('合約數據抓不到：', err.join('；')); return; }
  const g = d.ls.global, t = d.ls.top;
  state.ls = { src: d.src, global: { ...g, label: lsLabel(g.long) }, top: { ...t, label: lsLabel(t.long) } };
  const o = d.oi, last = o[o.length - 1], first = o[0];
  if (last) state.oi = { src: d.src, now: last.v, chg: first && first.v ? +((last.v / first.v - 1) * 100).toFixed(2) : null, series: o.map(x => +x.v.toFixed(0)) };
  const all = Object.values(d.fr).filter(isFinite), pos = all.filter(x => x > 0).length, neg = all.filter(x => x < 0).length, avgFr = avg(all);
  const pct4 = x => x == null ? null : +(x * 100).toFixed(4);
  state.funding = { src: d.src, btc: pct4(d.fr.BTC), eth: pct4(d.fr.ETH), avg: pct4(avgFr), pos, neg, n: all.length,
    label: avgFr == null ? '—' : avgFr > 0.0003 ? '多方過熱' : avgFr > 0 ? '多方付費' : avgFr > -0.0001 ? '中性' : '空方付費' };
  if (err.length) state.funding.note = err.join('；');
}

module.exports = { state, update, refreshFng, refreshDeriv, rsiLast };
