// 離線測試：用假的 BingX / 日曆 / 財報回應跑完整流程（不需要網路）
// npm test
Object.assign(process.env, { TELEGRAM_BOT_TOKEN: '', TOP_N: '20', REQUEST_GAP_MS: '0', PORT: '0', ALERT_MAX_AGE_BARS: '0', ADMIN_TOKEN: 'pw', EARNINGS_TICKERS: 'NVDA' });
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const dataDir = path.join(__dirname, '..', 'data');
for (const f of fs.existsSync(dataDir) ? fs.readdirSync(dataDir) : []) if (f.endsWith('.json')) fs.unlinkSync(path.join(dataDir, f));
const SMC = require('../src/smc');

const SEEDS = { ETH: 152, SUI: 594, DOGE: 358, INJ: 423 };
const COINS = ['BTC', 'ETH', 'SOL', 'SUI', 'DOGE', 'INJ', 'XRP', 'LINK', 'AVAX', 'TIA'];
const Q = 15 * 60e3;
const end = Math.floor(Date.now() / Q) * Q - 2 * Q; // 留兩根空間，之後模擬價格走勢
const fake = {};
for (const c of [...COINS, 'TINY']) {
  const s = SMC.genSeries(c, 100, 1920, SEEDS[c] || 1);
  s.forEach((b, i) => { b.t = end - (s.length - i) * Q; });
  fake[c] = { ltf: s, htf: SMC.aggregate(s, 16) };
}
const nyDate = add => new Date(Date.now() + add * 86400e3).toLocaleDateString('sv-SE', { timeZone: 'America/New_York' });

let calls = 0;
global.fetch = async (url) => {
  calls++;
  const u = new URL(url);
  const json = d => ({ ok: true, status: 200, json: async () => ({ code: 0, msg: '', data: d }) });
  if (u.hostname === 'nfs.faireconomy.media') {
    if (u.pathname.includes('nextweek')) return { ok: false, status: 404, json: async () => ({}) };
    const iso = ms => new Date(ms).toISOString();
    return { ok: true, status: 200, json: async () => ([
      { title: 'CPI m/m', country: 'USD', date: iso(Date.now() + 20 * 60e3), impact: 'High', forecast: '0.3%', previous: '0.4%' },
      { title: 'Non-Farm Employment Change', country: 'USD', date: iso(Date.now() + 3 * 86400e3), impact: 'High', forecast: '150K', previous: '142K' },
      { title: 'German ZEW Economic Sentiment', country: 'EUR', date: iso(Date.now() + 2 * 3600e3), impact: 'Medium', forecast: '', previous: '' },
    ]) };
  }
  if (u.hostname === 'api.nasdaq.com') {
    const d = u.searchParams.get('date');
    const rows = d === nyDate(0) ? [{ symbol: 'NVDA', name: 'NVIDIA Corp', time: 'time-after-hours', epsForecast: '$0.95', fiscalQuarterEnding: 'Oct/2026' }, { symbol: 'XXXX', name: 'Other', time: 'time-pre-market' }] : [];
    return { ok: true, status: 200, json: async () => ({ data: { rows } }) };
  }
  if (u.pathname.endsWith('/quote/contracts')) return json([...COINS.map(c => ({ symbol: `${c}-USDT`, status: 1 })), { symbol: 'OLD-USDT', status: 0 }, { symbol: 'TINY-USDT', status: 1 }, { symbol: 'NCSKASML2USD-USDT', status: 1 }]);
  if (u.pathname.endsWith('/quote/ticker')) return json([...COINS.map((c, i) => ({ symbol: `${c}-USDT`, lastPrice: '1', quoteVolume: String(1e9 / (i + 1)) })), { symbol: 'TINY-USDT', lastPrice: '1', quoteVolume: '10' }, { symbol: 'NCSKASML2USD-USDT', quoteVolume: '9e9' }]);
  if (u.pathname.endsWith('/quote/premiumIndex')) return json(COINS.map(c => ({ symbol: `${c}-USDT`, lastFundingRate: c === 'DOGE' ? '0.0010' : '0.0001' })));
  if (u.pathname.endsWith('/quote/klines')) {
    const c = u.searchParams.get('symbol').replace('-USDT', '');
    const iv = u.searchParams.get('interval'), lim = +u.searchParams.get('limit');
    let bars = (iv === '15m' ? fake[c].ltf : fake[c].htf).slice(-lim);
    // 模擬 BingX：字串數值、新到舊排序、多一根尚未收盤的 K 棒
    const forming = { ...bars[bars.length - 1], t: Date.now() - 1000 };
    bars = [...bars, forming].reverse();
    return json(bars.map(b => ({ open: String(b.o), close: String(b.c), high: String(b.h), low: String(b.l), volume: String(b.v), time: b.t })));
  }
  throw new Error('unexpected ' + url);
};

