// 訊號策略（策略②，短線）：4H 順勢（EMA50/EMA200）＋ 1H Supertrend(14,3) 翻到順勢方向 → 1H 收盤後市價進場
// 止損：Supertrend 線外（至少 0.5×1H ATR，超過 4×ATR 不做）；止盈 3R；走到止盈 60%（＋1.8R）後止損移到開倉價＋手續費；不限持倉時間
// 全部幣同時最多 5 筆（跟趨勢策略分開算）；同一幣一次一筆
// 回測（research 的 tools/robust2.js，市價 0.05%＋資金費率）：2025/1～2026/11 +76R、回撤 −38R；樣本外 2020～2021 +50R、回撤 −29R
// 指標寫法照抄 research 的 tools/intraday.js（回測用的那份），改規則時兩邊要一致
(function (root) {
  const P = { stN: 14, stK: 3, rr: 3, beAt: 0.6, minAtr: 0.5, maxAtr: 4, maxOpen: 5, feeBuf: 2 * 0.0005 * 1.05 };
  const H1 = 3600e3, H4 = 4 * H1;

  const ema = (a, n) => { const k = 2 / (n + 1), o = new Array(a.length); let e = a[0]; for (let i = 0; i < a.length; i++) { e = i ? a[i] * k + e * (1 - k) : a[0]; o[i] = e; } return o; };
  function atr(b, n = 14) { const o = new Array(b.length).fill(NaN); let a = 0; for (let i = 1; i < b.length; i++) { const tr = Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c)); a = i <= n ? a + tr / n : (a * (n - 1) + tr) / n; if (i >= n) o[i] = a; } return o; }
  function supertrend(b, n = P.stN, k = P.stK) {
    const A = atr(b, n), dir = new Array(b.length).fill(0), line = new Array(b.length).fill(NaN); let up = 0, dn = 0, d = 1;
    for (let i = 0; i < b.length; i++) { if (!isFinite(A[i])) continue; const m = (b[i].h + b[i].l) / 2; let u = m - k * A[i], l = m + k * A[i];
      if (i && isFinite(A[i - 1])) { u = b[i - 1].c > up ? Math.max(u, up) : u; l = b[i - 1].c < dn ? Math.min(l, dn) : l; if (d === 1 && b[i].c < up) d = -1; else if (d === -1 && b[i].c > dn) d = 1; }
      up = u; dn = l; dir[i] = d; line[i] = d === 1 ? u : l; }
    return { dir, line };
  }
  // 4H 趨勢：EMA50>EMA200 且收盤>EMA50 → +1（做空相反），前 200 根不算
  function trend4h(h4) { const c = h4.map(b => b.c), e50 = ema(c, 50), e200 = ema(c, 200); return h4.map((b, i) => i < 200 ? 0 : e50[i] > e200[i] && b.c > e50[i] ? 1 : e50[i] < e200[i] && b.c < e50[i] ? -1 : 0); }

  // 第 i 根 1H 收盤時的訊號（只用到那根為止的資料）；回傳 {dir, risk} 或 null
  function prep(h1, h4) { return { A: atr(h1), st: supertrend(h1), tr: trend4h(h4) }; }
  function trendAt(h4, tr, closeT) { let j = -1; for (let k = h4.length - 1; k >= 0; k--) if (h4[k].t + H4 <= closeT) { j = k; break; } return j < 0 ? 0 : tr[j]; }
  function signalAt(h1, h4, X, i) {
    if (i < 210 || !isFinite(X.A[i])) return null;
    const tdir = trendAt(h4, X.tr, h1[i].t + H1); if (!tdir) return null;
    if (!(X.st.dir[i] === tdir && X.st.dir[i - 1] === -tdir)) return null;
    const risk = Math.max(Math.abs(h1[i].c - X.st.line[i]), P.minAtr * X.A[i]);
    if (risk > P.maxAtr * X.A[i]) return null;
    return { dir: tdir, risk };
  }

  // 看板用：最後一根已收盤 1H 的狀態
  // state：trigger＝剛翻向（這根就是訊號）／watch＝4H 有趨勢、Supertrend 還在反方向（等翻）／running＝已經順勢／idle＝4H 沒趨勢
  function analyze(sym, h1, h4) {
    const n = h1.length;
    if (n < 220 || !h4 || h4.length < 210) return { sym, model: 'signal', state: 'nodata' };
    const X = prep(h1, h4), i = n - 1, tdir = trendAt(h4, X.tr, h1[i].t + H1), sig = signalAt(h1, h4, X, i);
    const stDir = X.st.dir[i], line = X.st.line[i], close = h1[i].c, a = X.A[i];
    let lastFlip = null; for (let k = i; k > i - 300 && k > 210; k--) if (signalAt(h1, h4, X, k)) { lastFlip = h1[k].t + H1; break; }
    return { sym, model: 'signal', trend: tdir, stDir, line, close, atr: a, sig: sig ? sig.dir : 0, risk: sig ? sig.risk : null, sigT: h1[i].t + H1, lastFlip,
      dist: a ? Math.abs(close - line) / a : null,   // 離 Supertrend 線幾個 ATR（watch 時＝離翻向多遠）
      state: sig ? 'trigger' : !tdir ? 'idle' : stDir === tdir ? 'running' : 'watch' };
  }

  // 建單：entry＝進場價（市價），risk＝訊號那根算出來的止損距離
  function open(dir, entry, risk) {
    return { dir, entry, risk, stop: entry - dir * risk, stop0: entry - dir * risk, tp: entry + dir * P.rr * risk, beTrig: entry + dir * P.beAt * P.rr * risk, bePx: entry * (1 + dir * P.feeBuf), be: false };
  }
  // 持倉中逐根 1H 更新（跟回測一樣：先看止損、再看止盈；這根碰到 60% 的話下一根起止損移到保本）
  function step(s, b) {
    const up = s.dir > 0, ev = [];
    if (up ? b.l <= s.stop : b.h >= s.stop) { ev.push({ k: 'exit', why: s.be ? 'be' : 'loss', px: s.stop, R: (s.stop - s.entry) * s.dir / s.risk }); return ev; }
    if (up ? b.h >= s.tp : b.l <= s.tp) { ev.push({ k: 'exit', why: 'win', px: s.tp, R: P.rr }); return ev; }
    if (!s.be && (up ? b.h >= s.beTrig : b.l <= s.beTrig)) { s.be = true; s.stop = s.bePx; ev.push({ k: 'be', px: s.bePx }); }
    return ev;
  }

  const api = { P, supertrend, trend4h, prep, signalAt, analyze, open, step, atr };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.SIGNAL = api;
})(typeof window !== 'undefined' ? window : globalThis);
