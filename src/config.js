// 讀取 .env（不需要額外套件）
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    let v = m[2];
    if (/^["']/.test(v)) v = v.replace(/^(["'])(.*)\1.*$/, '$2');   // 有引號：取引號內
    else v = v.replace(/(^|\s+)#.*$/, '').trim();                      // 沒引號：去掉行尾註解
    process.env[m[1]] = v;
  }
}

const list = v => (v || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const num = (v, d) => (v === undefined || v === '' || isNaN(+v) ? d : +v);

module.exports = {
  ROOT,
  DATA_DIR: path.join(ROOT, 'data'),
  PORT: num(process.env.PORT, 8787),
  BINGX_BASE: process.env.BINGX_BASE || 'https://open-api.bingx.com',

  // 掃描範圍：24h 成交額前 N 名 + 自選清單，排除清單裡的幣
  TOP_N: num(process.env.TOP_N, 60),
  WATCHLIST: list(process.env.WATCHLIST),        // 例：BTC,ETH,SOL
  EXCLUDE: list(process.env.EXCLUDE),            // 例：USDC,FDUSD
  MIN_QUOTE_VOLUME: num(process.env.MIN_QUOTE_VOLUME, 5_000_000), // 24h 成交額下限（USDT）

  LTF_LIMIT: num(process.env.LTF_LIMIT, 500),    // 15M 根數（約 5 天）
  HTF_LIMIT: num(process.env.HTF_LIMIT, 200),    // 4H 根數（約 33 天）
  CONCURRENCY: num(process.env.CONCURRENCY, 4),
  REQUEST_GAP_MS: num(process.env.REQUEST_GAP_MS, 120),
  SCAN_DELAY_SEC: num(process.env.SCAN_DELAY_SEC, 15), // 15M 收盤後等幾秒再抓
  ALERT_MAX_AGE_BARS: num(process.env.ALERT_MAX_AGE_BARS, 3), // CHoCH 在最近幾根 15M 內才推播（0 = 不限）

  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',
  PUBLIC_URL: process.env.PUBLIC_URL || '',      // 有填的話，推播會附上看板連結
};
