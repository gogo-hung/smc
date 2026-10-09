// 手動跑一次掃描並列出結果：npm run scan
const scanner = require('./scanner');

(async () => {
  await scanner.init();
  const sum = await scanner.scanOnce();
  if (sum.error) process.exit(1);
  const fp = p => (p == null ? '—' : +p.toPrecision(6));
  const rows = scanner.state.results.filter(r => r.status !== 'idle').map(r => ({
    幣種: r.sym, 方向: r.dir > 0 ? '多' : '空', 狀態: r.status === 'trigger' ? '觸發' : '觀察',
    條件: `${r.met}/${r.need.length}`, 現價: fp(r.last), 進場: fp(r.entry), 止損: fp(r.stop), RR: r.rr ? +r.rr.toFixed(2) : '—',
  }));
  console.table(rows);
  if (scanner.state.errors.length) console.log('抓取失敗：\n' + scanner.state.errors.slice(0, 10).join('\n'));
})();
