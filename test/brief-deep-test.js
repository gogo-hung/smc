// 離線測試：每日早報、/deep 深度分析、Telegram 指令、AI 數字校驗（不需要網路）
// npm test
Object.assign(process.env, { TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: '42', DISCORD_WEBHOOK_URL: '', TOP_N: '20', REQUEST_GAP_MS: '0', PORT: '0', ADMIN_TOKEN: 'pw',
  ANTHROPIC_API_KEY: 'k', PUBLIC_URL: 'https://example.onrender.com', CAL_ENABLED: 'false', BRIEF_TIME: '08:30', RISK_PCT: '1' });
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const dataDir = path.join(__dirname, '..', 'data');
const clean = () => { for (const f of fs.existsSync(dataDir) ? fs.readdirSync(dataDir) : []) if (f.endsWith('.json')) fs.unlinkSync(path.join(dataDir, f)); };
clean();
const SMC = require('../src/smc');

const COINS = ['BTC', 'ETH', 'SOL', 'SUI', 'DOGE', 'INJ', 'AVAX'];
const SEEDS = { SOL: 87, SUI: 107, INJ: 10, AVAX: 290 };
const Q = 60 * 60e3;
const end = Math.floor(Date.now() / Q) * Q - Q;
const fake = {};
for (const c of [...COINS, 'TSLA']) {
  const s = SMC.aggregate(SMC.genSeries(c, c === 'TSLA' ? 400 : 100, 1920, SEEDS[c] || 1), 4);
  s.forEach((b, i) => { b.t = end - (s.length - i) * Q; });
  fake[c] = { ltf: s, htf: SMC.aggregate(s, 4) };
}
const sym2coin = s => s === 'NCSKTSLA2USD-USDT' ? 'TSLA' : s.replace('-USDT', '');

const sent = [];          // 送到 Telegram 的訊息
let aiMode = 'good';      // good = AI 只用資料裡的數字；bad = AI 編了一個數字
global.fetch = async (url, opt = {}) => {
  const u = new URL(url);
  const ok = body => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  const json = d => ok({ code: 0, msg: '', data: d });
  if (u.hostname === 'api.telegram.org') {
    const method = u.pathname.split('/').pop(), body = JSON.parse(opt.body || '{}');
    if (method === 'sendMessage') sent.push(body);
    return ok({ ok: true, result: method === 'getUpdates' ? [] : true });
  }
  if (u.hostname === 'api.alternative.me') return ok({ data: [{ value: '25', value_classification: 'Extreme Fear' }, { value: '31', value_classification: 'Fear' }] });
  if (u.hostname === 'api.anthropic.com') {
    const body = JSON.parse(opt.body);
    assert(body.system.includes('只能使用'), 'AI 要帶規則');
    const data = JSON.parse(body.messages[0].content.match(/<data>\n([\s\S]*?)\n<\/data>/)[1]);
    const p = data.price ?? data.majors[0].price;
    const text = aiMode === 'good' ? `- 結構：H4 與日線方向請看上方，現價 ${p}。\n- 等條件到齊再進。` : `- 分析師 48 人看多，目標 ${(p * 1.37).toFixed(2)}。`;
    return ok({ content: [{ type: 'text', text }] });
  }
  if (u.hostname === 'nfs.faireconomy.media') return ok([{ title: 'CPI m/m', country: 'USD', date: new Date(Date.now() + 5 * 3600e3).toISOString(), impact: 'High', forecast: '0.3%', previous: '0.4%' }]);
  if (u.hostname === 'api.nasdaq.com') return ok({ data: { rows: [] } });
  if (u.pathname.endsWith('/quote/contracts')) return json([...COINS.map(c => ({ symbol: `${c}-USDT`, status: 1 })), { symbol: 'NCSKTSLA2USD-USDT', status: 1 }]);
  if (u.pathname.endsWith('/quote/ticker')) return json([...COINS.map((c, i) => ({ symbol: `${c}-USDT`, lastPrice: String(fake[c].ltf.at(-1).c), quoteVolume: String(1e9 / (i + 1)), priceChangePercent: String((i - 3) * 1.7) })),
    { symbol: 'NCSKTSLA2USD-USDT', lastPrice: String(fake.TSLA.ltf.at(-1).c), quoteVolume: '1', priceChangePercent: '-2.9' }]);
  if (u.pathname.endsWith('/quote/premiumIndex')) return json(COINS.map(c => ({ symbol: `${c}-USDT`, lastFundingRate: c === 'DOGE' ? '0.0008' : c === 'INJ' ? '-0.0006' : '0.0001' })));
  if (u.pathname.endsWith('/quote/klines')) {
    const c = sym2coin(u.searchParams.get('symbol'));
    const iv = u.searchParams.get('interval'), lim = +u.searchParams.get('limit');
    const bars = (iv === '1h' ? fake[c].ltf : fake[c].htf).slice(-lim);
    return json(bars.map(b => [b.t, b.o, b.h, b.l, b.c, b.v]));
  }
  throw new Error('unexpected ' + url);
};

