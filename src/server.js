// HTTP 伺服器：提供看板網頁 + API，並啟動定時掃描
const http = require('http');
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const scanner = require('./scanner');
const bingx = require('./bingx');
const calendar = require('./calendar');
const tracker = require('./tracker');
const journal = require('./journal');
const earnings = require('./earnings');
const store = require('./store');
const notify = require('./notify');

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const PUBLIC_DIR = path.join(cfg.ROOT, 'public');
const STATIC = {
  '/': [path.join(PUBLIC_DIR, 'index.html'), 'text/html; charset=utf-8'],
  '/index.html': [path.join(PUBLIC_DIR, 'index.html'), 'text/html; charset=utf-8'],
  '/app.js': [path.join(PUBLIC_DIR, 'app.js'), 'text/javascript; charset=utf-8'],
  '/smc.js': [path.join(__dirname, 'smc.js'), 'text/javascript; charset=utf-8'],
};

const pack = bars => bars.map(b => [b.t, b.o, b.h, b.l, b.c, b.v]);
const brief = r => ({
  sym: r.sym, dir: r.dir, status: r.status, last: r.last, met: r.met, need: r.need, st: r.st,
  entry: r.entry ?? null, stop: r.stop ?? null, target: r.target ?? null, rr: r.rr ?? null, be: r.be ?? null, score: r.score, scoreMax: r.scoreMax, quality: r.quality || null, zone: r.zone || null, fvgState: r.fvgState || null, bonus: r.bonus, dist: r.dist ?? null, flags: r.flags || [],
});
// 回測用的歷史資料（暫存 2 小時，避免重複抓）
const histCache = new Map();
async function history(sym, days) {
  const key = `${sym}|${days}`, hit = histCache.get(key);
  if (hit && Date.now() - hit.at < 2 * 3600e3) return hit.data;
  const symbol = `${sym}-USDT`;
  if (!(await bingx.getContracts()).includes(symbol)) throw Object.assign(new Error(`BingX 沒有 ${sym}/USDT 永續合約`), { code: 404 });
  const now = Date.now(), warm = 300 * 3600e3;            // 前面多抓 300 根 1H 當暖機
  const ltf = await bingx.getKlinesRange(symbol, '1h', now - days * 86400e3 - warm, now);
  const htf = await bingx.getKlinesRange(symbol, '4h', now - days * 86400e3 - 500 * 4 * 3600e3, now); // 多抓 500 根 4H（也用來合成日線）
  const data = { sym, days, ltf: pack(ltf), htf: pack(htf) };
  histCache.set(key, { at: Date.now(), data });
  if (histCache.size > 80) histCache.delete(histCache.keys().next().value);
  return data;
}
const fail = (res, e) => send(res, e.code || 500, { error: e.message });

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = ''; req.on('data', c => { d += c; if (d.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
  });
}
const authorized = req => !ADMIN_TOKEN || req.headers['x-admin-token'] === ADMIN_TOKEN;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const s = scanner.state;
  try {
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      return send(res, 200, fs.readFileSync(file), type);
    }
    if (url.pathname === '/api/health') {
      return send(res, 200, { ok: true, lastScan: s.lastScan, scanning: s.scanning, lastError: s.lastError, symbols: Object.keys(s.market).length, errors: s.errors.slice(0, 10) });
    }
    if (url.pathname === '/api/market' && req.method === 'GET') {
      return send(res, 200, {
        updatedAt: s.lastScan, rules: s.rules, ctx: s.ctx,
        symbols: Object.values(s.market).map(m => ({ sym: m.sym, quoteVolume: m.quoteVolume, ltf: pack(m.ltf), htf: pack(m.htf) })),
      });
    }
    if (url.pathname === '/api/signals' && req.method === 'GET') {
      const only = url.searchParams.get('status');
      return send(res, 200, { updatedAt: s.lastScan, rules: s.rules, results: s.results.filter(r => !only || r.status === only).map(brief) });
    }
    // 給外部排程（cron-job.org）用：GET /api/cron?token=ADMIN_TOKEN，順便叫醒休眠中的服務
    if (url.pathname === '/api/cron') {
      if (ADMIN_TOKEN && url.searchParams.get('token') !== ADMIN_TOKEN && req.headers['x-admin-token'] !== ADMIN_TOKEN) return send(res, 401, { error: 'token 錯誤' });
      const fresh = s.lastScan && Date.now() - s.lastScan < 5 * 60e3;
      return send(res, 200, fresh ? { skipped: '5 分鐘內已掃描過', lastScan: s.lastScan } : await scanner.scanOnce());
    }
    // 立即掃描：只抓公開行情、不改設定，所以不需要密碼；1 分鐘內重複按只回傳上次結果
    if (url.pathname === '/api/scan' && req.method === 'POST') {
      if (s.lastScan && Date.now() - s.lastScan < 60e3) return send(res, 200, { skipped: '1 分鐘內已掃描過', lastScan: s.lastScan });
      return send(res, 200, await scanner.scanOnce());
    }
    if (url.pathname === '/api/calendar' && req.method === 'GET') {
      const c = calendar.state;
      return send(res, 200, { updatedAt: c.updatedAt, error: c.error, alert: { countries: cfg.CAL_COUNTRIES, minImpact: cfg.CAL_MIN_IMPACT, leads: cfg.CAL_ALERT_LEADS }, events: calendar.upcoming() });
    }
    // 搜尋加入幣種：不需要密碼，3 秒內只受理一次
    if (url.pathname === '/api/add' && req.method === 'POST') {
      if (Date.now() - (server.lastAdd || 0) < 3000) return send(res, 429, { error: '太快了，請稍等幾秒' });
      server.lastAdd = Date.now();
      try { return send(res, 200, await scanner.addSymbol((await readBody(req)).sym)); }
      catch (e) { return send(res, e.code || 500, { error: e.message }); }
    }
    // 提醒中心（鈴鐺）
    if (url.pathname === '/api/alerts' && req.method === 'GET') {
      return send(res, 200, { feed: tracker.state.feed.slice(0, 100), settings: tracker.state.settings, locked: journal.locked(), lossStreak: journal.lossStreak(), storage: store.kind, persistent: store.persistent, telegram: notify.channels().telegram, discord: notify.channels().discord });
    }
    if (url.pathname === '/api/alert-settings' && req.method === 'POST') {
      if (!authorized(req)) return send(res, 401, { error: '需要管理員密碼' });
      return send(res, 200, await tracker.setSettings(await readBody(req)));
    }
    if (url.pathname === '/api/test-alert' && req.method === 'POST') {
      if (!authorized(req)) return send(res, 401, { error: '需要管理員密碼' });
      const ch = notify.channels();
      if (!ch.discord && !ch.telegram) return send(res, 400, { error: 'Render 還沒設定 DISCORD_WEBHOOK_URL（或 Telegram）' });
      return send(res, 200, { ok: await notify.send('🔔 <b>聚寶盆：推播測試</b>\n設定成功！之後新訊號、接近進場、移保本、止盈止損、數據公布前都會推到這裡。') });
    }
    // 訊號成績單
    if (url.pathname === '/api/stats' && req.method === 'GET') return send(res, 200, tracker.stats(url.searchParams.get('all') === '1'));
    // 交易紀錄（私人資料，看和改都要密碼）
    if (url.pathname === '/api/journal') {
      if (!authorized(req)) return send(res, 401, { error: '需要管理員密碼' });
      try {
        if (req.method === 'GET') return send(res, 200, journal.summary(url.searchParams.get('all') === '1'));
        if (req.method === 'POST') { await journal.add(await readBody(req)); return send(res, 200, journal.summary()); }
        if (req.method === 'DELETE') { await journal.remove(url.searchParams.get('id')); return send(res, 200, journal.summary()); }
      } catch (e) { return fail(res, e); }
    }
    if (url.pathname === '/api/history' && req.method === 'GET') {
      if (url.searchParams.get('fresh') === '1') histCache.clear();
      const sym = String(url.searchParams.get('sym') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const days = Math.min(180, Math.max(7, +url.searchParams.get('days') || 90));
      if (!sym) return send(res, 400, { error: '缺少 sym' });
      try {
        const data = await history(sym, days);
        if (url.searchParams.get('meta') === '1') { // 檢查用：只回根數、起訖、缺口
          const info = arr => { const step = arr.length > 1 ? Math.min(...arr.slice(1, 50).map((b, i) => b[0] - arr[i][0])) : 0;
            const gaps = []; for (let i = 1; i < arr.length; i++) if (arr[i][0] - arr[i - 1][0] !== step) gaps.push({ after: new Date(arr[i - 1][0]).toISOString(), missing: (arr[i][0] - arr[i - 1][0]) / step - 1 });
            return { count: arr.length, first: arr[0] && new Date(arr[0][0]).toISOString(), last: arr.length && new Date(arr[arr.length - 1][0]).toISOString(), stepMin: step / 60000, gaps: gaps.slice(0, 20) }; };
          return send(res, 200, { sym, days, ltf: info(data.ltf), htf: info(data.htf) });
        }
        return send(res, 200, data);
      } catch (e) { return fail(res, e); }
    }
    if (url.pathname === '/api/earnings' && req.method === 'GET') {
      const e = earnings.state;
      return send(res, 200, { updatedAt: e.updatedAt, error: e.error, tickers: e.tickers, events: e.events });
    }
    if (url.pathname === '/api/rules') {
      if (req.method === 'GET') return send(res, 200, s.rules);
      if (req.method === 'POST') {
        if (!authorized(req)) return send(res, 401, { error: '需要 x-admin-token' });
        return send(res, 200, await scanner.setRules(await readBody(req)));
      }
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

if (require.main === module) {
  server.listen(cfg.PORT, async () => {
    console.log(`聚寶盆：http://localhost:${cfg.PORT}`);
    const ch = notify.channels();
    console.log(`推播：Discord ${ch.discord ? '已啟用' : '未設定'}｜Telegram ${ch.telegram ? '已啟用' : '未設定'}`);
    console.log(`儲存：${store.kind}`);
    await scanner.init();
    calendar.start(tracker.emit);
    earnings.start(tracker.emit);
    scanner.scanOnce().then(() => scanner.startSchedule());
  });
}

module.exports = server;
