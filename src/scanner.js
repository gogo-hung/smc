// 掃描主流程：挑幣 → 抓 15M / 4H K 線 → 跑 SMC → 新訊號推播
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const bingx = require('./bingx');
const SMC = require('./smc');
const notify = require('./notify');

const DEFAULT_RULES = { swingLen: 3, htfSwing: 3, breakBy: 'close', obInvalid: 'close', needSweep: true, needChoch: true, needFvg: false, minRR: 2, lookback: 64, stopBuf: 0.1, target: 'ltf' };
const RULES_FILE = path.join(cfg.DATA_DIR, 'rules.json');
const STATE_FILE = path.join(cfg.DATA_DIR, 'state.json');

const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJSON = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2)); };

const state = {
  rules: { ...DEFAULT_RULES, ...readJSON(RULES_FILE, {}) },
  alerted: readJSON(STATE_FILE, { alerted: [] }).alerted, // 已推播過的訊號 key，重開也不會重複推
  market: {},          // { BTC: { symbol, ltf, htf, quoteVolume } }
  results: [],
  lastScan: null, lastError: null, scanning: false, errors: [],
};

function setRules(next) {
  const clean = {};
  for (const k of Object.keys(DEFAULT_RULES)) {
    if (next[k] === undefined) continue;
    clean[k] = typeof DEFAULT_RULES[k] === 'number' ? +next[k] : typeof DEFAULT_RULES[k] === 'boolean' ? !!next[k] : String(next[k]);
  }
  state.rules = { ...DEFAULT_RULES, ...clean };
  writeJSON(RULES_FILE, state.rules);
  rerun();
  return state.rules;
}

async function pickUniverse() {
  const [contracts, tickers] = await Promise.all([bingx.getContracts(), bingx.getTickers()]);
  const live = new Set(contracts);
  const vol = new Map(tickers.map(t => [t.symbol, t.quoteVolume]));
  const base = s => s.replace(/-USDT$/, '');
  const ranked = contracts
    .filter(s => !cfg.EXCLUDE.includes(base(s)))
    .filter(s => cfg.INCLUDE_TRADFI || !/^NC[A-Z0-9]*2USD-USDT$|^NC(CO|SK|SI|FX)/.test(s)) // 預設排除美股、指數、商品
    .filter(s => (vol.get(s) || 0) >= cfg.MIN_QUOTE_VOLUME)
    .sort((a, b) => (vol.get(b) || 0) - (vol.get(a) || 0))
    .slice(0, cfg.TOP_N);
  const watch = cfg.WATCHLIST.map(s => `${s}-USDT`).filter(s => live.has(s));
  return { symbols: [...new Set([...watch, ...ranked])], vol };
}

function signalKey(r) {
  const obTime = r.ltf[r.entryOB.idx] && r.ltf[r.entryOB.idx].t;
  return `${r.sym}:${r.dir}:${obTime}`;
}

// 用目前的行情與規則重新判斷（改規則時不用重抓資料）
function rerun() {
  const out = [];
  for (const [sym, m] of Object.entries(state.market)) {
    if (!m.ltf || m.ltf.length < 50) continue;
    try { out.push(SMC.analyze(sym, m.ltf, state.rules, m.htf)); }
    catch (e) { state.errors.push(`${sym} 判斷失敗：${e.message}`); }
  }
  const order = { trigger: 0, watch: 1, idle: 2 };
  out.sort((a, b) => order[a.status] - order[b.status] || b.met / b.need.length - a.met / a.need.length);
  state.results = out;
  return out;
}

async function scanOnce({ silent = false } = {}) {
  if (state.scanning) return { busy: true };
  state.scanning = true; state.errors = [];
  const t0 = Date.now();
  try {
    const { symbols, vol } = await pickUniverse();
    const now = Date.now();
    const fetched = await bingx.pool(symbols, async symbol => {
      const sym = symbol.replace(/-USDT$/, '');
      const prev = state.market[sym];
      // 4H 只在有新 K 棒收盤時才重抓
      const htfStale = !prev || !prev.htf || !prev.htf.length || now >= prev.htf[prev.htf.length - 1].t + 2 * bingx.INTERVAL_MS['4h'];
      const [ltf, htf] = await Promise.all([
        bingx.getKlines(symbol, '15m', cfg.LTF_LIMIT),
        htfStale ? bingx.getKlines(symbol, '4h', cfg.HTF_LIMIT) : Promise.resolve(prev.htf),
      ]);
      return { sym, symbol, ltf, htf, quoteVolume: vol.get(symbol) || 0 };
    });
    const market = {};
    for (const f of fetched) {
      if (f && f.error) { state.errors.push(f.error); continue; }
      market[f.sym] = f;
    }
    state.market = market;
    const results = rerun();

    // 新觸發 → 推播（同一個進場 OB 只推一次）
    // 只推「最近幾根 15M 內才成立」的訊號：Render 免費方案重啟會清掉紀錄，這樣舊訊號不會再推一次
    const maxAge = cfg.ALERT_MAX_AGE_BARS;
    const isFresh = r => !maxAge || (r.ltf.length - 1 - r.choch.idx) < maxAge;
    const fresh = results.filter(r => r.status === 'trigger' && isFresh(r) && !state.alerted.includes(signalKey(r)));
    for (const r of fresh) {
      state.alerted.push(signalKey(r));
      if (!silent) await notify.send(notify.formatSignal(r));
    }
    state.alerted = state.alerted.slice(-500);
    writeJSON(STATE_FILE, { alerted: state.alerted });

    state.lastScan = Date.now(); state.lastError = null;
    const summary = { symbols: Object.keys(market).length, trigger: results.filter(r => r.status === 'trigger').length, watch: results.filter(r => r.status === 'watch').length, newAlerts: fresh.length, ms: Date.now() - t0, errors: state.errors.length };
    console.log(`[${new Date().toLocaleString('zh-TW', { hour12: false })}] 掃描 ${summary.symbols} 幣｜觸發 ${summary.trigger}｜觀察 ${summary.watch}｜新推播 ${summary.newAlerts}｜${summary.ms}ms${summary.errors ? `｜失敗 ${summary.errors}` : ''}`);
    return summary;
  } catch (e) {
    state.lastError = e.message;
    console.error('掃描失敗：', e.message);
    return { error: e.message };
  } finally {
    state.scanning = false;
  }
}

// 每根 15M 收盤後 SCAN_DELAY_SEC 秒掃一次
function startSchedule() {
  const period = bingx.INTERVAL_MS['15m'];
  const tick = () => {
    const wait = period - (Date.now() % period) + cfg.SCAN_DELAY_SEC * 1000;
    setTimeout(async () => { await scanOnce(); tick(); }, wait);
  };
  tick();
}

module.exports = { state, scanOnce, startSchedule, setRules, rerun, DEFAULT_RULES };
