// 儲存：有設 Upstash Redis 就永久保存（Render 重啟不會不見），沒設就存在 data/ 資料夾
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const R_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const R_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const useRedis = !!(R_URL && R_TOKEN);
const last = {}; // 上次寫入的內容，沒變就不寫（省指令數）

async function redis(cmd) {
  const res = await fetch(R_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${R_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}
const file = k => path.join(cfg.DATA_DIR, `${k}.json`);

async function load(key, def) {
  try {
    const txt = useRedis ? await redis(['GET', `smc:${key}`]) : (fs.existsSync(file(key)) ? fs.readFileSync(file(key), 'utf8') : null);
    if (txt == null) return def;
    last[key] = txt;
    return JSON.parse(txt);
  } catch (e) {
    console.error(`[儲存] 讀取 ${key} 失敗：${e.message}`);
    return def;
  }
}

async function save(key, val) {
  const txt = JSON.stringify(val);
  if (last[key] === txt) return;
  last[key] = txt;
  try {
    if (useRedis) await redis(['SET', `smc:${key}`, txt]);
    else { fs.mkdirSync(cfg.DATA_DIR, { recursive: true }); fs.writeFileSync(file(key), txt); }
  } catch (e) {
    delete last[key];
    console.error(`[儲存] 寫入 ${key} 失敗：${e.message}`);
  }
}

module.exports = { load, save, persistent: useRedis, kind: useRedis ? 'Upstash Redis（永久保存）' : '伺服器暫存（重新部署會清空）' };
