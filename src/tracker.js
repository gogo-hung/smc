// 提醒中心 + 訊號成績單
// - 新訊號可進場、價格接近進場區、數據公布前 → 進提醒紀錄（鈴鐺）並推 Discord / Telegram
// - 每個觸發過的訊號都追蹤後續：先碰進場 → 再看先打止損還是目標
const store = require('./store');
const notify = require('./notify');
const journal = require('./journal');
const cfg = require('./config');
const TREND = require('./trend');

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

// 寫進提醒紀錄；push=true 且該類型開啟時才推 Discord / Telegram。風控鎖住時，進場類提醒只記錄不推
async function emit(type, title, lines, extra = {}) {
  const muted = (type === 'signal' || type === 'near') && journal.locked();
  const item = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, t: Date.now(), type, title, body: lines.join('\n'), muted, ...extra };
  state.feed.unshift(item);
  state.feed = state.feed.slice(0, 300);
  await store.save('feed', state.feed);
  const on = { signal: state.settings.signal, near: state.settings.near, calendar: state.settings.calendar, earnings: state.settings.calendar, result: state.settings.result }[type];
  if (on && !muted && !extra.quiet) await notify.send([`<b>${title}</b>`, ...lines, extra.noLink ? '' : cfg.PUBLIC_URL].filter(Boolean).join('\n'));
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
const stepOf = bars => bars && bars.length > 1 ? bars[1].t - bars[0].t : Q;

