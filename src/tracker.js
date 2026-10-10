// 提醒中心 + 訊號成績單
// - 新訊號可進場、價格接近進場區、數據公布前 → 進提醒紀錄（鈴鐺）並推 Telegram
// - 每個觸發過的訊號都追蹤後續：先碰進場 → 再看先打止損還是目標
const store = require('./store');
const notify = require('./notify');
const journal = require('./journal');
const cfg = require('./config');

const Q = 60 * 60e3; // 1H
const DEFAULT_SETTINGS = { signal: true, near: true, nearPct: 0.3, calendar: true, result: true };
const state = { signals: [], feed: [], settings: { ...DEFAULT_SETTINGS } };

async function init() {
  state.signals = await store.load('signals', []);
  state.feed = await store.load('feed', []);
  state.settings = { ...DEFAULT_SETTINGS, ...(await store.load('alertSettings', {})) };
}

async function setSettings(s) {
  const n = {};
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (s[k] === undefined) continue;
    n[k] = typeof DEFAULT_SETTINGS[k] === 'boolean' ? !!s[k] : Math.min(5, Math.max(0.05, +s[k] || DEFAULT_SETTINGS[k]));
  }
  state.settings = { ...state.settings, ...n };
  await store.save('alertSettings', state.settings);
  return state.settings;
}

const fp = p => p == null || !isFinite(p) ? '—' : p >= 1000 ? p.toFixed(1) : p >= 10 ? p.toFixed(2) : p >= 1 ? p.toFixed(3) : p >= 0.01 ? p.toFixed(4) : p.toPrecision(4);
const side = d => (d > 0 ? '做多' : '做空');
const BONUS_ZH = { fib: '斐波便宜區', ema: 'EMA 順勢', fvg: 'OB 帶 FVG', sweep: '掃流動性', daily: '日線同向' };

// 寫進提醒紀錄；push=true 且該類型開啟時才推 Telegram。風控鎖住時，進場類提醒只記錄不推
async function emit(type, title, lines, extra = {}) {
  const muted = (type === 'signal' || type === 'near') && journal.locked();
  const item = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, t: Date.now(), type, title, body: lines.join('\n'), muted, ...extra };
  state.feed.unshift(item);
  state.feed = state.feed.slice(0, 300);
  await store.save('feed', state.feed);
  const on = { signal: state.settings.signal, near: state.settings.near, calendar: state.settings.calendar, earnings: state.settings.calendar, result: state.settings.result }[type];
  if (on && !muted) await notify.send([`<b>${title}</b>`, ...lines, cfg.PUBLIC_URL].filter(Boolean).join('\n'));
  return item;
}

async function emitNear(s, last, touched) {
  s.near = true;
  const dist = Math.abs(last - s.entry) / s.entry * 100;
  await emit('near', `🔔 ${s.sym}/USDT ${side(s.dir)}：${touched ? '已碰到進場位' : `距進場 ${dist.toFixed(2)}%`}`, [
    `進場 ${fp(s.entry)}　止損 ${fp(s.stop)}　目標 ${fp(s.target)}　RR ${s.rr.toFixed(2)}`,
    `現價 ${fp(last)}`, '確認 1H 結構還在，止損先掛好再進。',
  ], { sym: s.sym });
}

const keyOf = r => `${r.sym}:${r.dir}:${r.ltf[r.sigIdx].t}`; // 同一根吞沒 K 只算一次

