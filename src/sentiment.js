// 市場情緒三個儀表：市場平均 RSI（掃描中的幣，日線 RSI14）、恐懼貪婪指數（alternative.me）、整體市場漲跌家數（BingX 全部 USDT 永續 24h 漲跌）
const SMC = require('./smc');

const state = { rsi: null, fng: null, breadth: null, ls: null, oi: null, funding: null, stable: null, btc: null, analyst: null, updatedAt: null, fngAt: 0, derivAt: 0, stableAt: 0 };

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
  // BTC 4H／日線趨勢（分析師用）
  const B = market.BTC;
  if (B && B.htf && B.htf.length > 220) {
    const c4 = B.htf.map(b => b.c), last = isFinite(B.price) ? B.price : c4[c4.length - 1];
    const e50 = emaLast(c4, 50), e200 = emaLast(c4, 200), d = SMC.toDaily(B.htf).map(b => b.c), d50 = emaLast(d, Math.min(50, d.length - 5));
    const t = (tickers || []).find(x => x.symbol === 'BTC-USDT');
    state.btc = { price: last, e50, e200, d50, h4: e50 > e200 && last > e50 ? 1 : e50 < e200 && last < e50 ? -1 : 0, d1: last > d50 ? 1 : -1, chg24: t ? t.change : null };
  }
  state.updatedAt = Date.now();
}
function emaLast(a, n) { if (!a.length || n < 2) return null; const k = 2 / (n + 1); let e = a.slice(0, n).reduce((x, y) => x + y, 0) / Math.min(n, a.length); for (let i = n; i < a.length; i++) e = a[i] * k + e * (1 - k); return e; }

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


// ---- 穩定幣：DeFiLlama 穩定幣總市值（每天）＋ CoinGecko 加密總市值 → 7 天市值變化、占比變化；30 分鐘抓一次 ----
async function refreshStable(force) {
  if (!force && Date.now() - state.stableAt < 30 * 60e3) return;
  state.stableAt = Date.now();
  try {
    const ch = await getJson('https://stablecoins.llama.fi/stablecoincharts/all');
    const v = r => +(r.totalCirculatingUSD && (r.totalCirculatingUSD.peggedUSD ?? Object.values(r.totalCirculatingUSD).reduce((a, b) => a + b, 0)));
    const now = v(ch[ch.length - 1]), d1 = v(ch[ch.length - 2]), d7 = v(ch[ch.length - 8]);
    const out = { now, chg1: +((now / d1 - 1) * 100).toFixed(2), chg7: +((now / d7 - 1) * 100).toFixed(2), series: ch.slice(-30).map(r => Math.round(v(r) / 1e6)) };
    try {
      const g = (await getJson('https://api.coingecko.com/api/v3/global')).data, tot = g.total_market_cap.usd, tot1 = tot / (1 + g.market_cap_change_percentage_24h_usd / 100);
      out.share = +(now / tot * 100).toFixed(2); out.share1 = +(d1 / tot1 * 100).toFixed(2); out.total = tot;
    } catch (e) { console.error('CoinGecko：', e.message); }
    out.label = out.chg7 > 0.5 ? '資金流入' : out.chg7 < -0.5 ? '資金流出' : '持平';
    state.stable = out;
  } catch (e) { console.error('穩定幣數據：', e.message); }
}