async function onScan(results, market, opt = {}) {
  let changed = false;
  if (opt.trend !== false) changed = (await onTrend(market)) || changed;
  const lastClose = r => r.ltf[r.ltf.length - 1].t + Q;

  // 1. 新觸發 → 記錄 + 提醒
  for (const r of results) {
    if (r.status !== 'trigger' || !opt.smcPush) continue;   // SMC 改成輔助：預設只顯示、不建單不推送
    const k = keyOf(r);
    if (state.signals.some(s => s.k === k)) continue;
    if (state.signals.some(s => s.sym === r.sym && (s.status === 'pending' || s.status === 'filled'))) continue; // 同一個幣一次只做一單
    const bf = r.model === 'bf' || r.model === 'mtf';   // 掛限價單的模型
    const mtf = r.model === 'mtf';
    const sig = { k, sym: r.sym, dir: r.dir, entry: r.entry, stop: r.stop, target: r.target, rr: r.rr, be: r.be ?? null, p1: r.p1 ?? null, p1R: r.p1R ?? null, score: r.score, scoreMax: r.scoreMax, bonus: (r.bonus || []).filter(b => r.st[b]), q: r.quality ? r.quality.score : null, zone: r.zone || 'ob', grade: r.quality ? r.quality.grade : null, createdAt: bf ? r.ltf[r.sigIdx].t + stepOf(r.ltf) : lastClose(r), waitMs: r.waitMs || 24 * 3600e3, model: r.model || 'ob', status: 'pending', near: false, flags: (r.flags || []).map(f => f.t) };
    state.signals.push(sig); changed = true;
    const fresh = !cfg.ALERT_MAX_AGE_BARS || (r.ltf.length - 1 - r.sigIdx) < cfg.ALERT_MAX_AGE_BARS || (bf && r.filledIdx < 0); // BF 是掛單：還沒成交就還有效
    if (fresh) {
      const dist = (r.last - r.entry) / r.entry * 100;
      const qline = r.quality ? `品質 ${r.quality.score} 分（${r.quality.grade}）｜${r.quality.parts.filter(p => p.v >= 0.6).map(p => p.n).join('、') || '各項普通'}` : '';
      await emit('signal', `🎯 ${r.sym}/USDT ${side(r.dir)}：${bf ? '掛單訊號' : '訊號成立'}${r.quality ? `｜${r.quality.score} 分 ${r.quality.grade}` : ''}`, [
        bf ? `限價掛單 ${fp(r.entry)}　止損 ${fp(r.stop)}　目標 ${fp(r.target)}` : `進場 ${fp(r.entry)}　止損 ${fp(r.stop)}　目標 ${fp(r.target)}`,
        `RR ${r.rr.toFixed(2)}　現價 ${fp(r.last)}（距進場 ${dist > 0 ? '+' : ''}${dist.toFixed(2)}%）`,
        mtf ? `4H ${r.poi ? r.poi.kind : 'POI'}（${r.poi ? `${fp(r.poi.lo)}–${fp(r.poi.hi)}` : '—'}）回踩後 15M CHoCH 換方向；在 15M 推動的斐波 0.715 掛單，止損前低、止盈前高；${r.filledIdx >= 0 ? '⚠ 已經成交過，現價追進要小心' : `${Math.round((r.waitMs || 0) / 3600e3)} 小時內沒成交、或收盤跌破前低就取消`}`
        : bf ? `1H BOS 後回踩 FVG（${fp(r.fvgZone.lo)}–${fp(r.fvgZone.hi)}）掛中間，止損在 OB 外；${r.filledIdx >= 0 ? '⚠ 已經成交過，現價追進要小心' : '24 小時內沒成交就取消'}`
        : r.zone === 'fvg' ? `進場區：FVG 反應（${fp(r.fvgZone.lo)}–${fp(r.fvgZone.hi)}），止損仍在 OB 外側` : `進場區：1H OB（${fp(r.entryOB.lo)}–${fp(r.entryOB.hi)}）`,
        ...(qline ? [qline] : []),
        ...(r.scoreMax ? [`加分 ${r.score}/${r.scoreMax}${sig.bonus.length ? `：${sig.bonus.map(b => BONUS_ZH[b]).join('、')}` : ''}`] : []),
        ...(r.be != null ? [`獲利到 ${fp(r.be)} 時，止損移到開倉價 ${fp(r.entry)}`] : []),
        ...(r.p1 != null ? [`到 ${fp(r.p1)}（${r.p1R}R）先平一半，剩下一半止損移到開倉價`] : []),
        ...(sig.flags.length ? [`⚠ ${sig.flags.join('；')}`] : []),
        '下單前：這是訊號不是情緒？今天沒連虧兩筆？止損先掛。',
      ], { sym: r.sym });
    }
  }

  // 1b. MTF 掛單：成交前斐波跟著新高更新 → 改掛單價；收盤跌破前低 → 取消
  for (const s of state.signals) {
    if (s.status !== 'pending' || s.model !== 'mtf') continue;
    const r = results.find(x => x.model === 'mtf' && x.sigIdx != null && keyOf(x) === s.k);
    if (!r) continue;
    if (r.gone === 'invalid') {
      s.status = 'expired'; s.closedAt = Date.now(); changed = true;
      await emit('near', `✖ ${s.sym}/USDT ${side(s.dir)}：取消掛單`, ['價格收盤跌破前低（做空是突破前高），這筆不成立，掛單撤掉。'], { sym: s.sym });
    } else if (r.filledIdx < 0 && Math.abs(r.entry - s.entry) / s.entry > 0.0005) {
      Object.assign(s, { entry: r.entry, stop: r.stop, target: r.target, rr: r.rr, p1: r.p1 ?? null }); changed = true;
      await emit('signal', `🔁 ${s.sym}/USDT ${side(s.dir)}：掛單價更新`, [`推動又創新${s.dir > 0 ? '高' : '低'}，斐波 0.715 跟著移動`, `新掛單 ${fp(s.entry)}　止損 ${fp(s.stop)}　目標 ${fp(s.target)}　RR ${s.rr.toFixed(2)}`], { sym: s.sym });
    }
  }

  // 2. 追蹤每個未結束的訊號
  for (const s of state.signals) {
    if (s.status !== 'pending' && s.status !== 'filled') continue;
    if (s.model === 'trend') continue;   // 趨勢單在 onTrend 處理
    const m = market[s.sym];
    const bars = s.model === 'mtf' ? m && m.m15 : m && m.ltf;
    if (!bars || !bars.length) continue;
    const L = s.dir > 0, step = stepOf(bars);
    const from = s.checkedT || s.createdAt;
    for (const b of bars) {
      if (b.t < from) continue;
      s.checkedT = b.t + step;
      if (s.status === 'pending') {
        const hitEntry = L ? b.l <= s.entry : b.h >= s.entry;
        const hitTarget = L ? b.h >= s.target : b.l <= s.target;
        if (hitEntry) { s.status = 'filled'; s.filledAt = b.t; if (!s.near) await emitNear(s, s.entry, true); }
        else if (hitTarget) { s.status = 'missed'; s.closedAt = b.t; break; }
        else if (b.t - s.createdAt > (s.waitMs || 24 * 3600e3)) { s.status = 'expired'; s.closedAt = b.t; break; }
      }
      if (s.status === 'filled') {
        const sl = s.beHit || s.p1Hit ? s.entry : s.stop;
        const hitStop = L ? b.l <= sl : b.h >= sl;
        const hitTarget = L ? b.h >= s.target : b.l <= s.target;
        const half = s.p1Hit ? 0.5 * s.p1R : 0, size = s.p1Hit ? 0.5 : 1;
        if (hitStop) { s.status = s.p1Hit ? 'tp1' : s.beHit ? 'be' : 'loss'; s.R = s.p1Hit ? +half.toFixed(2) : s.beHit ? 0 : -1; s.closedAt = b.t; }   // 同一根同時碰到止損和目標，保守算止損
        else if (hitTarget && b.t > s.filledAt) { s.status = 'win'; s.R = +(half + size * s.rr).toFixed(2); s.closedAt = b.t; }
        if (s.status === 'win' || s.status === 'loss' || s.status === 'be' || s.status === 'tp1') {
          const title = { win: `✅ ${s.sym} ${side(s.dir)} 打到目標 +${s.R}R`, loss: `❌ ${s.sym} ${side(s.dir)} 打到止損 -1R`, be: `🛡 ${s.sym} ${side(s.dir)} 保本出場 0R`, tp1: `🛡 ${s.sym} ${side(s.dir)} 剩下一半保本出場（前面已平一半）+${s.R}R` }[s.status];
          await emit('result', title, [`進場 ${fp(s.entry)}　止損 ${fp(s.stop)}　目標 ${fp(s.target)}`], { sym: s.sym });
          break;
        }
        if (s.p1 != null && !s.p1Hit && b.t > s.filledAt && (L ? b.h >= s.p1 : b.l <= s.p1)) {
          s.p1Hit = true; s.p1At = b.t;
          await emit('result', `💰 ${s.sym} ${side(s.dir)} 到 ${s.p1R}R：先平一半`, [`在 ${fp(s.p1)} 平掉一半倉位，剩下一半止損改到開倉價 ${fp(s.entry)}，目標 ${fp(s.target)} 不變`], { sym: s.sym });
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


// ==== 策略①（趨勢單）：4H 收盤出訊號 → 市價進場 → 1H 逐根追蹤保本／移動止損／出場 ====
const H4 = 4 * 3600e3;
const isOpen = s => s.status === 'pending' || s.status === 'filled';
const pct = (a, b) => `${(Math.abs(a - b) / b * 100).toFixed(2)}%`;
const head = (sym, dir) => `${sym}USDT　${dir > 0 ? '多' : '空'}`;
const DISCLAIMER = '⚠️以上內容僅供個人投資記錄使用，並不構成任何形式的投資建議或財務建議';
async function onTrend(market) {
  let changed = false;
  const now = Date.now();
  // 1. 新訊號：最後一根已收盤的 4H 出訊號，而且收盤不到 1 小時（服務睡著醒來的舊訊號不追）
  for (const [sym, m] of Object.entries(market)) {
    if (!m.htf || m.htf.length < 210) continue;
    const a = TREND.analyze(sym, m.htf);
    if (!a.sig || now - a.sigT > 3600e3) continue;
    const k = `${sym}:trend:${a.sigT}`;
    if (state.signals.some(s => s.k === k)) continue;
    if (state.signals.some(s => s.sym === sym && s.model === 'trend' && isOpen(s))) continue;   // 同一幣一次一筆
    const entry = isFinite(m.price) ? m.price : a.close, dir = a.sig, stop0 = entry - dir * TREND.P.slAtr * a.atr, risk = Math.abs(entry - stop0);
    const open = state.signals.filter(s => s.model === 'trend' && isOpen(s)).length;
    const sig = { k, sym, dir, model: 'trend', entry, stop: stop0, stop0, atr: a.atr, ext: entry, be: false, target: null, rr: null, createdAt: a.sigT, filledAt: a.sigT, checkedT: a.sigT, status: 'filled', vol: a.volRatio, lastTrailR: -1 };
    if (open >= TREND.P.maxOpen) { Object.assign(sig, { status: 'skipped', closedAt: now }); state.signals.push(sig); changed = true;
      await emit('result', `⏸ ${sym}/USDT ${side(dir)}：訊號成立但已有 ${open} 筆持倉，這筆不做`, [`同時最多 ${TREND.P.maxOpen} 筆，避免同方向一起虧`], { sym, quiet: true }); continue; }
    state.signals.push(sig); changed = true;
    sig.tp1 = entry + dir * risk;   // TP1＝1R：到了推通知，自己決定出場或移保本；成績單照原策略（移動止損）算
    await emit('signal', head(sym, dir), [
      `進場: ${fp(entry)}`,
      `TP1: ${fp(sig.tp1)}（可選擇出場，或把止損移到開倉價）`,
      `TP2: 移動止損出場（持倉後${dir > 0 ? '最高' : '最低'}價${dir > 0 ? '回落' : '反彈'} 3 倍 ATR＝${fp(3 * a.atr)}）`,
      `止損: ${fp(stop0)}`,
      DISCLAIMER,
    ], { sym, noLink: true });
  }
  // 2. 追蹤持倉：用已收盤的 1H
  for (const s of state.signals) {
    if (s.model !== 'trend' || s.status !== 'filled') continue;
    const m = market[s.sym]; if (!m || !m.ltf || !m.ltf.length) continue;
    const bos = TREND.bosMap(m.ltf), risk = Math.abs(s.entry - s.stop0);
    for (const b of m.ltf) {
      if (b.t < s.checkedT) continue;
      s.checkedT = b.t + Q; changed = true;
      const ev = TREND.step(s, b, bos.get(b.t));
      const ex = ev.find(e => e.k === 'exit');
      if (ex) {
        s.status = ex.R > 0.05 ? 'win' : ex.R > -0.05 ? 'be' : 'loss'; s.R = +ex.R.toFixed(2); s.exit = ex.px; s.closedAt = b.t + Q;
        await emit('result', `${head(s.sym, s.dir)}｜${{ win: `TP2 出場 +${s.R}R`, be: '保本出場 0R', loss: `止損出場 ${s.R}R` }[s.status]}`,
          [`進場: ${fp(s.entry)}`, `出場: ${fp(ex.px)}`, DISCLAIMER], { sym: s.sym, noLink: true });
        break;
      }
      if (s.tp1 != null && !s.tp1Hit && b.t >= s.filledAt && (s.dir > 0 ? b.h >= s.tp1 : b.l <= s.tp1)) { s.tp1Hit = true;
        await emit('result', `${head(s.sym, s.dir)}｜到達 TP1`, [`TP1: ${fp(s.tp1)}`, s.be ? `止損已在開倉價 ${fp(s.entry)}，可選擇出場或繼續抱` : `可選擇出場，或把止損移到開倉價 ${fp(s.entry)}`, DISCLAIMER], { sym: s.sym, noLink: true }); }
      if (ev.some(e => e.k === 'be')) await emit('result', `${head(s.sym, s.dir)}｜止損移到開倉價`, [`止損: ${fp(s.entry)}（1H 結構延續，保本）`, DISCLAIMER], { sym: s.sym, noLink: true });
      const tr = ev.find(e => e.k === 'trail');
      if (tr) { const lockR = (s.stop - s.entry) * s.dir / risk;   // 移動止損：第一次過開倉價推一次，之後每多鎖 1R 推一次
        if (lockR >= 0 && lockR - s.lastTrailR >= 1) { s.lastTrailR = lockR; await emit('result', `${head(s.sym, s.dir)}｜移動止損`, [`止損: ${fp(s.stop)}（已鎖住 +${lockR.toFixed(2)}R）`, DISCLAIMER], { sym: s.sym, noLink: true }); } }
    }
  }
  return changed;
}

// 還在追蹤中的幣（就算掉出成交量排名也要繼續抓）
const openSymbols = () => [...new Set(state.signals.filter(s => s.status === 'pending' || s.status === 'filled').map(s => s.sym))];

function stats(all = false) {
  const done = state.signals.filter(s => ['win', 'loss', 'be', 'tp1'].includes(s.status));
  const byModel = (() => { const m = {}; for (const s of done) { const g = s.model === 'trend' ? '趨勢單（策略①）' : 'SMC'; (m[g] ||= []).push(s); } return Object.entries(m).map(([g, a]) => ({ g, n: a.length, winRate: a.filter(s => s.R > 0).length / a.length, R: +a.reduce((x, s) => x + s.R, 0).toFixed(2) })); })();
  const wins = done.filter(s => s.R > 0);
  const sumR = a => +a.reduce((x, s) => x + s.R, 0).toFixed(2);
  const group = (key) => {
    const m = {};
    for (const s of done) { const g = key(s); (m[g] ||= []).push(s); }
    return Object.entries(m).map(([g, a]) => ({ g, n: a.length, winRate: a.filter(s => s.R > 0).length / a.length, R: sumR(a) })).sort((a, b) => b.n - a.n);
  };
  const count = st => state.signals.filter(s => s.status === st).length;
  return {
    total: state.signals.length, resolved: done.length,
    winRate: done.length ? wins.length / done.length : null,
    avgR: done.length ? +(sumR(done) / done.length).toFixed(2) : null, totalR: sumR(done),
    pending: count('pending'), filled: count('filled'), be: count('be'), missed: count('missed'), expired: count('expired'),
    byModel, openTrend: state.signals.filter(s => s.model === 'trend' && s.status === 'filled').length, skipped: count('skipped'),
    byDir: group(s => (s.dir > 0 ? '做多' : '做空')), byZone: group(s => (s.zone === 'fvg' ? 'FVG 進場' : 'OB 進場')), byGrade: group(s => s.grade ? `${s.grade}（${{ S: '70+', A: '55–69', B: '40–54', C: '<40' }[s.grade]} 分）` : '舊訊號（無分數）'), bySym: group(s => s.sym).slice(0, 10),
    recent: (all ? state.signals : state.signals.slice(-60)).slice().reverse(),
  };
}

module.exports = { state, init, onScan, emit, stats, openSymbols, setSettings, DEFAULT_SETTINGS };
