// 抓 BingX 歷史並快取（research.js / features.js 共用）
const fs = require('fs'), path = require('path');
const bingx = require('../src/bingx');
const DAYS = +process.env.DAYS || 180, TOP = +process.env.TOP || 60;
const CACHE = path.join(__dirname, '..', 'research-cache', `hist-${DAYS}.json`);
const isTradfi = s => /^NC[A-Z0-9]*2USD-USDT$|^NC(CO|SK|SI|FX)/.test(s);
async function load() {
  if (fs.existsSync(CACHE)) return JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  const [contracts, tickers] = await Promise.all([bingx.getContracts(), bingx.getTickers()]);
  const vol = new Map(tickers.map(t => [t.symbol, t.quoteVolume]));
  const ranked = contracts.filter(s => !isTradfi(s) && (vol.get(s) || 0) >= 5e6).sort((a, b) => vol.get(b) - vol.get(a)).slice(0, TOP);
  const syms = [...new Set(['BTC-USDT', ...ranked])];
  const now = Date.now(), data = {};
  await bingx.pool(syms, async symbol => {
    const ltf = await bingx.getKlinesRange(symbol, '1h', now - DAYS * 864e5 - 300 * 3600e3, now);
    const htf = await bingx.getKlinesRange(symbol, '4h', now - DAYS * 864e5 - 500 * 4 * 3600e3, now);
    data[symbol.replace('-USDT', '')] = { ltf, htf };
    process.stdout.write('.');
  });
  console.log(`\n抓了 ${Object.keys(data).length} 個幣`);
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, JSON.stringify(data));
  return data;
}

module.exports = { load, DAYS };