async function onScan(results, market) {
  let changed = false;
  const lastClose = r => r.ltf[r.ltf.length - 1].t + Q;

  // 1. 新觸發 → 記錄 + 提醒
  for (const r of results) {
    if (r.status !== 'trigger') continue;
    const k = keyOf(r);
    if (state.signals.some(s => s.k === k)) continue;
    const sig = { k, sym: r.sym, dir: r.dir, entry: r.entry, stop: r.stop, target: r.target, rr: r.rr, be: r.be ?? null, score: r.score, scoreMax: r.scoreMax, bonus: (r.bonus || []).filter(b => r.st[b]), q: r.quality ? r.quality.score : null, grade: r.quality ? r.quality.grade : null, createdAt: lastClose(r), status: 'pending', near: false, flags: (r.flags || []).map(f => f.t) };
    state.signals.push(sig); changed = true;
    const fresh = !cfg.ALERT_MAX_AGE_BARS || (r.ltf.length - 1 - r.sigIdx) < cfg.ALERT_MAX_AGE_BARS;
    if (fresh) {
      const dist = (r.last - r.entry) / r.entry * 100;
      const qline = r.quality ? `品質 ${r.quality.score} 分（${r.quality.grade}）｜${r.quality.parts.filter(p => p.v >= 0.6).map(p => p.n).join('、') || '各項普通'}` : '';
      await emit('signal', `🎯 ${r.sym}/USDT ${side(r.dir)}：訊號成立${r.quality ? `｜${r.quality.score} 分 ${r.quality.grade}` : ''}`, [
        `進場 ${fp(r.entry)}　止損 ${fp(r.stop)}　目標 ${fp(r.target)}`,
        `RR ${r.rr.toFixed(2)}　現價 ${fp(r.last)}（距進場 ${dist > 0 ? '+' : ''}${dist.toFixed(2)}%）`,
        ...(qline ? [qline] : []),
        `加分 ${r.score}/${r.scoreMax}${sig.bonus.length ? `：${sig.bonus.map(b => BONUS_ZH[b]).join('、')}` : ''}`,
        ...(r.be != null ? [`獲利到 ${fp(r.be)} 時，止損移到開倉價 ${fp(r.entry)}`] : []),
        ...(sig.flags.length ? [`⚠ ${sig.flags.join('；')}`] : []),
        '下單前：這是訊號不是情緒？今天沒連虧兩筆？止損先掛。',
      ], { sym: r.sym });
    }
  }

  // 2. 追蹤每個未結束的訊號
  for (const s of state.signals) {
    if (s.status !== 'pending' && s.status !== 'filled') continue;
    const m = market[s.sym];
    if (!m || !m.ltf || !m.ltf.length) continue;
    const L = s.dir > 0;
    const from = s.checkedT || s.createdAt;
    for (const b of m.ltf) {
      if (b.t < from) continue;
      s.checkedT = b.t + Q;
      if (s.status === 'pending') {
        const hitEntry = L ? b.l <= s.entry : b.h >= s.entry;
        const hitTarget = L ? b.h >= s.target : b.l <= s.target;
        if (hitEntry) { s.status = 'filled'; s.filledAt = b.t; if (!s.near) await emitNear(s, s.entry, true); }
        else if (hitTarget) { s.status = 'missed'; s.closedAt = b.t; break; }
        else if (b.t - s.createdAt > 24 * 3600e3) { s.status = 'expired'; s.closedAt = b.t; break; }
      }
      if (s.status === 'filled') {
        const sl = s.beHit ? s.entry : s.stop;
        const hitStop = L ? b.l <= sl : b.h >= sl;
        const hitTarget = L ? b.h >= s.target : b.l <= s.target;
        if (hitStop) { s.status = s.beHit ? 'be' : 'loss'; s.R = s.beHit ? 0 : -1; s.closedAt = b.t; }   // 同一根同時碰到止損和目標，保守算止損
        else if (hitTarget && b.t > s.filledAt) { s.status = 'win'; s.R = +s.rr.toFixed(2); s.closedAt = b.t; }
        if (s.status === 'win' || s.status === 'loss' || s.status === 'be') {
          const title = { win: `✅ ${s.sym} ${side(s.dir)} 打到目標 +${s.R}R`, loss: `❌ ${s.sym} ${side(s.dir)} 打到止損 -1R`, be: `🛡 ${s.sym} ${side(s.dir)} 保本出場 0R` }[s.status];
          await emit('result', title, [`進場 ${fp(s.entry)}　止損 ${fp(s.stop)}　目標 ${fp(s.target)}`], { sym: s.sym });
          break;
        }
        if (s.be != null && !s.beHit && b.t > s.filledAt && (L ? b.h >= s.be : b.l <= s.be)) {
          s.beHit = true; s.beAt = b.t;
          await emit('result', `🛡 ${s.sym} ${side(s.dir)} 已到一半目標：止損移到開倉價`, [`把止損改到 ${fp(s.entry)}（開倉價），目標 ${fp(s.target)} 不變`], { sym: s.sym });
        }
      }
    }
    changed = true;

    // 3. 還沒碰到進場位，但已經很接近 → 提醒一次
    if (!s.near && s.status === 'pending') {
      const last = isFinite(m.price) ? m.price : m.ltf[m.ltf.length - 1].c; // 用即時價，不用等 1H 收盤
      if (Math.abs(last - s.entry) / s.entry * 100 <= state.settings.nearPct) await emitNear(s, last, false);
    }
  }

  if (changed) {
    const open = state.signals.filter(s => s.status === 'pending' || s.status === 'filled');
    const done = state.signals.filter(s => !(s.status === 'pending' || s.status === 'filled')).slice(-5000); // 已結束的訊號保留最近 5000 筆，贏輸都留
    state.signals = [...done, ...open].sort((a, b) => a.createdAt - b.createdAt);
    await store.save('signals', state.signals);
  }
}

// 還在追蹤中的幣（就算掉出成交量排名也要繼續抓）
const openSymbols = () => [...new Set(state.signals.filter(s => s.status === 'pending' || s.status === 'filled').map(s => s.sym))];

function stats(all = false) {
  const done = state.signals.filter(s => s.status === 'win' || s.status === 'loss' || s.status === 'be');
  const wins = done.filter(s => s.status === 'win');
  const sumR = a => +a.reduce((x, s) => x + s.R, 0).toFixed(2);
  const group = (key) => {
    const m = {};
    for (const s of done) { const g = key(s); (m[g] ||= []).push(s); }
    return Object.entries(m).map(([g, a]) => ({ g, n: a.length, winRate: a.filter(s => s.status === 'win').length / a.length, R: sumR(a) })).sort((a, b) => b.n - a.n);
  };
  const count = st => state.signals.filter(s => s.status === st).length;
  return {
    total: state.signals.length, resolved: done.length,
    winRate: done.length ? wins.length / done.length : null,
    avgR: done.length ? +(sumR(done) / done.length).toFixed(2) : null, totalR: sumR(done),
    pending: count('pending'), filled: count('filled'), be: count('be'), missed: count('missed'), expired: count('expired'),
    byDir: group(s => (s.dir > 0 ? '做多' : '做空')), byGrade: group(s => s.grade ? `${s.grade}（${{ S: '70+', A: '55–69', B: '40–54', C: '<40' }[s.grade]} 分）` : '舊訊號（無分數）'), bySym: group(s => s.sym).slice(0, 10),
    recent: (all ? state.signals : state.signals.slice(-60)).slice().reverse(),
  };
}

module.exports = { state, init, onScan, emit, stats, openSymbols, setSettings, DEFAULT_SETTINGS };
