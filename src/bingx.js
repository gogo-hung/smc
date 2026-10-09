// BingX USDT 永續合約公開行情 API（不需要 API Key，不會下單）
const cfg = require('./config');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const INTERVAL_MS = { '15m': 15 * 60e3, '1h': 60 * 60e3, '4h': 4 * 60 * 60e3 };

async function get(path, params = {}, tries = 3) {
  const qs = new URLSearchParams({ ...params, timestamp: Date.now() }).toString();
  const url = `${cfg.BINGX_BASE}${path}?${qs}`;
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'smc-scanner/1.0' } });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (body.code !== 0 && body.code !== undefined) throw new Error(`BingX ${body.code}: ${body.msg}`);
      return body.data;
    } catch (e) {
      lastErr = e;
      await sleep(600 * (i + 1));
    }
  }
  throw new Error(`${path} ${params.symbol || ''} 失敗：${lastErr.message}`);
}

// 所有 USDT 永續合約（快取 1 小時）
let contractsCache = { at: 0, list: [] };
async function getContracts() {
  if (Date.now() - contractsCache.at < 3600e3 && contractsCache.list.length) return contractsCache.list;
  const data = await get('/openApi/swap/v2/quote/contracts');
  const list = (data || [])
    .filter(c => /-USDT$/.test(c.symbol) && (c.status === undefined || +c.status === 1))
    .map(c => c.symbol);
  contractsCache = { at: Date.now(), list };
  return list;
}

// 24h 行情：用成交額挑出流動性夠的幣
async function getTickers() {
  const data = await get('/openApi/swap/v2/quote/ticker');
  return (Array.isArray(data) ? data : [data]).map(t => ({
    symbol: t.symbol,
    last: +t.lastPrice,
    quoteVolume: +(t.quoteVolume ?? 0),
    change: +(t.priceChangePercent ?? 0),
  }));
}

// K 線 → [{t,o,h,l,c,v}]，時間由舊到新，並去掉還沒收盤的那根
async function getKlines(symbol, interval, limit) {
  const data = await get('/openApi/swap/v3/quote/klines', { symbol, interval, limit });
  const bars = (data || []).map(k => Array.isArray(k)
    ? { t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }
    : { t: +k.time, o: +k.open, h: +k.high, l: +k.low, c: +k.close, v: +k.volume })
    .filter(b => isFinite(b.t) && isFinite(b.c))
    .sort((a, b) => a.t - b.t);
  const span = INTERVAL_MS[interval];
  while (bars.length && span && bars[bars.length - 1].t + span > Date.now()) bars.pop();
  return bars;
}

// 限制同時請求數，避免撞到頻率限制
async function pool(items, worker, n = cfg.CONCURRENCY) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = await worker(items[i]); } catch (e) { out[i] = { error: e.message }; }
      await sleep(cfg.REQUEST_GAP_MS);
    }
  }));
  return out;
}

module.exports = { getContracts, getTickers, getKlines, pool, INTERVAL_MS };
