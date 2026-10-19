// 每日早報：每天固定時間（預設台灣 08:30）推一次 Discord / Telegram
// 內容全部來自掃描器已有的資料 + 恐慌貪婪指數；有設 ANTHROPIC_API_KEY 才加一段 AI 摘要（數字會先校驗）
const cfg = require('./config');
const store = require('./store');
const bingx = require('./bingx');
const scanner = require('./scanner');
const tracker = require('./tracker');
const journal = require('./journal');
const calendar = require('./calendar');
const earnings = require('./earnings');
const ai = require('./ai');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const fp = p => p == null || !isFinite(p) ? '—' : p >= 1000 ? p.toFixed(1) : p >= 10 ? p.toFixed(2) : p >= 1 ? p.toFixed(3) : p >= 0.01 ? p.toFixed(4) : p.toPrecision(4);
const pct = (v, d = 2) => v == null || !isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(d)}%`;
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const dirZh = d => (d > 0 ? '多頭' : d < 0 ? '空頭' : '盤整');
const side = d => (d > 0 ? '做多' : '做空');
const twParts = (ts = Date.now()) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(ts).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, mins: (+p.hour % 24) * 60 + +p.minute };
};
const twTime = ts => new Date(ts).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false });
const twDay = ts => new Date(ts).toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', weekday: 'short' });
const nyDate = (ts, add = 0) => new Date(ts + add * 86400e3).toLocaleDateString('sv-SE', { timeZone: 'America/New_York' });

const FNG_ZH = { 'Extreme Fear': '極度恐懼', Fear: '恐懼', Neutral: '中性', Greed: '貪婪', 'Extreme Greed': '極度貪婪' };
async function fearGreed() {
  try {
    const res = await fetch('https://api.alternative.me/fng/?limit=2');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = (await res.json()).data || [];
    if (!d.length) return null;
    return { value: +d[0].value, label: FNG_ZH[d[0].value_classification] || d[0].value_classification, prev: d[1] ? +d[1].value : null };
  } catch (e) { console.error('[早報] 恐慌貪婪指數：', e.message); return null; }
}

// 確保手上的掃描結果是新的（超過 20 分鐘就先掃一次；正在掃就等它掃完）
async function freshScan() {
  for (let i = 0; i < 60 && scanner.state.scanning; i++) await sleep(2000);
  if (!scanner.state.lastScan || Date.now() - scanner.state.lastScan > 20 * 60e3) await scanner.scanOnce();
}

// 整理早報要用的資料（純數字，AI 也只看這份）
async function collect() {
  await freshScan();
  const s = scanner.state;
  const [tickers, fng] = await Promise.all([bingx.getTickers().catch(() => []), fearGreed()]);
  const tk = new Map(tickers.map(t => [t.symbol.replace(/-USDT$/, ''), t]));
  const res = new Map(s.results.map(r => [r.sym, r]));
  const coin = sym => {
    const t = tk.get(sym), r = res.get(sym);
    return { sym, price: t ? t.last : r ? r.last : null, chg24h: t ? t.change : null, h4: r ? r.dir : 0, daily: r && r.dailyDir != null ? r.dailyDir : 0, funding: s.ctx.funding[sym] != null ? +(s.ctx.funding[sym] * 100).toFixed(4) : null };
  };
  const majors = ['BTC', 'ETH'].map(coin);

  // 掃描範圍內（成交額前段班）的漲跌與資金費率
  const universe = Object.keys(s.market).filter(x => tk.has(x));
  const byChg = universe.map(x => ({ sym: x, chg: tk.get(x).change })).filter(x => isFinite(x.chg)).sort((a, b) => b.chg - a.chg);
  const fund = universe.map(x => ({ sym: x, f: s.ctx.funding[x] })).filter(x => x.f != null && isFinite(x.f)).map(x => ({ sym: x.sym, funding: +(x.f * 100).toFixed(4) }));
  const th = (s.rules.fundingMax == null ? 0.05 : s.rules.fundingMax);   // 跟策略參數同一個擁擠門檻（%）
  const crowdedLong = fund.filter(x => th > 0 && x.funding >= th).sort((a, b) => b.funding - a.funding).slice(0, 3);
  const crowdedShort = fund.filter(x => th > 0 && x.funding <= -th).sort((a, b) => a.funding - b.funding).slice(0, 3);

  // SMC：可進場的訊號 + 最接近成立的觀察名單
  const triggers = s.results.filter(r => r.status === 'trigger').slice(0, 5)
    .map(r => ({ sym: r.sym, dir: r.dir, entry: r.entry, stop: r.stop, target: r.target, rr: +r.rr.toFixed(2), grade: r.quality ? r.quality.grade : null, distPct: +r.dist.toFixed(2) }));
  const missingZh = { htf: 'H4 趨勢', ob: '順勢 OB', engulf: '1H 吞沒', rr: 'RR', fib: '斐波便宜區', ema: 'EMA50', fvg: 'FVG', sweep: '掃流動性', daily: '日線同向' };
  const watch = s.results.filter(r => r.status === 'watch' && r.entry != null)
    .sort((a, b) => b.met / b.need.length - a.met / a.need.length || Math.abs(a.dist) - Math.abs(b.dist)).slice(0, 5)
    .map(r => ({ sym: r.sym, dir: r.dir, met: r.met, need: r.need.length, missing: r.need.filter(k => !r.st[k]).map(k => missingZh[k] || k), zoneLo: r.entryOB ? r.entryOB.lo : null, zoneHi: r.entryOB ? r.entryOB.hi : null, blocked: r.blocked || null }));

  // 過去 24 小時結束的訊號
  const since = Date.now() - 24 * 3600e3;
  const closed = tracker.state.signals.filter(x => ['win', 'loss', 'be'].includes(x.status) && x.closedAt >= since);
  const yesterday = { n: closed.length, win: closed.filter(x => x.status === 'win').length, loss: closed.filter(x => x.status === 'loss').length, be: closed.filter(x => x.status === 'be').length, R: +closed.reduce((a, x) => a + (x.R || 0), 0).toFixed(2) };

  // 接下來 24 小時的重要數據 + 今明兩天的財報
  const now = Date.now();
  const events = calendar.state.events.filter(e => calendar.watched(e) && e.ts >= now && e.ts <= now + 24 * 3600e3)
    .map(e => ({ time: twTime(e.ts), day: twDay(e.ts), name: `${e.countryZh} ${e.titleZh}`, forecast: e.forecast || '', previous: e.previous || '' }));
  const days = [nyDate(now), nyDate(now, 1)];
  const earn = earnings.state.events.filter(e => e.alert && days.includes(e.date)).map(e => ({ sym: e.sym, date: e.date, session: e.session }));

  return { date: twParts().date, fng, majors, gainers: byChg.slice(0, 3), losers: byChg.slice(-3).reverse(), crowdedLong, crowdedShort,
    btcH4: s.ctx.btcDir, triggers, watch, yesterday, events, earnings: earn, locked: journal.locked(), lossStreak: journal.lossStreak(), scanned: universe.length };
}

function format(d) {
  const L = [];
  L.push('<b>📊 大盤</b>');
  for (const c of d.majors) L.push(`${c.sym} ${fp(c.price)}（${pct(c.chg24h)}）｜日線 ${dirZh(c.daily)}・H4 ${dirZh(c.h4)}｜費率 ${c.funding == null ? '—' : `${c.funding.toFixed(4)}%`}`);
  if (d.fng) L.push(`恐慌貪婪 ${d.fng.value}（${d.fng.label}）${d.fng.prev != null ? `，昨天 ${d.fng.prev}` : ''}`);
  if (d.gainers.length) L.push(`領漲 ${d.gainers.map(x => `${x.sym} ${pct(x.chg, 1)}`).join('、')}`);
  if (d.losers.length) L.push(`領跌 ${d.losers.map(x => `${x.sym} ${pct(x.chg, 1)}`).join('、')}`);
  if (d.crowdedLong.length || d.crowdedShort.length) {
    const parts = [];
    if (d.crowdedLong.length) parts.push(`多方擁擠 ${d.crowdedLong.map(x => `${x.sym} ${x.funding.toFixed(3)}%`).join('、')}`);
    if (d.crowdedShort.length) parts.push(`空方擁擠 ${d.crowdedShort.map(x => `${x.sym} ${x.funding.toFixed(3)}%`).join('、')}`);
    L.push(`資金費率：${parts.join('｜')}`);
  }

  L.push('', `<b>🎯 SMC 訊號</b>（掃 ${d.scanned} 幣，BTC H4 ${dirZh(d.btcH4)}）`);
  if (d.triggers.length) for (const t of d.triggers) L.push(`${t.dir > 0 ? '🟢' : '🔴'} ${t.sym} ${side(t.dir)}${t.grade ? `（${t.grade}）` : ''}：進 ${fp(t.entry)}・損 ${fp(t.stop)}・標 ${fp(t.target)}・RR ${t.rr}`);
  else L.push('目前沒有條件到齊的訊號。沒訊號就不進場。');
  if (d.watch.length) {
    L.push('觀察中：');
    for (const w of d.watch) L.push(`・${w.sym} ${side(w.dir)} ${w.met}/${w.need}，還缺 ${w.missing.join('、') || '—'}${w.zoneLo != null ? `｜OB ${fp(w.zoneLo)}–${fp(w.zoneHi)}` : ''}${w.blocked ? '（逆 BTC）' : ''}`);
  }
  if (d.yesterday.n) L.push(`過去 24h 結算 ${d.yesterday.n} 筆：✅${d.yesterday.win} ❌${d.yesterday.loss} 🛡${d.yesterday.be}，合計 ${d.yesterday.R > 0 ? '+' : ''}${d.yesterday.R}R`);

  if (d.events.length || d.earnings.length) {
    L.push('', '<b>📅 接下來 24 小時</b>');
    for (const e of d.events) L.push(`${e.day} ${e.time} ${esc(e.name)}${e.forecast ? `（預測 ${esc(e.forecast)}，前值 ${esc(e.previous || '—')}）` : ''}`);
    for (const e of d.earnings) L.push(`${e.sym} 財報（美東 ${e.date} ${e.session}）`);
    L.push('數據前後別追單，持倉先確認止損有掛。');
  }
  L.push('', d.locked ? `🔒 已連虧 ${d.lossStreak} 筆，今天進場提醒鎖住，休息。` : '下單前：這是訊號不是情緒？止損放結構位，槓桿由止損距離推出來。');
  return L;
}

const AI_TASK = '根據 <data> 寫「今日重點」，3 到 4 點，每點一句：大盤方向與情緒、最值得注意的訊號或觀察名單（沒有就說今天以等待為主）、今天的數據風險。不要重複列出所有數字。';

async function build() {
  const d = await collect();
  const lines = format(d);
  const a = await ai.write(AI_TASK, d, { maxTokens: 400 });
  if (a && a.text) lines.splice(0, 0, '<b>🧠 今日重點</b>', esc(a.text), '');
  const title = `🌅 聚寶盆早報 ${twDay(Date.now())}`;
  return { title, lines, data: d, ai: a ? (a.text ? 'ok' : 'rejected') : 'off' };
}

// 推播：寫進提醒中心並推 Discord / Telegram
async function send() {
  const b = await build();
  await tracker.emit('brief', b.title, b.lines);
  console.log(`[早報] 已推送（AI：${b.ai}）`);
  return b;
}

// 時間到了就推（同一天只推一次；服務睡過頭，3 小時內醒來還是會補推）
const parseHM = v => { const m = String(v || '').match(/^(\d{1,2}):(\d{2})$/); return m ? +m[1] * 60 + +m[2] : null; };
let sentDate = null, running = false;
async function check() {
  const at = parseHM(cfg.BRIEF_TIME);
  if (at == null || running) return;
  const { date, mins } = twParts();
  if (mins < at || mins > at + 180) return;
  if (sentDate == null) sentDate = await store.load('briefSent', '');
  if (sentDate === date) return;
  running = true;
  sentDate = date; await store.save('briefSent', date);   // 先標記，避免重複推
  try { await send(); } catch (e) { console.error('[早報] 失敗：', e.message); }
  finally { running = false; }
}

function start() {
  if (parseHM(cfg.BRIEF_TIME) == null) { console.log('早報：關閉'); return; }
  console.log(`早報：每天台灣時間 ${cfg.BRIEF_TIME}｜AI 摘要 ${ai.enabled() ? '開' : '關（沒設 ANTHROPIC_API_KEY）'}`);
  setInterval(() => check().catch(() => {}), 60e3);
  check().catch(() => {});
}

module.exports = { collect, format, build, send, check, start, twParts };
