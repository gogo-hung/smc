// 美股財報日曆：Nasdaq 財報日曆，只留 BingX 有上架的美股 CFD + 你自訂的代號
const cfg = require('./config');
const store = require('./store');
const bingx = require('./bingx');

const DAYS = 14;
const state = { events: [], updatedAt: null, error: null, tickers: [], sent: [] };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const nyDate = (ts, add = 0) => new Date(ts + add * 86400e3).toLocaleDateString('sv-SE', { timeZone: 'America/New_York' });
const SESSION = { 'time-pre-market': '盤前', 'time-after-hours': '盤後', 'time-not-supplied': '時間未定' };

// BingX 美股合約長這樣：NCSKASML2USD-USDT → ASML
async function bingxStocks() {
  try {
    return (await bingx.getContracts()).map(s => (s.match(/^NCSK([A-Z0-9.]+?)2USD-USDT$/) || [])[1]).filter(Boolean);
  } catch { return []; }
}

async function refresh() {
  const tickers = [...new Set([...cfg.EARNINGS_TICKERS, ...(await bingxStocks())])];
  state.tickers = tickers;
  if (!tickers.length) { state.events = []; state.updatedAt = Date.now(); return; }
  const want = new Set(tickers);
  const out = [];
  let ok = 0;
  for (let i = 0; i < DAYS; i++) {
    const date = nyDate(Date.now(), i);
    try {
      const res = await fetch(`https://api.nasdaq.com/api/calendar/earnings?date=${date}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36', Accept: 'application/json, text/plain, */*', Origin: 'https://www.nasdaq.com', Referer: 'https://www.nasdaq.com/' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      ok++;
      for (const row of (j.data && j.data.rows) || []) {
        if (!want.has(row.symbol)) continue;
        out.push({ id: `${row.symbol}|${date}`, sym: row.symbol, alert: cfg.EARNINGS_TICKERS.includes(row.symbol), name: row.name, date, session: SESSION[row.time] || '時間未定', eps: row.epsForecast || '', quarter: row.fiscalQuarterEnding || '' });
      }
    } catch (e) { state.error = e.message; }
    await sleep(400);
  }
  if (ok) { state.events = out; state.updatedAt = Date.now(); state.error = ok < DAYS ? state.error : null; }
  console.log(`[財報] ${ok ? `${out.length} 筆（追蹤 ${tickers.length} 檔）` : `失敗：${state.error}`}`);
}

// 公布前一天提醒一次（美東日期的前一天，台灣時間 20:00 之後）
async function checkAlerts(emit) {
  const tomorrow = nyDate(Date.now(), 1);
  const twHour = +new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei', hour: '2-digit', hour12: false });
  const today = nyDate(Date.now());
  let changed = false;
  for (const e of state.events) {
    if (!e.alert || state.sent.includes(e.id)) continue; // 只推 EARNINGS_TICKERS 裡的股票
    const due = (e.date === tomorrow && twHour >= 20) || e.date === today;
    if (!due) continue;
    state.sent.push(e.id); changed = true;
    const when = e.date === today ? '今天' : '明天';
    const tw = e.session === '盤前' ? '約台灣時間晚上 8–9 點半' : e.session === '盤後' ? '約台灣時間隔天凌晨 4–5 點' : '時間未定';
    await emit('earnings', `📊 ${when} ${e.sym} 財報（${e.session}）`, [
      `${e.name}｜美東 ${e.date}，${tw}`, e.eps ? `EPS 預估 ${e.eps}` : '',
      '財報可能跳空跳過止損：降低槓桿或公布前先減倉。',
    ].filter(Boolean));
  }
  if (changed) { state.sent = state.sent.slice(-200); await store.save('earningsSent', state.sent); }
}

async function start(emit) {
  state.sent = await store.load('earningsSent', []);
  const run = () => refresh().then(() => checkAlerts(emit)).catch(e => console.error('[財報]', e.message));
  run();
  setInterval(run, 6 * 3600e3);
  setInterval(() => checkAlerts(emit).catch(() => {}), 30 * 60e3);
}

module.exports = { state, refresh, checkAlerts, start };
