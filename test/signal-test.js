// 訊號策略（策略②，短線）離線測試：1H Supertrend 翻到 4H 趨勢方向 → 建單、推送；保本、止盈、止損；同時最多 5 筆
const fs = require('fs'), path = require('path'), assert = require('assert');
process.env.DISCORD_WEBHOOK_URL = 'https://discord.test/webhook';
process.env.WATCHDOG = 'off';
const dataDir = path.join(__dirname, '..', 'data');
const pushed = [], bodies = [];
global.fetch = async (url, opt) => { const e = JSON.parse(opt.body).embeds[0]; pushed.push(e.title); bodies.push(e); return { ok: true, status: 200, text: async () => '' }; };
const SIGNAL = require('../src/signal');
const tracker = require('../src/tracker');
const H1 = 3600e3, H4 = 4 * H1;

// 1H：長期上漲＋週期性回檔（Supertrend 會來回翻）；4H 用 1H 合成，時間軸一致
function build(t0, n) {
  const h1 = []; let prev = 100;
  for (let i = 0; i < n; i++) { const c = 100 * Math.exp(0.0006 * i) * (1 + 0.03 * Math.sin(i / 15)), o = prev; h1.push({ t: t0 + i * H1, o, h: Math.max(o, c) * 1.002, l: Math.min(o, c) * 0.998, c, v: 100 }); prev = c; }
  return h1;
}
const to4h = h1 => { const m = new Map(); for (const b of h1) { const k = Math.floor(b.t / H4) * H4, x = m.get(k); if (!x) m.set(k, { t: k, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }); else { x.h = Math.max(x.h, b.h); x.l = Math.min(x.l, b.l); x.c = b.c; x.v += b.v; } } return [...m.values()]; };

