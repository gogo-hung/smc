// 策略①：4H 趨勢＋MACD 金叉＋爆量，市價進場，ATR 止損＋移動止損，1H 結構延續（同向 BOS）且已賺 0.5R 就保本
// 回測（OKX 56 幣，2025/1 ～ 2026/10，同時最多 5 筆）：兩年都賺，卡瑪約 1.8
(function (root) {
  const SM = typeof require === 'function' ? require('./smc') : (typeof SMC !== 'undefined' ? SMC : root.SMC);   // 瀏覽器：smc.js 宣告的全域 SMC
  const P = { emaFast: 50, emaSlow: 200, volMult: 1.5, slAtr: 2, trailAtr: 3, beMinR: 0.5, maxOpen: 5 };

  const emaArr = (v, n) => { const o = Array(v.length).fill(null), k = 2 / (n + 1); let e = null, s = 0; for (let i = 0; i < v.length; i++) { if (i < n - 1) { s += v[i]; continue; } if (e === null) e = (s + v[i]) / n; else e = v[i] * k + e * (1 - k); o[i] = e; } return o; };
  const smaArr = (v, n) => { const o = Array(v.length).fill(null); let s = 0; for (let i = 0; i < v.length; i++) { s += v[i]; if (i >= n) s -= v[i - n]; if (i >= n - 1) o[i] = s / n; } return o; };
  function atrArr(b, n = 14) { const o = Array(b.length).fill(null); let a = null; for (let i = 1; i < b.length; i++) { const tr = Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c)); a = a === null ? tr : (a * (n - 1) + tr) / n; if (i >= n) o[i] = a; } return o; }

  // 4H 指標＋每根的訊號（只用到那根為止的資料）
  function indicators(h4) {
    const c = h4.map(b => b.c), v = h4.map(b => b.v);
    const e50 = emaArr(c, P.emaFast), e200 = emaArr(c, P.emaSlow), atr = atrArr(h4, 14), vma = smaArr(v, 20);
    const m12 = emaArr(c, 12), m26 = emaArr(c, 26), macd = c.map((_, i) => m12[i] != null && m26[i] != null ? m12[i] - m26[i] : null);
    const sg = emaArr(macd.map(x => x ?? 0), 9), hist = macd.map((x, i) => x == null ? null : x - sg[i]);
    return { c, v, e50, e200, atr, vma, hist };
  }
  function signalAt(I, i) {
    if (i < 1 || I.atr[i] == null || I.hist[i - 1] == null || I.e200[i] == null || I.vma[i] == null) return 0;
    const up = I.e50[i] > I.e200[i] && I.c[i] > I.e50[i], dn = I.e50[i] < I.e200[i] && I.c[i] < I.e50[i], vol = I.v[i] > P.volMult * I.vma[i];
    if (up && I.hist[i - 1] <= 0 && I.hist[i] > 0 && vol) return 1;
    if (dn && I.hist[i - 1] >= 0 && I.hist[i] < 0 && vol) return -1;
    return 0;
  }
  function signals(h4) { const I = indicators(h4), out = []; for (let i = 210; i < h4.length; i++) { const d = signalAt(I, i); if (d) out.push({ i, t: h4[i].t, dir: d, atr: I.atr[i] }); } return out; }

  // 看板用：目前 4H 狀態＋最後一根 4H 是不是訊號
  function analyze(sym, h4) {
    const n = h4.length, H4 = 4 * 3600e3;
    if (n < 210) return { sym, model: 'trend', state: 'nodata' };
    const I = indicators(h4), i = n - 1, d = signalAt(I, i);
    const trend = I.e50[i] > I.e200[i] && I.c[i] > I.e50[i] ? 1 : I.e50[i] < I.e200[i] && I.c[i] < I.e50[i] ? -1 : 0;
    return { sym, model: 'trend', trend, sig: d, sigT: h4[i].t + H4, atr: I.atr[i], close: I.c[i], hist: I.hist[i], volRatio: I.vma[i] ? I.v[i] / I.vma[i] : null,
      e50: I.e50[i], e200: I.e200[i], state: d ? 'trigger' : trend && (trend > 0 ? I.hist[i] <= 0 : I.hist[i] >= 0) ? 'watch' : 'idle' };
  }

  // 持倉中逐根 1H 更新：回傳 {exit, bePx, trail} 等事件；s = {dir, entry, stop0, atr, stop, ext, be, filledAt}
  function step(s, b, bosEv, H1 = 3600e3) {
    const up = s.dir > 0, risk = Math.abs(s.entry - s.stop0), ev = [];
    if (up ? b.l <= s.stop : b.h >= s.stop) { ev.push({ k: 'exit', px: s.stop, R: (s.stop - s.entry) * s.dir / risk }); return ev; }
    s.ext = up ? Math.max(s.ext, b.h) : Math.min(s.ext, b.l);
    const fav = (s.ext - s.entry) * s.dir / risk;
    if (!s.be && bosEv && bosEv.dir === s.dir && bosEv.fromT >= s.filledAt && fav >= P.beMinR && (up ? b.c > s.entry : b.c < s.entry) && (up ? s.entry > s.stop : s.entry < s.stop)) { s.stop = s.entry; s.be = true; ev.push({ k: 'be', px: s.entry }); }
    const ns = s.ext - s.dir * s.atr * P.trailAtr;
    if (up ? ns > s.stop : ns < s.stop) { s.stop = ns; ev.push({ k: 'trail', px: ns }); }
    return ev;
  }
  // 1H 同向 BOS（打破進場後才形成的擺動點）：回傳 Map(收盤時間 → {dir, fromT})
  function bosMap(h1) {
    const S = SM.structure(h1, { swingLen: 3, breakBy: 'close', obInvalid: 'close' }), m = new Map();
    for (const e of S.events) if (e.type === 'BOS') m.set(h1[e.idx].t, { dir: e.dir, fromT: h1[e.from].t });
    return m;
  }
  const api = { P, signals, analyze, step, bosMap, indicators, signalAt };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.TREND = api;
})(typeof window !== 'undefined' ? window : globalThis);
