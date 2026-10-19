// AI 解讀（可選）：沒設 ANTHROPIC_API_KEY 就整段略過，其他功能照常
// 重點：AI 只負責「用文字解讀」，所有數字都來自程式算好的資料；
// AI 寫出資料裡沒有的數字（例如把 29 人寫成 48 人）就整段丟掉，不推給你
const cfg = require('./config');

const enabled = () => !!cfg.ANTHROPIC_API_KEY;

// 把一段文字裡的數字都抓出來（去掉千分位、% 不影響比對）
function numbersIn(text) {
  return (String(text).replace(/(\d),(?=\d{3})/g, '$1').match(/-?\d+(?:\.\d+)?/g) || []).map(Number).filter(isFinite);
}

// 檢查 AI 寫的每個數字都能在原始資料裡找到（容許四捨五入：相對誤差 0.6% 或差 0.051 以內）
// 小整數 0–10（「3 個」「第 1 段」）與時框數字（1H、4H、15、50 均線）不檢查
const FREE = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 50, 200, 24]);
function verifyNumbers(text, facts) {
  const pool = numbersIn(JSON.stringify(facts));
  const bad = [];
  for (const n of numbersIn(text)) {
    if (FREE.has(Math.abs(n))) continue;
    const ok = pool.some(p => [p, -p].some(q => Math.abs(q - n) <= 0.051 || (q !== 0 && Math.abs((q - n) / q) <= 0.006)));
    if (!ok) bad.push(n);
  }
  return { ok: bad.length === 0, bad };
}

const SYSTEM = [
  '你是一位嚴格的加密貨幣交易風控助理，用繁體中文（台灣用語）回答。',
  '使用者只做 SMC 順勢交易：日線與 H4 定趨勢，1H 找 OB / FVG，EMA50 與斐波便宜區是必要條件；止損放結構位，槓桿由止損距離推出來；獲利到目標一半時移保本；連虧兩筆就休息。',
  '規則：',
  '1. 只能使用 <data> 裡的數字，不可以自己估算、換算或編造任何數字；不確定就不要寫數字。',
  '2. 條件沒到齊就明說「還不能進場」，並指出還缺哪個條件；不要硬給進場建議。',
  '3. 不要用「可能漲也可能跌」這種兩邊都押的說法；要嘛給出條件式結論（等到 X 才進），要嘛說觀望。',
  '4. 簡短、條列，不要開場白、不要免責聲明。',
].join('\n');

async function write(task, facts, { maxTokens = 600 } = {}) {
  if (!enabled()) return null;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 25e3);
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': cfg.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: cfg.AI_MODEL, max_tokens: maxTokens, system: SYSTEM,
        messages: [{ role: 'user', content: `<data>\n${JSON.stringify(facts)}\n</data>\n\n${task}` }],
      }),
    });
    clearTimeout(timer);
    if (!res.ok) { console.error('[AI] 失敗：', res.status, (await res.text()).slice(0, 300)); return null; }
    const j = await res.json();
    const text = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
    if (!text) return null;
    const v = verifyNumbers(text, facts);
    if (!v.ok) { console.warn('[AI] 出現資料裡沒有的數字，丟掉這段：', v.bad.join(', ')); return { text: null, rejected: v.bad }; }
    return { text };
  } catch (e) {
    console.error('[AI] 失敗：', e.message);
    return null;
  }
}

module.exports = { enabled, write, verifyNumbers, numbersIn };