(async () => {
  for (const f of fs.existsSync(dataDir) ? fs.readdirSync(dataDir) : []) if (f.endsWith('.json')) fs.unlinkSync(path.join(dataDir, f));
  await tracker.init();
  const t0 = Math.floor(Date.UTC(2026, 0, 1) / H4) * H4, full = build(t0, 1400);
  // 找第一個訊號（要有足夠的 4H 歷史）
  let cut = -1;
  for (let i = 1000; i < full.length - 100; i++) { const h1 = full.slice(0, i + 1), h4 = to4h(h1).filter(b => b.t + H4 <= h1[i].t + H1); const a = SIGNAL.analyze('A', h1, h4); if (a.state === 'trigger') { cut = i; break; } }
  assert(cut > 0, '應該找得到 Supertrend 翻向的訊號');
  const h1 = full.slice(0, cut + 1), closeT = h1[cut].t + H1, h4 = to4h(h1).filter(b => b.t + H4 <= closeT);
  const a = SIGNAL.analyze('A', h1, h4);
  assert.strictEqual(a.sig, 1, '上漲趨勢中應該是做多訊號');
  assert(a.risk > 0, '要算出止損距離');

  // 1. 建單＋推送；6 個幣同時翻向 → 第 6 個因為同時最多 5 筆而跳過
  const realNow = Date.now; Date.now = () => closeT + 60e3;
  const market = {}; for (const s of ['A', 'B', 'C', 'D', 'E', 'F']) market[s] = { sym: s, ltf: h1, htf: h4, price: h1[cut].c };
  await tracker.onScan([], market, { trend: false, signal: true });
  const open = tracker.state.signals.filter(x => x.model === 'signal' && x.status === 'filled');
  assert.strictEqual(open.length, 5, `同時最多 5 筆（目前 ${open.length}）`);
  assert(tracker.state.signals.some(x => x.model === 'signal' && x.status === 'skipped'), '第 6 筆要跳過');
  const s = open[0], entry = h1[cut].c;
  assert(Math.abs(s.stop - (entry - a.risk)) < 1e-9, '止損＝進場 − 止損距離');
  assert(Math.abs(s.tp - (entry + 3 * a.risk)) < 1e-9, '止盈＝3R');
  assert(Math.abs(s.beTrig - (entry + 1.8 * a.risk)) < 1e-9, '移保本觸發＝1.8R');
  assert(pushed.includes('⚡訊號策略｜AUSDT　多'), '要推送訊號策略');
  // 同一根再掃一次不能重複建單
  await tracker.onScan([], market, { trend: false, signal: true });
  assert.strictEqual(tracker.state.signals.filter(x => x.model === 'signal' && x.sym === 'A').length, 1, '同一個訊號只建一次');

  // 2. 追蹤：先漲到 1.8R（移保本）→ 再漲到 3R（止盈）
  const mk = (t, lo, hi) => ({ t, o: (lo + hi) / 2, h: hi, l: lo, c: (lo + hi) / 2, v: 1 });
  const r = a.risk, path1 = [...h1, mk(closeT, entry - 0.3 * r, entry + 0.5 * r), mk(closeT + H1, entry + 0.2 * r, entry + 1.9 * r), mk(closeT + 2 * H1, entry + 1.0 * r, entry + 3.2 * r)];
  Date.now = () => closeT + 4 * H1;
  await tracker.onScan([], { A: { sym: 'A', ltf: path1, htf: h4, price: entry } }, { trend: false, signal: true });
  assert.strictEqual(s.status, 'win', `應該止盈出場（目前 ${s.status}）`);
  assert.strictEqual(s.R, 3, '止盈＝+3R');
  assert(pushed.some(t => t.includes('訊號策略') && t.includes('止損移到開倉價')), '要推送移保本');
  assert(pushed.some(t => t.includes('止盈出場 +3R')), '要推送止盈出場');

  // 3. 保本後打回開倉價 → 保本出場（約 0R）；沒保本直接打止損 → −1R
  const o1 = SIGNAL.open(1, 100, 2);
  SIGNAL.step(o1, mk(0, 99, 103.7));
  assert(o1.be && o1.stop > 100, '碰到 1.8R 後止損移到開倉價＋手續費');
  const ev = SIGNAL.step(o1, mk(1, 99.5, 101));
  assert(ev[0].k === 'exit' && ev[0].why === 'be' && Math.abs(ev[0].R) < 0.1, '保本出場約 0R');
  const o2 = SIGNAL.open(-1, 100, 2), ev2 = SIGNAL.step(o2, mk(0, 99, 102.5));
  assert(ev2[0].why === 'loss' && Math.abs(ev2[0].R + 1) < 1e-9, '做空打止損 −1R');
  Date.now = realNow;

  const st = tracker.stats(); assert(st.byModel.some(g => g.g === '訊號策略'), 'stats 要有「訊號策略」分組');
  // 4. 實盤表現、公開帳本、每週報告、狀態燈推播
  const pf = tracker.perf(); assert.strictEqual(pf.models.signal.n, 1, '實盤表現算到 1 筆'); assert(pf.models.signal.net < 3 && pf.models.signal.net > 2.5, `扣成本後略少於 +3R（${pf.models.signal.net}）`);
  assert.strictEqual(pf.models.signal.lamp, 'grey', '不到 30 筆是灰燈');
  const lg = tracker.ledger(); assert(lg.length === 1 && lg[0].netR < 3 && lg[0].closedAt, '帳本只有已結束的單');
  const mon = Date.UTC(2026, 10, 30, 1, 30);   // 台灣 11/30（週一）09:30
  const before = pushed.length;
  await tracker.watchdog(mon); assert(pushed.slice(before).some(t => t.includes('每週成績報告')), '週一要推每週報告');
  const n2 = pushed.length; await tracker.watchdog(mon + 3600e3); assert.strictEqual(pushed.length, n2, '同一週只推一次');
  // 狀態燈：造 30 筆虧損讓回撤超過停用線 → 推紅燈
  for (let i = 0; i < 50; i++) tracker.state.signals.push({ k: 'x' + i, sym: 'Z', model: 'signal', dir: 1, entry: 100, risk: 1, stop0: 99, R: -1, status: 'loss', createdAt: mon - 1e8 + i * 1e5, filledAt: mon - 1e8 + i * 1e5, closedAt: mon - 1e8 + i * 1e5 + 3600e3 });
  const n3 = pushed.length; await tracker.watchdog(mon + 7200e3);
  assert(pushed.slice(n3).some(t => t.includes('停用警示') && t.includes('訊號策略')), '回撤超過停用線要推紅燈');
  console.log('實盤表現／帳本／週報／燈號推播 OK');
  for (const e of bodies.filter(e => e.title.includes('訊號策略')).slice(0, 3)) console.log(`---- [#${e.color.toString(16)}]\n**${e.title}**\n${e.description}`);
  console.log('訊號策略測試通過');
})().catch(e => { console.error(e); process.exit(1); });