// ---- 分析師：把上面全部數據用固定規則打分數，判斷目前多空 ----
// 趨勢類（順勢）：BTC 4H ±2、BTC 日線 ±1、整體市場 ±1、平均 RSI ±1、OI 配合價格 ±1、穩定幣流入流出 ±1
// 情緒類（反向）：散戶多空比擁擠 ∓1、資金費率過熱 ∓1、恐懼貪婪極端 ±1、穩定幣占比 ∓1
function analyze() {
  const f = [], add = (g, s, txt) => f.push({ g, s, txt });
  const { btc, breadth: b, rsi, ls, funding: fr, oi, fng, stable: st } = state;
  if (btc) {
    add('趨勢', btc.h4 * 2, btc.h4 > 0 ? 'BTC 4H 多頭排列（EMA50 在 EMA200 上，價格站上 EMA50）' : btc.h4 < 0 ? 'BTC 4H 空頭排列（EMA50 在 EMA200 下，價格跌破 EMA50）' : 'BTC 4H 均線糾結，方向不明');
    add('趨勢', btc.d1, btc.d1 > 0 ? 'BTC 日線站在 EMA50 之上' : 'BTC 日線在 EMA50 之下');
  }
  if (b) add('趨勢', b.pct >= 60 ? 1 : b.pct <= 40 ? -1 : 0, `全市場 ${b.pct}% 的幣在漲（${b.up} 漲／${b.down} 跌）`);
  if (rsi) add('趨勢', rsi.now > 55 ? 1 : rsi.now < 45 ? -1 : 0, `市場平均日線 RSI ${rsi.now}${rsi.now > 70 ? '，已經超買，小心回檔' : rsi.now < 30 ? '，已經超賣，小心反彈' : ''}`);
  if (oi && btc && btc.chg24 != null && oi.chg != null) {
    const up = btc.chg24 > 0, oiUp = oi.chg > 1, oiDn = oi.chg < -1;
    add('趨勢', oiUp ? (up ? 1 : -1) : 0, oiUp ? (up ? `BTC 漲 ${btc.chg24}%＋未平倉增加 ${oi.chg}%：新資金在推升` : `BTC 跌 ${btc.chg24}%＋未平倉增加 ${oi.chg}%：新空單在進場`) : oiDn ? `未平倉減少 ${oi.chg}%：${up ? '空單回補推升，力道偏弱' : '多單停損平倉'}` : `未平倉變化不大（${oi.chg}%）`);
  }
  if (st) add('趨勢', st.chg7 > 0.5 ? 1 : st.chg7 < -0.5 ? -1 : 0, `穩定幣總市值 7 天 ${st.chg7 >= 0 ? '+' : ''}${st.chg7}%（${st.label}）`);
  if (ls) { const p = ls.global.long; add('情緒', p >= 60 ? -1 : p <= 40 ? 1 : 0, `散戶 ${p}% 做多${p >= 60 ? '，太擁擠，容易被反向洗' : p <= 40 ? '，空方擁擠，容易軋空' : ''}`); }
  if (fr && fr.avg != null) add('情緒', fr.avg > 0.03 ? -1 : fr.avg < -0.01 ? 1 : 0, `全市場平均資金費率 ${fr.avg > 0 ? '+' : ''}${fr.avg}%（${fr.label}）`);
  if (fng) add('情緒', fng.now <= 20 ? 1 : fng.now >= 80 ? -1 : 0, `恐懼貪婪 ${fng.now}（${fng.label}）${fng.now <= 20 ? '，極度恐懼常是階段低點' : fng.now >= 80 ? '，極度貪婪要小心追高' : ''}`);
  if (st && st.share != null && st.share1 != null) { const d = +(st.share - st.share1).toFixed(2); add('情緒', d > 0.1 ? -1 : d < -0.1 ? 1 : 0, `穩定幣占總市值 ${st.share}%（24h ${d >= 0 ? '+' : ''}${d}）${d > 0.1 ? '，資金換成 U 避險' : d < -0.1 ? '，資金從 U 換回幣' : ''}`); }
  if (!f.length) { state.analyst = null; return; }
  const score = f.reduce((a, x) => a + x.s, 0), max = f.reduce((a, x) => a + (x.txt.startsWith('BTC 4H') ? 2 : 1), 0);
  const trend = f.filter(x => x.g === '趨勢').reduce((a, x) => a + x.s, 0), mood = f.filter(x => x.g === '情緒').reduce((a, x) => a + x.s, 0);
  const verdict = score >= 4 ? '偏多' : score >= 2 ? '略偏多' : score <= -4 ? '偏空' : score <= -2 ? '略偏空' : '震盪';
  const dir = score >= 2 ? 1 : score <= -2 ? -1 : 0;
  let advice = dir > 0 ? '策略①的做多訊號比較可信；做空訊號要更小心，可以降低倉位或跳過。' : dir < 0 ? '策略①的做空訊號比較可信；做多訊號要更小心，可以降低倉位或跳過。' : '多空沒有明顯優勢，容易來回掃止損，訊號可以挑著做、倉位放小。';
  if (trend > 0 && mood < 0) advice += '　趨勢偏多但情緒過熱，追多要留意急殺。';
  if (trend < 0 && mood > 0) advice += '　趨勢偏空但情緒已經很悲觀，空單要留意反彈。';
  state.analyst = { score, max, verdict, dir, trend, mood, advice, factors: f, at: Date.now() };
}

module.exports = { state, update, refreshFng, refreshDeriv, refreshStable, analyze, rsiLast };
