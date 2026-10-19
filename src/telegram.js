// Telegram 機器人指令：/deep 代碼、/brief、/help
// 部署後用 webhook（Telegram 打 PUBLIC_URL/api/telegram）；本機開發可設 TELEGRAM_POLLING=1 改用輪詢
// 只回應 TELEGRAM_CHAT_ID（和 TELEGRAM_ALLOWED_CHATS）裡的聊天室
const crypto = require('crypto');
const cfg = require('./config');

const token = () => cfg.TELEGRAM_BOT_TOKEN;
const enabled = () => !!token();
const secret = () => cfg.TELEGRAM_WEBHOOK_SECRET || crypto.createHash('sha256').update(`smc:${token()}`).digest('hex').slice(0, 32);
const allowed = id => [cfg.TELEGRAM_CHAT_ID, ...cfg.TELEGRAM_ALLOWED_CHATS].filter(Boolean).map(String).includes(String(id));

async function api(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token()}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const j = await res.json().catch(() => ({}));
  if (!j.ok) throw new Error(`${method}：${j.description || res.status}`);
  return j.result;
}

// Telegram 單則上限 4096 字，超過就照行切開
async function reply(chatId, text, replyTo) {
  const parts = []; let cur = '';
  for (const line of text.split('\n')) { if ((cur + '\n' + line).length > 3900) { parts.push(cur); cur = line; } else cur = cur ? `${cur}\n${line}` : line; }
  if (cur) parts.push(cur);
  for (const [i, p] of parts.entries()) {
    await api('sendMessage', { chat_id: chatId, text: p, parse_mode: 'HTML', disable_web_page_preview: true, ...(i === 0 && replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}) });
  }
}

const HELP = [
  '<b>聚寶盆指令</b>',
  '/deep 代碼 — 深度分析，例：/deep SOL、/deep BTC、/deep TSLA',
  '/brief — 現在就產生一份早報（只回給你，不會推到群組）',
  '',
  `每天台灣時間 ${cfg.BRIEF_TIME || '（未設定）'} 自動推早報；SMC 訊號成立時也會推播。`,
].join('\n');

const busy = new Set();
async function handle(update) {
  const msg = update && (update.message || update.channel_post);
  if (!msg || !msg.text) return;
  const chatId = msg.chat.id;
  const m = msg.text.trim().match(/^\/([a-z_]+)(?:@\w+)?(?:\s+(.*))?$/i);
  if (!m) return;
  const cmd = m[1].toLowerCase(), arg = (m[2] || '').trim();
  if (!allowed(chatId)) {
    if (cmd === 'start' || cmd === 'help') await reply(chatId, `這是私人機器人。\n你的 chat id 是 <code>${chatId}</code>，要使用的話把它填進 Render 的 TELEGRAM_CHAT_ID（或 TELEGRAM_ALLOWED_CHATS）。`);
    return;
  }
  if (cmd === 'start' || cmd === 'help') return reply(chatId, HELP);
  if (cmd !== 'deep' && cmd !== 'brief') return reply(chatId, `看不懂 /${cmd}\n\n${HELP}`);
  if (cmd === 'deep' && !arg) return reply(chatId, '要分析哪個？例：/deep SOL');
  if (busy.has(chatId)) return reply(chatId, '上一個指令還在跑，等它好再試。');
  busy.add(chatId);
  try {
    api('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    if (cmd === 'deep') {
      const out = await require('./deep').run(arg.split(/\s+/)[0]);
      await reply(chatId, [`<b>${out.title}</b>`, ...out.lines].join('\n'), msg.message_id);
    } else {
      const b = await require('./brief').build();
      await reply(chatId, [`<b>${b.title}</b>`, ...b.lines].join('\n'), msg.message_id);
    }
  } catch (e) {
    console.error(`[Telegram] /${cmd} 失敗：`, e.message);
    await reply(chatId, `❌ ${e.code && e.code < 500 ? e.message : `分析失敗：${e.message}`}`).catch(() => {});
  } finally { busy.delete(chatId); }
}

// 輪詢（本機開發用）
async function poll() {
  await api('deleteWebhook', {});
  let offset = 0;
  console.log('Telegram：輪詢模式');
  for (;;) {
    try {
      const ups = await api('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] });
      for (const u of ups) { offset = u.update_id + 1; handle(u).catch(e => console.error('[Telegram]', e.message)); }
    } catch (e) { console.error('[Telegram] 輪詢：', e.message); await new Promise(r => setTimeout(r, 5000)); }
  }
}

async function start() {
  if (!enabled()) return;
  try {
    await api('setMyCommands', { commands: [
      { command: 'deep', description: '深度分析，例：/deep SOL' },
      { command: 'brief', description: '現在產生一份早報' },
      { command: 'help', description: '指令說明' },
    ] });
    if (cfg.TELEGRAM_POLLING) { poll(); return; }
    if (!cfg.PUBLIC_URL) { console.log('Telegram 指令：沒設 PUBLIC_URL，無法收指令（本機請設 TELEGRAM_POLLING=1）'); return; }
    const url = `${cfg.PUBLIC_URL.replace(/\/$/, '')}/api/telegram`;
    await api('setWebhook', { url, secret_token: secret(), allowed_updates: ['message'] });
    console.log(`Telegram 指令：webhook → ${url}`);
  } catch (e) { console.error('[Telegram] 設定失敗：', e.message); }
}

module.exports = { start, handle, secret, enabled, allowed };