(async () => {
  const scanner = require('../src/scanner');
  const tracker = require('../src/tracker');
  const server = require('../src/server');
  await scanner.init();

  // ---- 掃描 ----
  const sum = await scanner.scanOnce();
  console.log('掃描結果', sum);
  assert.strictEqual(sum.symbols, COINS.length, '應掃到全部上架幣，排除下架幣與美股');
  const btc = scanner.state.market.BTC;
  assert(btc.ltf[0].t < btc.ltf[1].t, 'K 線應由舊到新');
  assert(btc.ltf[btc.ltf.length - 1].t + Q <= Date.now(), '不應包含未收盤 K 棒');
  assert(sum.trigger >= 1, '示範資料應至少有一個觸發訊號');
  assert.strictEqual(tracker.state.signals.length, sum.trigger, '每個觸發都記進成績單');
  assert.strictEqual(tracker.state.feed.filter(f => f.type === 'signal').length, sum.trigger, '每個觸發都進提醒紀錄');

  // 大盤濾網
  const doge = scanner.state.results.find(r => r.sym === 'DOGE');
  assert(doge.flags.some(f => f.k === 'fund'), 'DOGE 做多 + 資金費率 0.1% 應標示多方擁擠');
  console.log('BTC H4：', scanner.state.ctx.btcDir, '｜DOGE 標記：', doge.flags.map(f => f.t).join('、'));

  // 第二次掃描不重複提醒
  await scanner.scanOnce();
  assert.strictEqual(tracker.state.feed.filter(f => f.type === 'signal').length, sum.trigger, '第二次掃描不應重複提醒');

  // ---- 成績單：模擬 ETH（空）先碰進場再打到目標、DOGE（多）碰進場後打到止損 ----
  const eth = tracker.state.signals.find(s => s.sym === 'ETH');
  const dg = tracker.state.signals.find(s => s.sym === 'DOGE');
  const push = (c, bars) => bars.forEach((b, i) => fake[c].ltf.push({ t: end + i * Q, o: b[0], h: b[1], l: b[2], c: b[3], v: 1000 }));
  push('ETH', [[eth.entry - 0.3, eth.entry + 0.01, eth.entry - 0.4, eth.entry - 0.2], [eth.entry - 0.2, eth.entry - 0.1, eth.target - 0.1, eth.target]]);
  push('DOGE', [[dg.entry + 0.3, dg.entry + 0.4, dg.entry - 0.01, dg.entry + 0.1], [dg.entry, dg.entry + 0.1, dg.stop - 0.1, dg.stop]]);
  for (const c of COINS) if (c !== 'ETH' && c !== 'DOGE') { const l = fake[c].ltf.at(-1); push(c, [[l.c, l.c, l.c, l.c], [l.c, l.c, l.c, l.c]]); }
  await scanner.scanOnce();
  assert.strictEqual(eth.status, 'win', `ETH 應為 win，實際 ${eth.status}`);
  assert.strictEqual(dg.status, 'loss', `DOGE 應為 loss，實際 ${dg.status}`);
  assert(eth.near && dg.near, '碰到進場位應發「接近進場區」提醒');
  const st = tracker.stats();
  console.log(`成績單：已結算 ${st.resolved}｜勝率 ${(st.winRate * 100).toFixed(0)}%｜累計 ${st.totalR}R｜等待中 ${st.pending}`);
  assert.strictEqual(st.resolved, 2);

  // ---- HTTP API ----
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const http = require('http');
  const req = (method, p, body, token) => new Promise((resolve, reject) => {
    const r = http.request(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { 'x-admin-token': token } : {}) } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d, json: () => JSON.parse(d) }));
    });
    r.on('error', reject); if (body) r.write(JSON.stringify(body)); r.end();
  });

  const m = (await req('GET', '/api/market')).json();
  assert.strictEqual(m.symbols.length, COINS.length);
  assert(m.ctx && m.ctx.funding.DOGE === 0.001, '行情要附上大盤資訊');
  const rules = (await req('POST', '/api/rules', { minRR: 99 }, 'pw')).json();
  assert.strictEqual(rules.minRR, 99);
  assert.strictEqual((await req('GET', '/api/signals?status=trigger')).json().results.length, 0, 'RR 門檻 99 時不應有觸發');
  assert.strictEqual((await req('POST', '/api/rules', { minRR: 2 })).status, 401, '改規則沒密碼要擋');
  await req('POST', '/api/rules', scanner.DEFAULT_RULES, 'pw');
  assert((await req('GET', '/api/cron?token=pw')).json().skipped, '5 分鐘內重複叫醒應跳過掃描');

  // 提醒中心
  const al = (await req('GET', '/api/alerts')).json();
  assert(al.feed.some(f => f.type === 'near') && al.feed.some(f => f.type === 'result'), '提醒紀錄要有接近進場與結果');
  assert.strictEqual((await req('POST', '/api/alert-settings', { nearPct: 0.5 })).status, 401);
  assert.strictEqual((await req('POST', '/api/alert-settings', { nearPct: 0.5, signal: false }, 'pw')).json().nearPct, 0.5);
  console.log('提醒紀錄：', al.feed.slice(0, 4).map(f => f.title).join('｜'));

  // 成績單
  assert.strictEqual((await req('GET', '/api/stats')).json().resolved, 2);

  // 交易紀錄 + 風控鎖
  assert.strictEqual((await req('GET', '/api/journal')).status, 401, '交易紀錄沒密碼要擋');
  assert.strictEqual((await req('POST', '/api/journal', { sym: 'SOL', dir: 1, pnl: 'abc' }, 'pw')).status, 400);
  await req('POST', '/api/journal', { sym: 'sol', dir: 1, pnl: 12.5 }, 'pw');
  await req('POST', '/api/journal', { sym: 'ETH', dir: -1, pnl: -8 }, 'pw');
  let j = (await req('POST', '/api/journal', { sym: 'SUI', dir: 1, pnl: -6, note: '追單' }, 'pw')).json();
  assert(j.locked && j.lossStreak === 2, '連虧兩筆應鎖住');
  assert((await req('GET', '/api/alerts')).json().locked);
  const feedN = tracker.state.feed.length;
  await tracker.emit('signal', '測試鎖住時的訊號', ['x']);
  assert(tracker.state.feed[0].muted, '鎖住時進場類提醒只記錄不推播');
  assert.strictEqual(tracker.state.feed.length, feedN + 1);
  j = (await req('DELETE', `/api/journal?id=${j.trades[0].id}`, null, 'pw')).json();
  assert(!j.locked, '刪掉最後一筆虧損後解鎖');
  console.log(`交易紀錄：今日 ${j.today.count} 筆，盈虧 ${j.today.pnl}U，連虧 ${j.lossStreak}`);

  // 搜尋加入
  assert(!scanner.state.market.TINY, 'TINY 原本不在名單');
  const add = await req('POST', '/api/add', { sym: 'tiny/usdt' });
  assert.strictEqual(add.status, 200, add.body);
  assert(scanner.state.market.TINY && scanner.state.extras.includes('TINY'));
  await new Promise(r => setTimeout(r, 3100));
  const bad = await req('POST', '/api/add', { sym: 'NOPE' });
  assert.strictEqual(bad.status, 404);

  // 財經日曆
  const calendar = require('../src/calendar');
  calendar.state.emit = tracker.emit;
  await calendar.refresh();
  assert.strictEqual(calendar.state.events.length, 3);
  const before = tracker.state.feed.filter(f => f.type === 'calendar').length;
  await calendar.checkAlerts(); await calendar.checkAlerts();
  assert.strictEqual(tracker.state.feed.filter(f => f.type === 'calendar').length - before, 1, '20 分鐘後的美國高影響數據只提醒一次');
  assert.deepStrictEqual((await req('GET', '/api/calendar')).json().events.map(e => e.alert), [true, false, true]);

  // 美股財報
  const earnings = require('../src/earnings');
  await earnings.refresh();
  assert.deepStrictEqual(earnings.state.tickers.sort(), ['ASML', 'NVDA']);
  assert.strictEqual(earnings.state.events.length, 1, '只留追蹤中的股票');
  await earnings.checkAlerts(tracker.emit); await earnings.checkAlerts(tracker.emit);
  assert.strictEqual(tracker.state.feed.filter(f => f.type === 'earnings').length, 1, '今天的財報提醒一次');
  console.log('財報：', (await req('GET', '/api/earnings')).json().events.map(e => `${e.sym} ${e.date} ${e.session}`).join('、'));

  const page = await req('GET', '/');
  assert(page.body.includes('SMC 掃幣台'));
  assert((await req('GET', '/smc.js')).body.includes('function applyContext'));

  server.close();
  for (const f of fs.readdirSync(dataDir)) if (f.endsWith('.json')) fs.unlinkSync(path.join(dataDir, f));
  console.log(`\n全部通過（模擬 API 呼叫 ${calls} 次）`);
})().catch(e => { console.error('測試失敗：', e.message); process.exit(1); });
