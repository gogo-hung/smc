// /deep 深度分析：對單一幣種跑同一套 SMC 判斷，把結構、條件、計畫攤開來
// 數字全部由程式算；有設 ANTHROPIC_API_KEY 才加 AI 解讀，而且 AI 寫錯數字就整段不用
const cfg = require('./config');
const bingx = require('./bingx');
const SMC = require('./smc');
const scanner = require('./scanner');
const journal = require('./journal');
const ai = require('./ai');

const fp = p => p == null || !isFinite(p) ? '—' : p >= 1000 ? p.toFixed(1) : p >= 10 ? p.toFixed(2) : p >= 1 ? p.toFixed(3) : p >= 0.01 ? p.toFixed(4) : p.toPrecision(4);
const r4 = p => p == null || !isFinite(p) ? null : +(+p).toPrecision(6);
const pct = (v, d = 2) => v == null || !isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(d)}%`;
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const dirZh = d => (d > 0 ? '多頭' : d < 0 ? '空頭' : '沒有明確結構');
const side = d => (d > 0 ? '做多' : '做空');
const COND_ZH = { htf: 'H4 趨勢', ob: '1H 順勢 OB（未失效）', engulf: '1H 吞沒 / 型態', rr: 'RR 達標', fib: '斐波便宜區', ema: 'EMA50 順勢', fvg: 'OB 帶 FVG', sweep: '掃流動性', daily: '日線同向' };
const FVG_ZH = { entry: '已在 FVG 反應', broken: '已被收盤穿過', testing: '測試中', waiting: '還沒回測' };

// 代號 → BingX 合約：先找加密幣，再找美股 / 商品（BingX 的 NC 開頭商品，例：TSLA → NCSKTSLA2USD-USDT）
async function resolve(raw) {
  const sym = String(raw || '').toUpperCase().replace(/[^A-Z0-9.]/g, '').replace(/USDT$/, '');
  if (!sym) throw Object.assign(new Error('請輸入代號，例如 /deep SOL'), { code: 400 });
  const list = await bingx.getContracts();
  const hit = [`${sym}-USDT`, `NCSK${sym}2USD-USDT`].find(s => list.includes(s)) || list.find(s => new RegExp(`^NC[A-Z]{2}${sym.replace('.', '\\.')}2USD-USDT$`).test(s));
  if (!hit) throw Object.assign(new Error(`BingX 找不到 ${sym} 的永續合約`), { code: 404 });
  return { sym, symbol: hit, tradfi: hit.startsWith('NC') };
}

// 掃描器 20 分鐘內抓過就直接用，沒有就自己抓
async function bars(sym, symbol) {
  const m = scanner.state.market[sym];
  if (m && m.symbol === symbol && scanner.state.lastScan && Date.now() - scanner.state.lastScan < 20 * 60e3 && m.ltf && m.ltf.length >= 50) return { ltf: m.ltf, htf: m.htf };
  const [ltf, htf] = await Promise.all([bingx.getKlines(symbol, cfg.LTF_INTERVAL, cfg.LTF_LIMIT), bingx.getKlines(symbol, '4h', cfg.HTF_LIMIT)]);
  if (ltf.length < 50) throw Object.assign(new Error(`${sym} 上市時間太短，K 線不足`), { code: 422 });
  return { ltf, htf };
}

async function collect(raw) {
  const { sym, symbol, tradfi } = await resolve(raw);
  const { ltf, htf } = await bars(sym, symbol);
  const rules = scanner.state.rules;
  const r = SMC.analyze(sym, ltf, rules, htf);
  let funding = scanner.state.ctx.funding;
  if (!funding || funding[sym] == null) funding = await bingx.getFunding().catch(() => ({}));
  SMC.applyContext(r, { btcDir: tradfi ? 0 : scanner.state.ctx.btcDir, funding }, rules); // 美股、商品不跟 BTC 比方向
  const t = (await bingx.getTickers().catch(() => [])).find(x => x.symbol === symbol);
  const n = ltf.length, last = t ? t.last : r.last;
  const lastEv = ev => { const e = ev && ev.length ? ev[ev.length - 1] : null; return e ? { type: e.type, dir: e.dir, level: r4(e.level) } : null; };
  const ema = r.emaLine[n - 1];

  const d = {
    sym, symbol, tradfi, price: r4(last), chg24h: t ? +t.change.toFixed(2) : null,
    funding: r.funding != null ? +(r.funding * 100).toFixed(4) : null,
    trend: { daily: r.dailyDir ?? 0, h4: r.dir, h4Last: lastEv(r.H.events), h1: r.L.trend, h1Last: lastEv(r.L.events), btcH4: scanner.state.ctx.btcDir },
    h4Range: r.range ? { lo: r4(r.range.lo), hi: r4(r.range.hi), posPct: +((last - r.range.lo) / ((r.range.hi - r.range.lo) || 1) * 100).toFixed(1) } : null,
    ema50: ema != null ? { value: r4(ema), above: last > ema } : null,
    fib: r.fib ? { retrPct: +(r.retr * 100).toFixed(1), needPct: +(rules.fibMin * 100).toFixed(1), legLo: r4(r.fib.lo), legHi: r4(r.fib.hi) } : null,
    ob: r.entryOB ? { lo: r4(r.entryOB.lo), hi: r4(r.entryOB.hi), zone: r.zone } : null,
    fvg: r.fvgZone ? { lo: r4(r.fvgZone.lo), hi: r4(r.fvgZone.hi), state: r.fvgState || null } : null,
    need: r.need.map(k => ({ k, name: COND_ZH[k], ok: !!r.st[k] })),
    bonus: r.bonus.map(k => ({ k, name: COND_ZH[k], ok: !!r.st[k] })),
    status: r.status, blocked: r.blocked || null, flags: (r.flags || []).map(f => f.t),
    pattern: r.engulf ? r.engulf.kind : null,
    quality: r.quality ? { score: r.quality.score, grade: r.quality.grade } : null,
    minRR: rules.minRR, locked: journal.locked(),
  };
  if (r.entry != null && r.dir) {
    const stopPct = Math.abs(r.entry - r.stop) / r.entry * 100;
    d.plan = { dir: r.dir, entry: r4(r.entry), stop: r4(r.stop), target: r4(r.target), rr: +r.rr.toFixed(2), be: r4(r.be), stopPct: +stopPct.toFixed(2),
      riskPct: cfg.RISK_PCT, sizeX: +(cfg.RISK_PCT / stopPct).toFixed(2), stopBasis: r.stopBasis || null };
  }
  return d;
}

function verdict(d) {
  if (!d.trend.h4) return ['H4 沒有明確結構 → 觀望，不找進場。'];
  if (!d.ob) return [`H4 ${dirZh(d.trend.h4)}，但 1H 這段推動裡沒有未失效、在便宜區的順勢 OB → 觀望。`];
  const miss = d.need.filter(c => !c.ok).map(c => c.name);
  if (d.status === 'trigger') return [`<b>${d.trend.h4 > 0 ? '🟢' : '🔴'} 條件到齊：${side(d.trend.h4)}</b>`];
  const L = [`<b>⏳ 還不能進場</b>${miss.length ? `：缺 ${miss.join('、')}` : ''}`];
  if (d.blocked) L.push(`⚠ ${d.blocked}`);
  else if (miss.length === 0) L.push('必要條件都到了，但被加分 / 品質門檻擋下。');
  if (miss.includes(COND_ZH.engulf)) L.push(`等價格回到 ${d.fvg && d.fvg.state !== 'broken' ? `FVG ${fp(d.fvg.lo)}–${fp(d.fvg.hi)} 或 ` : ''}OB ${fp(d.ob.lo)}–${fp(d.ob.hi)}，出現 1H 順勢吞沒${d.need.some(c => c.k === 'ema') ? '並收在 EMA50 對的一側' : ''}再說。`);
  return L;
}

function format(d) {
  const L = [];
  L.push(`現價 ${fp(d.price)}（24h ${pct(d.chg24h)}）｜資金費率 ${d.funding == null ? '—' : `${d.funding.toFixed(4)}%`}`);
  L.push('', '<b>📐 結構</b>');
  const ev = e => (e ? `，最後 ${e.type} @ ${fp(e.level)}` : '');
  L.push(`日線 ${dirZh(d.trend.daily)}｜H4 ${dirZh(d.trend.h4)}${ev(d.trend.h4Last)}`);
  L.push(`1H ${dirZh(d.trend.h1)}${ev(d.trend.h1Last)}${d.sym !== 'BTC' && !d.tradfi ? `｜BTC H4 ${dirZh(d.trend.btcH4)}` : ''}`);
  if (d.h4Range) L.push(`H4 區間 ${fp(d.h4Range.lo)}–${fp(d.h4Range.hi)}，現價在 ${d.h4Range.posPct}%（${d.h4Range.posPct < 50 ? '折價區' : '溢價區'}）`);
  if (d.ema50) L.push(`1H EMA50 ${fp(d.ema50.value)}，現價在${d.ema50.above ? '上方' : '下方'}`);
  if (d.fib) L.push(`斐波：這段推動 ${fp(d.fib.legLo)}–${fp(d.fib.legHi)}，目前回撤 ${d.fib.retrPct}%（門檻 ${d.fib.needPct}%）`);
  if (d.ob) L.push(`1H OB ${fp(d.ob.lo)}–${fp(d.ob.hi)}${d.fvg ? `｜FVG ${fp(d.fvg.lo)}–${fp(d.fvg.hi)}（${FVG_ZH[d.fvg.state] || '—'}）` : ''}`);

  L.push('', `<b>✅ 條件 ${d.need.filter(c => c.ok).length}/${d.need.length}</b>`);
  L.push(d.need.map(c => `${c.ok ? '✅' : '❌'} ${c.name}`).join('\n'));
  if (d.bonus.length) L.push(`加分：${d.bonus.map(c => `${c.ok ? '✅' : '▫️'} ${c.name}`).join('　')}`);
  if (d.quality && d.status === 'trigger') L.push(`品質 ${d.quality.score} 分（${d.quality.grade}）`);

  L.push('', '<b>🎯 結論</b>', ...verdict(d));
  if (d.plan) {
    const p = d.plan;
    L.push(`${d.status === 'trigger' ? '計畫' : '預設計畫（條件到齊才成立）'}：${side(p.dir)}`);
    L.push(`進場 ${fp(p.entry)}　止損 ${fp(p.stop)}（${p.stopBasis || '結構位'}，距離 ${p.stopPct}%）`);
    L.push(`目標 ${fp(p.target)}　RR ${p.rr}${p.rr < d.minRR ? `（未達 ${d.minRR}）` : ''}`);
    if (p.be != null) L.push(`獲利到 ${fp(p.be)} 移保本`);
    L.push(`倉位：每筆虧本金 ${p.riskPct}% → 倉位價值 = 本金 × ${p.sizeX} 倍（槓桿由止損距離推出來）`);
  }
  if (d.flags.length) L.push(`⚠ ${d.flags.join('；')}`);
  if (d.tradfi) L.push('⚠ 美股 / 商品 CFD 有開盤跳空，可能跳過止損，財報前後降槓桿。');
  if (d.locked) L.push('🔒 今天已連虧兩筆，風控鎖住中：只看不進。');
  return L;
}

const AI_TASK = '根據 <data> 寫「AI 解讀」，最多 4 點：1) 多週期結構是否一致 2) 目前價格在 SMC 流程的哪一步 3) 進場前還要看到什麼（條件到齊就說明止損為什麼放在那裡）4) 最大的風險。';

async function run(raw) {
  const d = await collect(raw);
  const lines = format(d);
  const a = await ai.write(AI_TASK, d, { maxTokens: 500 });
  if (a && a.text) lines.push('', '<b>🤖 AI 解讀</b>', esc(a.text));
  else if (a && a.rejected) lines.push('', '（AI 解讀出現資料裡沒有的數字，已略過）');
  lines.push('', '只提醒不下單。下單前：這是訊號不是情緒？止損先掛。');
  return { title: `🔍 ${d.sym}${d.tradfi ? '' : '/USDT'} 深度分析`, lines, data: d };
}

module.exports = { run, collect, format, resolve };
