// 市場情緒三個儀表：市場平均 RSI（掃描中的幣，日線 RSI14）、恐懼貪婪指數（alternative.me）、整體市場漲跌家數（BingX 全部 USDT 永續 24h 漲跌）
const SMC = require('./smc');

const state = { rsi: null, fng: null, breadth: null, updatedAt: null, fngAt: 0 };

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
    const total = up + flat + down, pct = total ? up / total * 100 : 0;
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

module.exports = { state, update, refreshFng, rsiLast };
