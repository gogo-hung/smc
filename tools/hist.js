// 回測用歷史 K 線（research.js / features.js / models.js 共用），快取到 research-cache/
// SOURCE=ccxt（預設）：用 ccxt 抓，EXCHANGE 預設 bingx（也可以 okx、bybit…）
// SOURCE=bingx：直接打 BingX REST（舊方法）
const fs = require('fs'), path = require('path');
const DAYS = +process.env.DAYS || 180, TOP = +process.env.TOP || 60;
const M15 = process.env.M15 === '1', M5 = process.env.M5 === '1';
const SOURCE = process.env.SOURCE || 'ccxt', EXCHANGE = process.env.EXCHANGE || 'bingx';
const CACHE = path.join(__dirname, '..', 'research-cache', SOURCE === 'ccxt' ? `hist-ccxt-${EXCHANGE}-${DAYS}${M15 ? '-m15' : ''}${M5 ? '-m5' : ''}${TOP !== 60 ? `-top${TOP}` : ''}.json` : `hist-${DAYS}.json`);
const TF = { '5m': 300e3, '15m': 900e3, '1h': 3600e3, '4h': 4 * 3600e3 };

async function viaCcxt() {
  const ccxt = require('ccxt');
  const ex = new ccxt[EXCHANGE]({ enableRateLimit: true, options: { defaultType: 'swap' } });
  await ex.loadMarkets();
  const swaps = Object.values(ex.markets).filter(m => m.swap && m.linear && m.quote === 'USDT' && m.settle === 'USDT' && m.active !== false && !/^NC/.test(m.base));
  const tickers = await ex.fetchTickers(swaps.map(m => m.symbol));
  const vol = s => (tickers[s] && (tickers[s].quoteVolume || (tickers[s].baseVolume || 0) * (tickers[s].last || 0))) || 0;
  const ranked = swaps.filter(m => vol(m.symbol) >= 5e6).sort((a, b) => vol(b.symbol) - vol(a.symbol)).slice(0, TOP);
  const btc = swaps.find(m => m.base === 'BTC');
  const list = [...new Map([btc, ...ranked].filter(Boolean).map(m => [m.base, m])).values()];
  console.log(`ccxt ${EXCHANGE}：${swaps.length} 個 USDT 永續，取成交額前 ${list.length} 個`);
  const now = Date.now(), data = {};
  const range = async (sym, tf, since) => {
    const out = new Map(); let s = since;
    while (s < now) {
      let rows;
      for (let k = 0; ; k++) { try { rows = await ex.fetchOHLCV(sym, tf, s, 1000); break; } catch (e) { if (k >= 3) throw e; await new Promise(r => setTimeout(r, 1500 * (k + 1))); } }
      if (!rows.length) { s += TF[tf] * 1000; continue; }   // 還沒上市的區段：往後跳
      for (const r of rows) if (r[0] >= since && r[0] + TF[tf] <= now) out.set(r[0], { t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] });
      const last = rows[rows.length - 1][0];
      if (last < s) break;
      s = last + TF[tf];
    }
    return [...out.values()].sort((a, b) => a.t - b.t);
  };
  let i = 0;
  const work = async () => { while (i < list.length) { const m = list[i++];
    try {
      const ltf = await range(m.symbol, '1h', now - DAYS * 864e5 - 300 * 3600e3);
      const htf = await range(m.symbol, '4h', now - DAYS * 864e5 - 500 * 4 * 3600e3);
      const m15 = M15 ? (await range(m.symbol, '15m', now - DAYS * 864e5 - 300 * 900e3)).map(b => [b.t, b.o, b.h, b.l, b.c, b.v]) : undefined;
      const m5 = M5 ? (await range(m.symbol, '5m', now - DAYS * 864e5 - 300 * 300e3)).map(b => [b.t, b.o, b.h, b.l, b.c, b.v]) : undefined;
      data[m.base] = { ltf, htf, m15, m5 }; process.stdout.write('.');
    } catch (e) { console.log(`\n${m.symbol} 失敗：${e.message}`); } } };
  await Promise.all([work(), work(), work()]);
  return data;
}

async function viaBingx() {
  const bingx = require('../src/bingx');
  const isTradfi = s => /^NC[A-Z0-9]*2USD-USDT$|^NC(CO|SK|SI|FX)/.test(s);
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
  return data;
}

async function load() {
  const expand = d => { const ex = a => a.map(a => ({ t: a[0], o: a[1], h: a[2], l: a[3], c: a[4], v: a[5] })); for (const k in d) { if (d[k].m15 && Array.isArray(d[k].m15[0])) d[k].m15 = ex(d[k].m15); if (d[k].m5 && Array.isArray(d[k].m5[0])) d[k].m5 = ex(d[k].m5); } return d; };
  if (fs.existsSync(CACHE)) return expand(JSON.parse(fs.readFileSync(CACHE, 'utf8')));
  const data = SOURCE === 'ccxt' ? await viaCcxt() : await viaBingx();
  const bars = Object.values(data).reduce((a, d) => a + d.ltf.length, 0);
  console.log(`\n抓了 ${Object.keys(data).length} 個幣、${bars} 根 1H（來源：${SOURCE === 'ccxt' ? `ccxt / ${EXCHANGE}` : 'BingX REST'}）`);
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, JSON.stringify(data));
  return expand(data);
}

module.exports = { load, DAYS, SOURCE, EXCHANGE, CACHE };
