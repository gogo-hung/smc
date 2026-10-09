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
  INCLUDE_TRADFI: /^(1|true|yes)$/i.test(process.env.INCLUDE_TRADFI || ''), // 是否掃 BingX 的美股、指數、商品（NC 開頭）
  MIN_QUOTE_VOLUME: num(process.env.MIN_QUOTE_VOLUME, 5_000_000), // 24h 成交額下限（USDT）

  LTF_LIMIT: num(process.env.LTF_LIMIT, 500),    // 15M 根數（約 5 天）
  HTF_LIMIT: num(process.env.HTF_LIMIT, 200),    // 4H 根數（約 33 天）
  CONCURRENCY: num(process.env.CONCURRENCY, 4),
  REQUEST_GAP_MS: num(process.env.REQUEST_GAP_MS, 120),
  SCAN_DELAY_SEC: num(process.env.SCAN_DELAY_SEC, 15), // 15M 收盤後等幾秒再抓
  ALERT_MAX_AGE_BARS: num(process.env.ALERT_MAX_AGE_BARS, 3), // CHoCH 在最近幾根 15M 內才推播（0 = 不限）

  // 財經日曆提醒
  CAL_ENABLED: !/^(0|false|no)$/i.test(process.env.CAL_ENABLED || ''),
  CAL_COUNTRIES: list(process.env.CAL_COUNTRIES || 'USD'),          // 要提醒的國家，例：USD,CNY
  CAL_MIN_IMPACT: process.env.CAL_MIN_IMPACT || 'High',               // High / Medium / Low
  CAL_ALERT_LEADS: (process.env.CAL_ALERT_LEADS || '30,5').split(',').map(Number).filter(n => n > 0), // 公布前幾分鐘提醒
  EARNINGS_TICKERS: list(process.env.EARNINGS_TICKERS || 'NVDA,TSLA,AAPL,MSFT,AMZN,META,GOOGL,COIN,MSTR'), // 要追蹤財報的美股
  EXTRA_MAX: num(process.env.EXTRA_MAX, 20),                         // 搜尋加入的幣最多幾個

  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',
  PUBLIC_URL: process.env.PUBLIC_URL || '',      // 有填的話，推播會附上看板連結
};
