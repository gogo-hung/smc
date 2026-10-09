// HTTP 伺服器：提供看板網頁 + API，並啟動定時掃描
const http = require('http');
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const scanner = require('./scanner');

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
  entry: r.entry ?? null, stop: r.stop ?? null, target: r.target ?? null, rr: r.rr ?? null, dist: r.dist ?? null,
});

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
        updatedAt: s.lastScan, rules: s.rules,
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
    if (url.pathname === '/api/rules') {
      if (req.method === 'GET') return send(res, 200, s.rules);
      if (req.method === 'POST') {
        if (!authorized(req)) return send(res, 401, { error: '需要 x-admin-token' });
        return send(res, 200, scanner.setRules(await readBody(req)));
      }
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

if (require.main === module) {
  server.listen(cfg.PORT, () => {
    console.log(`SMC 掃幣台：http://localhost:${cfg.PORT}`);
    console.log(`Telegram 推播：${cfg.TELEGRAM_BOT_TOKEN && cfg.TELEGRAM_CHAT_ID ? '已啟用' : '未設定（提醒只會印在終端機）'}`);
    scanner.scanOnce().then(() => scanner.startSchedule());
  });
}

module.exports = server;
