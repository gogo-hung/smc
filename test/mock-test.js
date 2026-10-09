// 離線測試：用假的 BingX 回應跑完整流程（不需要網路）
// npm test
process.env.TELEGRAM_BOT_TOKEN = ''; process.env.TOP_N = '20'; process.env.REQUEST_GAP_MS = '0'; process.env.PORT = '0'; process.env.ALERT_MAX_AGE_BARS = '0';
const assert = require('assert');
const SMC = require('../src/smc');

const SEEDS = { ETH: 152, SUI: 594, DOGE: 358, INJ: 423 };
const COINS = ['BTC', 'ETH', 'SOL', 'SUI', 'DOGE', 'INJ', 'XRP', 'LINK', 'AVAX', 'TIA'];
const Q = 15 * 60e3;
const end = Math.floor(Date.now() / Q) * Q; // 最後一根「已收盤」15M 的收盤時間
const fake = {};
for (const c of COINS) {
  const s = SMC.genSeries(c, 100, 1920, SEEDS[c] || 1);
  s.forEach((b, i) => { b.t = end - (s.length - i) * Q; });
  fake[c] = { ltf: s, htf: SMC.aggregate(s, 16) };
}

let calls = 0;
global.fetch = async (url) => {
  calls++;
  const u = new URL(url);
  const json = d => ({ ok: true, status: 200, json: async () => ({ code: 0, msg: '', data: d }) });
  if (u.pathname.endsWith('/quote/contracts')) return json([...COINS.map(c => ({ symbol: `${c}-USDT`, status: 1 })), { symbol: 'OLD-USDT', status: 0 }]);
  if (u.pathname.endsWith('/quote/ticker')) return json(COINS.map((c, i) => ({ symbol: `${c}-USDT`, lastPrice: '1', quoteVolume: String(1e9 / (i + 1)) })));
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
  const server = require('../src/server');
  scanner.state.alerted = [];

  const sum = await scanner.scanOnce();
  console.log('掃描結果', sum);
  assert.strictEqual(sum.symbols, COINS.length, '應掃到全部上架幣，排除下架幣');
  const btc = scanner.state.market.BTC;
  assert(btc.ltf[0].t < btc.ltf[1].t, 'K 線應由舊到新');
  assert(btc.ltf[btc.ltf.length - 1].t + Q <= Date.now(), '不應包含未收盤 K 棒');
  assert(sum.trigger >= 1, '示範資料應至少有一個觸發訊號');

  // 同一訊號不重複推播
  const again = await scanner.scanOnce();
  assert.strictEqual(again.newAlerts, 0, '第二次掃描不應重複推播');

  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const realFetch = require('http');
  const req = (method, path, body) => new Promise((resolve, reject) => {
    const r = realFetch.request(base + path, { method, headers: { 'Content-Type': 'application/json' } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('error', reject); if (body) r.write(JSON.stringify(body)); r.end();
  });

  const m = JSON.parse((await req('GET', '/api/market')).body);
  assert.strictEqual(m.symbols.length, COINS.length);
  const sig = JSON.parse((await req('GET', '/api/signals?status=trigger')).body);
  console.log('觸發訊號', sig.results.map(r => `${r.sym} ${r.dir > 0 ? '多' : '空'} 進場 ${r.entry.toPrecision(5)} RR ${r.rr.toFixed(2)}`));
  const rules = JSON.parse((await req('POST', '/api/rules', { minRR: 99 })).body);
  assert.strictEqual(rules.minRR, 99);
  const sig2 = JSON.parse((await req('GET', '/api/signals?status=trigger')).body);
  assert.strictEqual(sig2.results.length, 0, 'RR 門檻 99 時不應有觸發');
  await req('POST', '/api/rules', scanner.DEFAULT_RULES);
  const cron = JSON.parse((await req('GET', '/api/cron')).body);
  assert(cron.skipped, '5 分鐘內重複叫醒應跳過掃描');
  const page = await req('GET', '/');
  assert(page.body.includes('SMC 掃幣台'));
  assert((await req('GET', '/smc.js')).body.includes('function analyze'));

  server.close();
  console.log(`\n全部通過（模擬 API 呼叫 ${calls} 次）`);
})().catch(e => { console.error('測試失敗：', e.message); process.exit(1); });
