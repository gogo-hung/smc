// 策略①（趨勢單）離線測試：造一段 4H 上升趨勢＋回檔＋爆量金叉，確認會建單、推送、保本、移動止損、出場
const fs = require('fs'), path = require('path'), assert = require('assert');
process.env.DISCORD_WEBHOOK_URL = 'https://discord.test/webhook';
const dataDir = path.join(__dirname, '..', 'data');
const pushed = [];
const bodies = [];
global.fetch = async (url, opt) => { const e = JSON.parse(opt.body).embeds[0]; pushed.push(e.title); bodies.push(e); return { ok: true, status: 200, text: async () => '' }; };
const TREND = require('../src/trend');
const tracker = require('../src/tracker');
const H4 = 4 * 3600e3, H1 = 3600e3;

(async () => {
  for (const f of fs.existsSync(dataDir) ? fs.readdirSync(dataDir) : []) if (f.endsWith('.json')) fs.unlinkSync(path.join(dataDir, f));
  await tracker.init();
  // 4H：250 根穩定上漲 → 回檔 → 盤整 → 最後一根爆量大漲（MACD 柱翻正）
  const now = Date.now(), lastClose = Math.floor(now / H4) * H4, n = 284, h4 = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    const t = lastClose - (n - i) * H4, o = p;
    p *= i < 250 ? 1.004 : i < 258 ? 0.996 : i < 283 ? 1.0 : 1.03;
    h4.push({ t, o, h: Math.max(o, p) * 1.002, l: Math.min(o, p) * 0.998, c: p, v: i === n - 1 ? 5000 : 1000 });
  }
  const a = TREND.analyze('TST', h4);
  assert.strictEqual(a.sig, 1, '最後一根 4H 應該是做多訊號');
  const entry = h4[n - 1].c, risk = 2 * a.atr;
  // 1H：先漲到 +1R 附近（做出擺動高點→回檔→突破＝同向 BOS），再一路漲讓移動止損上移，最後跌回去出場
  const path1 = [];
  let q = entry;
  const seq = [...Array(6).fill(0.0015), ...Array(4).fill(-0.001), ...Array(10).fill(0.003), ...Array(30).fill(0.004), ...Array(25).fill(-0.006)];
  for (const r of seq) path1.push(q *= 1 + r);
  const h1 = []; let prev = entry;
  // 進場前留 40 根 1H 讓結構有東西算
  for (let i = 40; i > 0; i--) { const t = a.sigT - i * H1, c = entry * (1 - i * 0.0005); h1.push({ t, o: c, h: c * 1.001, l: c * 0.999, c, v: 1 }); }
  path1.forEach((c, i) => { const o = (prev + c) / 2; h1.push({ t: a.sigT + i * H1, o, h: Math.max(o, c) * 1.0005, l: Math.min(o, c) * 0.9995, c, v: 1 }); prev = c; });
  const realNow = Date.now; Date.now = () => a.sigT + 60e3;   // 4H 收盤後 1 分鐘掃到
  await tracker.onScan([], { TST: { sym: 'TST', htf: h4, ltf: h1.filter(b => b.t + H1 <= Date.now()), price: entry } }, { trend: true });
  const s = tracker.state.signals.find(x => x.model === 'trend');
  assert(s && s.status === 'filled', '應該建立一筆趨勢單');
  assert(Math.abs(s.stop - (entry - risk)) < 1e-9, '初始止損＝進場 − 2ATR');
  assert(pushed.some(t => t === 'TSTUSDT　多'), '應該推送新訊號');
  // 時間往後，所有 1H 收盤
  Date.now = () => h1[h1.length - 1].t + 2 * H1;
  await tracker.onScan([], { TST: { sym: 'TST', htf: h4, ltf: h1, price: h1[h1.length - 1].c } }, { trend: true });
  Date.now = realNow;
  assert(s.status !== 'filled', `應該已經出場（目前 ${s.status}）`);
  assert(s.R > 0, `移動止損出場應該是賺的（R=${s.R}）`);
  assert(s.be, '中途應該觸發保本');
  assert(pushed.some(t => t.includes('止損移到開倉價')), '應該推送保本');
  assert(pushed.some(t => t.includes('到達 TP1')), '應該推送 TP1');
  assert(pushed.some(t => t.includes('移動止損')), '應該推送移動止損');
  console.log(`趨勢單：+${s.R}R 出場；推送 ${pushed.length} 則`);
  for (const e of bodies.filter((e, i) => i < 3 || i >= bodies.length - 2)) console.log(`---- [#${e.color.toString(16)}]\n**${e.title}**\n${e.description}`);
  // 同時最多 5 筆
  const st = tracker.stats(); assert(st.byModel.some(g => g.g.includes('趨勢')), 'stats 要有依策略分組');
  console.log('趨勢單測試通過');
})().catch(e => { console.error(e); process.exit(1); });
