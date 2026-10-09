// Telegram 推播：沒設定 token 時只印在終端機
const cfg = require('./config');

const fp = p => p == null || !isFinite(p) ? '—'
  : p >= 1000 ? p.toFixed(1) : p >= 10 ? p.toFixed(2) : p >= 1 ? p.toFixed(3) : p >= 0.01 ? p.toFixed(4) : p.toPrecision(4);

function formatSignal(r) {
  const side = r.dir > 0 ? '🟢 做多' : '🔴 做空';
  const lines = [
    `<b>${r.sym}/USDT ${side}</b>`,
    `進場 ${fp(r.entry)}　止損 ${fp(r.stop)}　目標 ${fp(r.target)}`,
    `RR ${r.rr.toFixed(2)}　現價 ${fp(r.last)}（距進場 ${r.dist > 0 ? '+' : ''}${r.dist.toFixed(2)}%）`,
    `H4 POI ${fp(r.poi.lo)}–${fp(r.poi.hi)}${r.sweep ? `｜掃 ${fp(r.sweep.level)}` : ''}${r.choch ? `｜${r.choch.type} ${fp(r.choch.level)}` : ''}${r.entryOB && r.entryOB.fvg ? '｜有 FVG' : ''}`,
    '',
    '下單前：這是訊號不是情緒？今天沒連虧兩筆？止損先掛。',
  ];
  if (cfg.PUBLIC_URL) lines.push(cfg.PUBLIC_URL);
  return lines.join('\n');
}

async function send(text) {
  if (!cfg.TELEGRAM_BOT_TOKEN || !cfg.TELEGRAM_CHAT_ID) {
    console.log('[提醒]\n' + text.replace(/<\/?b>/g, ''));
    return false;
  }
  const res = await fetch(`https://api.telegram.org/bot${cfg.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: cfg.TELEGRAM_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  if (!res.ok) console.error('Telegram 推播失敗：', res.status, await res.text());
  return res.ok;
}

module.exports = { send, formatSignal };
