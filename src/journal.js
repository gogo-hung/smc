// 交易紀錄 + 風控鎖：今天（台灣時間）連虧兩筆就鎖住，停止推播新訊號
const store = require('./store');

const LOCK_AFTER = Number(process.env.LOCK_AFTER_LOSSES || 2);
const state = { trades: [] };
const twDate = ts => new Date(ts).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' }); // YYYY-MM-DD

async function init() { state.trades = await store.load('journal', []); }

function clean(t) {
  const sym = String(t.sym || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/USDT$/, '');
  const pnl = Number(t.pnl);
  if (!sym) throw Object.assign(new Error('請填幣種'), { code: 400 });
  if (!isFinite(pnl)) throw Object.assign(new Error('盈虧要填數字（虧損填負數）'), { code: 400 });
  const num = v => (v === '' || v == null || !isFinite(+v) ? null : +v);
  return {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    at: Number(t.at) || Date.now(), sym, dir: +t.dir > 0 ? 1 : -1, pnl,
    entry: num(t.entry), exit: num(t.exit), r: num(t.r),
    note: String(t.note || '').slice(0, 300), followedSignal: !!t.followedSignal,
  };
}

async function add(t) {
  const trade = clean(t);
  state.trades.push(trade);
  state.trades.sort((a, b) => a.at - b.at);
  state.trades = state.trades.slice(-1000);
  await store.save('journal', state.trades);
  return trade;
}

async function remove(id) {
  const n = state.trades.length;
  state.trades = state.trades.filter(t => t.id !== id);
  if (state.trades.length === n) throw Object.assign(new Error('找不到這筆紀錄'), { code: 404 });
  await store.save('journal', state.trades);
}

function today() { const d = twDate(Date.now()); return state.trades.filter(t => twDate(t.at) === d); }

function lossStreak() {
  let n = 0;
  for (const t of [...today()].reverse()) { if (t.pnl < 0) n++; else break; }
  return n;
}
const locked = () => LOCK_AFTER > 0 && lossStreak() >= LOCK_AFTER;

function summary() {
  const td = today(), all = state.trades;
  const sum = a => a.reduce((s, t) => s + t.pnl, 0);
  const wins = all.filter(t => t.pnl > 0).length;
  return {
    locked: locked(), lockAfter: LOCK_AFTER, lossStreak: lossStreak(),
    today: { count: td.length, pnl: sum(td), wins: td.filter(t => t.pnl > 0).length, losses: td.filter(t => t.pnl < 0).length },
    all: { count: all.length, pnl: sum(all), winRate: all.length ? wins / all.length : null },
    trades: all.slice(-100).reverse(),
  };
}

module.exports = { init, add, remove, summary, locked, lossStreak, twDate };