(async () => {
  const ai = require('../src/ai');
  const scanner = require('../src/scanner');
  const tracker = require('../src/tracker');
  const calendar = require('../src/calendar');
  const brief = require('../src/brief');
  const deep = require('../src/deep');
  const telegram = require('../src/telegram');
  const server = require('../src/server');

  // ---- AI 數字校驗 ----
  const facts = { price: 409.99, chg: -2.9, a: { buy: 9, strong: 20 } };
  assert(ai.verifyNumbers('現價 409.99，跌 2.9%，買入 20 人', facts).ok, '資料裡有的數字要放行');
  assert(ai.verifyNumbers('現價 410.0', facts).ok, '四捨五入要放行');
  const bad = ai.verifyNumbers('48 人看多', facts);
  assert(!bad.ok && bad.bad.includes(48), '影片那種 29 寫成 48 要擋下');
  assert(ai.verifyNumbers('1H 回到 OB，4H 多頭，EMA50 上方', facts).ok, '時框、均線數字不算編造');
  console.log('AI 校驗：通過');

  await scanner.init();
  Object.assign(scanner.state.rules, { fibMin: 0.5, lookback: 12, minRR: 2, stopBuf: 0.1, btcFilter: 'warn', cFvg: 'score', target: 'swing' });
  await scanner.scanOnce();
  await calendar.refresh();

  // ---- 早報 ----
  const b = await brief.build();
  const text = b.lines.join('\n');
  console.log(`\n===== ${b.title} =====\n${text}\n`);
  assert.strictEqual(b.ai, 'ok', 'AI 摘要應通過校驗');
  assert(text.includes('今日重點') && text.includes('BTC') && text.includes('ETH'), '早報要有大盤');
  assert(text.includes('恐慌貪婪 25（極度恐懼），昨天 31'), '要有恐慌貪婪指數');
  assert(text.includes('多方擁擠 DOGE 0.080%｜') && text.includes('空方擁擠 INJ'), '只列超過門檻的擁擠幣');
  assert(text.includes('CPI'), '要列出 24 小時內的重要數據');
  assert(/SMC 訊號/.test(text), '要有 SMC 段落');
  const trig = scanner.state.results.filter(r => r.status === 'trigger');
  assert.strictEqual(b.data.triggers.length, Math.min(5, trig.length));
  assert(b.data.triggers.every(t => t.stop != null), '每個訊號都要有止損');
  assert(text.length < 3900, `早報太長：${text.length}`);

  aiMode = 'bad';
  const b2 = await brief.build();
  assert.strictEqual(b2.ai, 'rejected', 'AI 編數字要整段拿掉');
  assert(!b2.lines.join('\n').includes('48 人'), '被擋的 AI 內容不能出現');
  aiMode = 'good';

  // 排程：時間沒到不推、到了推一次、同一天不重複
  const feedBriefs = () => tracker.state.feed.filter(f => f.type === 'brief').length;
  const { mins } = brief.twParts();
  const hm = m => `${String(Math.floor(((m % 1440) + 1440) % 1440 / 60)).padStart(2, '0')}:${String(((m % 60) + 60) % 60).padStart(2, '0')}`;
  const cfg = require('../src/config');
  cfg.BRIEF_TIME = hm(mins + 30); await brief.check();
  assert.strictEqual(feedBriefs(), 0, '還沒到時間不推');
  cfg.BRIEF_TIME = hm(mins - 1); await brief.check(); await brief.check();
  assert.strictEqual(feedBriefs(), 1, '時間到推一次，不重複');
  assert(!tracker.state.feed[0].body.includes('<b>'), '提醒中心存純文字');
  const pushed = sent.filter(m => m.text.includes('聚寶盆早報'));
  assert.strictEqual(pushed.length, 1, '早報要推到 Telegram');
  console.log('早報排程：通過');

  // ---- /deep ----
  for (const s of ['SOL', 'btc', 'TSLA']) {
    const d = await deep.run(s);
    const t = d.lines.join('\n');
    console.log(`\n===== ${d.title} =====\n${t}`);
    assert(t.includes('結構') && t.includes('條件') && t.includes('結論'));
    if (d.data.plan) {
      assert(t.includes('止損') && t.includes('倉位'), '有計畫就要有止損與倉位');
      assert.strictEqual(d.data.plan.sizeX, +(1 / d.data.plan.stopPct).toFixed(2), '倉位倍數 = 風險 % ÷ 止損距離 %');
    }
    if (d.data.status !== 'trigger') assert(/還不能進場|觀望/.test(t), '條件沒到齊要明講不能進');
  }
  assert((await deep.collect('TSLA')).tradfi, 'TSLA 要對應到 BingX 美股合約');
  await assert.rejects(deep.run('NOPE'), /找不到/);
  await assert.rejects(deep.run(''), /請輸入/);

  // ---- Telegram 指令 ----
  sent.length = 0;
  await telegram.handle({ message: { message_id: 1, chat: { id: 42 }, text: '/deep sol' } });
  assert(sent.length >= 1 && sent[0].text.includes('SOL/USDT 深度分析') && sent[0].chat_id === 42, '/deep 要回覆分析');
  await telegram.handle({ message: { message_id: 2, chat: { id: 42 }, text: '/deep@jubaopen_bot NOPE' } });
  assert(sent.at(-1).text.includes('找不到'), '找不到的代號要回錯誤訊息');
  await telegram.handle({ message: { message_id: 3, chat: { id: 42 }, text: '/deep' } });
  assert(sent.at(-1).text.includes('例：/deep SOL'));
  await telegram.handle({ message: { message_id: 4, chat: { id: 999 }, text: '/deep SOL' } });
  assert(!sent.some(m => m.chat_id === 999), '陌生人不能用指令');
  await telegram.handle({ message: { message_id: 5, chat: { id: 999 }, text: '/start' } });
  assert(sent.at(-1).chat_id === 999 && sent.at(-1).text.includes('<code>999</code>'), '陌生人 /start 告訴他 chat id');
  const n = sent.length;
  await telegram.handle({ message: { message_id: 6, chat: { id: 42 }, text: '/brief' } });
  assert(sent.length > n && sent.at(-1).text.includes('聚寶盆早報'), '/brief 要回早報');
  console.log('\nTelegram 指令：通過');

  // ---- HTTP ----
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body, headers = {}) => fetchReal(base + p, 'POST', body, headers);
  const fetchReal = (url, method, body, headers) => new Promise((resolve, reject) => {
    const r = require('http').request(url, { method, headers: { 'Content-Type': 'application/json', ...headers } }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, json: () => JSON.parse(d) })); });
    r.on('error', reject); if (body) r.write(JSON.stringify(body)); r.end();
  });
  assert.strictEqual((await post('/api/telegram', { message: { chat: { id: 42 }, text: '/help' } })).status, 401, '沒帶 secret 要擋');
  sent.length = 0;
  assert.strictEqual((await post('/api/telegram', { message: { message_id: 7, chat: { id: 42 }, text: '/help' } }, { 'x-telegram-bot-api-secret-token': telegram.secret() })).status, 200);
  await new Promise(r => setTimeout(r, 200));
  assert(sent.some(m => m.text.includes('聚寶盆指令')), 'webhook 收到 /help 要回覆');
  assert.strictEqual((await fetchReal(`${base}/api/deep?sym=SOL`, 'GET')).status, 401, '/api/deep 要密碼');
  const dj = (await fetchReal(`${base}/api/deep?sym=SOL&token=pw`, 'GET')).json();
  assert(dj.text.includes('結論'));
  const bj = (await fetchReal(`${base}/api/brief?token=pw`, 'GET')).json();
  assert(bj.text.includes('SMC 訊號') && bj.ai === 'ok');
  server.close();
  clean();
  console.log('HTTP：通過\n\n全部通過');
  process.exit(0);
})().catch(e => { console.error('測試失敗：', e.stack || e.message); clean(); process.exit(1); });
