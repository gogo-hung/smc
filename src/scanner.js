// 掃描主流程：挑幣 → 抓 15M / 4H K 線 → 跑 SMC + 大盤濾網 → 交給提醒中心
const cfg = require('./config');
const bingx = require('./bingx');
const SMC = require('./smc');
const store = require('./store');
const tracker = require('./tracker');
const journal = require('./journal');

// 策略：日線 / H4 找趨勢 → 1H 結構裡的 OB → 1H 型態（吞沒 / Pin bar）
// 加分條件（need 必要 / score 加分 / off 不看）：斐波便宜區、EMA50 順勢、OB 帶 FVG、掃流動性、日線同向；加分 ≥ minScore 才推
// beAt：獲利走到目標的幾成時，止損移到開倉價（0 = 不用）
const DEFAULT_RULES = { swingLen: 3, htfSwing: 3, breakBy: 'close', obInvalid: 'close', fibMin: 0.618, emaLen: 50, lookback: 10, entry: 'close', minRR: 3, stopBuf: 0.2, target: 'htf', btcFilter: 'block', fundingMax: 0.05, side: 'both', stopMode: 'ob',
  pattern: 'engulf', cFib: 'need', cEma: 'need', cFvg: 'need', cSweep: 'score', cDaily: 'score', minScore: 0, beAt: 0.5, minQuality: 0 };

const state = {
  rules: { ...DEFAULT_RULES },
  extras: [],          // 用搜尋加入的幣，之後每輪都會掃
  market: {},          // { BTC: { sym, symbol, ltf, htf, quoteVolume } }
  ctx: { btcDir: 0, funding: {} },
  results: [],
  lastScan: null, lastError: null, scanning: false, errors: [],
};

async function init() {
  state.rules = { ...DEFAULT_RULES, ...(await store.load('rules_v9', {})) };
  state.extras = await store.load('extras', []);
  await journal.init();
  await tracker.init();
}

async function setRules(next) {
  const clean = {};
  for (const k of Object.keys(DEFAULT_RULES)) {
    if (next[k] === undefined) continue;
    clean[k] = typeof DEFAULT_RULES[k] === 'number' ? +next[k] : typeof DEFAULT_RULES[k] === 'boolean' ? !!next[k] : String(next[k]);
  }
  state.rules = { ...DEFAULT_RULES, ...clean };
  await store.save('rules_v9', state.rules);
  rerun();
  return state.rules;
}

const isTradfi = s => /^NC[A-Z0-9]*2USD-USDT$|^NC(CO|SK|SI|FX)/.test(s);

async function pickUniverse() {
  const [contracts, tickers] = await Promise.all([bingx.getContracts(), bingx.getTickers()]);
  const live = new Set(contracts);
  const vol = new Map(tickers.map(t => [t.symbol, t.quoteVolume]));
  const price = new Map(tickers.map(t => [t.symbol, t.last]));
  const base = s => s.replace(/-USDT$/, '');
  const ranked = contracts
    .filter(s => !cfg.EXCLUDE.includes(base(s)))
    .filter(s => cfg.INCLUDE_TRADFI || !isTradfi(s)) // 預設排除美股、指數、商品
    .filter(s => (vol.get(s) || 0) >= cfg.MIN_QUOTE_VOLUME)
    .sort((a, b) => (vol.get(b) || 0) - (vol.get(a) || 0))
    .slice(0, cfg.TOP_N);
  // BTC 一定要掃（大盤濾網要用），加上自選、搜尋加入的、還在追蹤成績的幣
  const watch = ['BTC', ...cfg.WATCHLIST, ...state.extras, ...tracker.openSymbols()].map(s => `${s}-USDT`).filter(s => live.has(s));
  return { symbols: [...new Set([...watch, ...ranked])], vol, price };
}

// 用目前的行情與規則重新判斷（改規則時不用重抓資料）
function rerun() {
  const out = [];
  for (const [sym, m] of Object.entries(state.market)) {
    if (!m.ltf || m.ltf.length < 50) continue;
    try { out.push(SMC.analyze(sym, m.ltf, state.rules, m.htf)); }
    catch (e) { state.errors.push(`${sym} 判斷失敗：${e.message}`); }
  }
  // BTC 的 H4 方向 = 大盤方向，再套到每個幣
  const btc = out.find(r => r.sym === 'BTC');
  state.ctx.btcDir = btc ? btc.dir : 0;
  out.forEach(r => SMC.applyContext(r, state.ctx, state.rules));
  const order = { trigger: 0, watch: 1, idle: 2 };
  out.sort((a, b) => order[a.status] - order[b.status] || b.met / b.need.length - a.met / a.need.length);
  state.results = out;
  return out;
}

