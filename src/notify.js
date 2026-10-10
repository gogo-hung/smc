// 推播：Discord（Webhook）/ Telegram，兩個都沒設定時只印在終端機
const cfg = require('./config');

const fp = p => p == null || !isFinite(p) ? '—'
  : p >= 1000 ? p.toFixed(1) : p >= 10 ? p.toFixed(2) : p >= 1 ? p.toFixed(3) : p >= 0.01 ? p.toFixed(4) : p.toPrecision(4);

function formatSignal(r) {
  const side = r.dir > 0 ? '🟢 做多' : '🔴 做空';
  const lines = [
    `<b>${r.sym}/USDT ${side}</b>`,
    `進場 ${fp(r.entry)}　止損 ${fp(r.stop)}　目標 ${fp(r.target)}`,
    `RR ${r.rr.toFixed(2)}　現價 ${fp(r.last)}（距進場 ${r.dist > 0 ? '+' : ''}${r.dist.toFixed(2)}%）`,
    r.entryOB ? `1H OB ${fp(r.entryOB.lo)}–${fp(r.entryOB.hi)}｜斐波回撤 ${(r.retr * 100).toFixed(0)}%` : '',
    '',
    '下單前：這是訊號不是情緒？今天沒連虧兩筆？止損先掛。',
  ];
  if (cfg.PUBLIC_URL) lines.push(cfg.PUBLIC_URL);
  return lines.join('\n');
}

const channels = () => ({ discord: !!cfg.DISCORD_WEBHOOK_URL, telegram: !!(cfg.TELEGRAM_BOT_TOKEN && cfg.TELEGRAM_CHAT_ID) });

// Discord：第一行當標題，其餘當內容；依內容上色（多 / 目標 = 綠，空 / 止損 = 紅，保本 = 灰，其他 = 金）
async function sendDiscord(text) {
  const plain = text.replace(/<b>(.*?)<\/b>/g, '**$1**').replace(/<\/?[^>]+>/g, '');
  const [first, ...rest] = plain.split('\n');
  const title = first.replace(/\*\*/g, '').slice(0, 250);
  const color = /❌|做空|止損/.test(title) ? 0xd9534f : /🛡/.test(title) ? 0x8a8f98 : /✅|做多/.test(title) ? 0x1f9d6b : 0xb7791f;
  const res = await fetch(cfg.DISCORD_WEBHOOK_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'SMC 掃幣台', embeds: [{ title, description: rest.join('\n').trim().slice(0, 4000) || undefined, color }] }),
  });
  if (!res.ok) console.error('Discord 推播失敗：', res.status, await res.text());
  return res.ok;
}

async function sendTelegram(text) {
  const res = await fetch(`https://api.telegram.org/bot${cfg.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: cfg.TELEGRAM_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  if (!res.ok) console.error('Telegram 推播失敗：', res.status, await res.text());
  return res.ok;
}

async function send(text) {
  const ch = channels();
  if (!ch.discord && !ch.telegram) { console.log('[提醒]\n' + text.replace(/<\/?b>/g, '')); return false; }
  const out = await Promise.all([ch.discord ? sendDiscord(text).catch(e => (console.error('Discord：', e.message), false)) : null,
    ch.telegram ? sendTelegram(text).catch(e => (console.error('Telegram：', e.message), false)) : null].filter(x => x));
  return out.some(Boolean);
}

module.exports = { send, formatSignal, channels };