async function scanOnce() {
  if (state.scanning) return { busy: true };
  state.scanning = true; state.errors = [];
  const t0 = Date.now();
  try {
    const { symbols, vol, price } = await pickUniverse();
    const now = Date.now();
    const fetched = await bingx.pool(symbols, async symbol => {
      const sym = symbol.replace(/-USDT$/, '');
      const prev = state.market[sym];
      // 4H 只在有新 K 棒收盤時才重抓
      const htfStale = !prev || !prev.htf || !prev.htf.length || now >= prev.htf[prev.htf.length - 1].t + 2 * bingx.INTERVAL_MS['4h'];
      const [ltf, htf] = await Promise.all([
        bingx.getKlines(symbol, cfg.LTF_INTERVAL, cfg.LTF_LIMIT),
        htfStale ? bingx.getKlines(symbol, '4h', cfg.HTF_LIMIT) : Promise.resolve(prev.htf),
      ]);
      return { sym, symbol, ltf, htf, quoteVolume: vol.get(symbol) || 0, price: price.get(symbol) };
    });
    const market = {};
    for (const f of fetched) {
      if (f && f.error) { state.errors.push(f.error); continue; }
      market[f.sym] = f;
    }
    state.market = market;
    try { state.ctx.funding = await bingx.getFunding(); } catch (e) { state.errors.push(`資金費率：${e.message}`); }
    const results = rerun();
    await tracker.onScan(results, market);

    state.lastScan = Date.now(); state.lastError = null;
    const summary = { symbols: Object.keys(market).length, trigger: results.filter(r => r.status === 'trigger').length, watch: results.filter(r => r.status === 'watch').length, btcDir: state.ctx.btcDir, ms: Date.now() - t0, errors: state.errors.length };
    console.log(`[${new Date().toLocaleString('zh-TW', { hour12: false })}] 掃描 ${summary.symbols} 幣｜觸發 ${summary.trigger}｜觀察 ${summary.watch}｜BTC ${summary.btcDir > 0 ? '多' : summary.btcDir < 0 ? '空' : '—'}｜${summary.ms}ms${summary.errors ? `｜失敗 ${summary.errors}` : ''}`);
    return summary;
  } catch (e) {
    state.lastError = e.message;
    console.error('掃描失敗：', e.message);
    return { error: e.message };
  } finally {
    state.scanning = false;
  }
}

// 搜尋：把不在名單裡的幣加進來（立即抓資料，之後每輪都會掃）
async function addSymbol(raw) {
  const sym = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/USDT$/, '');
  if (!sym) throw Object.assign(new Error('請輸入幣種代號'), { code: 400 });
  if (state.market[sym]) return { sym, already: true };
  const symbol = `${sym}-USDT`;
  const contracts = await bingx.getContracts();
  if (!contracts.includes(symbol)) throw Object.assign(new Error(`BingX 沒有 ${sym}/USDT 永續合約`), { code: 404 });
  const [ltf, htf] = await Promise.all([bingx.getKlines(symbol, cfg.LTF_INTERVAL, cfg.LTF_LIMIT), bingx.getKlines(symbol, '4h', cfg.HTF_LIMIT)]);
  if (ltf.length < 50) throw Object.assign(new Error(`${sym} 上市時間太短，K 線不足`), { code: 422 });
  state.market[sym] = { sym, symbol, ltf, htf, quoteVolume: 0 };
  state.extras = [...state.extras.filter(s => s !== sym), sym].slice(-cfg.EXTRA_MAX);
  await store.save('extras', state.extras);
  rerun();
  return { sym, added: true };
}

// 每 15 分鐘掃一次（1H 收盤時一定會掃到；中間幾次用來更新現價、接近進場區提醒）
function startSchedule() {
  const period = bingx.INTERVAL_MS['15m'];
  const tick = () => {
    const wait = period - (Date.now() % period) + cfg.SCAN_DELAY_SEC * 1000;
    setTimeout(async () => { await scanOnce(); tick(); }, wait);
  };
  tick();
}

module.exports = { state, init, scanOnce, startSchedule, setRules, rerun, addSymbol, DEFAULT_RULES };
