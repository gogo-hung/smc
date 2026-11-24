// 會員：用 BingX UID 申請 → 後台審核通過 → 用 UID＋密碼登入
// 資料存在 store（有 Upstash 就永久保存）：members = { [uid]: {...} }、sessions = { [token]: { uid, exp } }
const crypto = require('crypto');
const store = require('./store');

const DAY = 86400e3, SESSION_DAYS = 30;
const state = { members: {}, sessions: {}, loaded: false };
const tries = new Map();   // 登入失敗次數（每個 IP）

async function init() {
  if (state.loaded) return;
  state.members = await store.load('members', {});
  state.sessions = await store.load('sessions', {});
  const now = Date.now(); for (const [k, v] of Object.entries(state.sessions)) if (v.exp < now) delete state.sessions[k];
  state.loaded = true;
}
const saveM = () => store.save('members', state.members);
const saveS = () => store.save('sessions', state.sessions);
const err = (msg, code = 400, extra) => Object.assign(new Error(msg), { code, extra });

const hash = (pw, salt = crypto.randomBytes(16).toString('hex')) => `${salt}:${crypto.scryptSync(String(pw), salt, 32).toString('hex')}`;
function check(pw, stored) {
  const [salt, h] = String(stored || '').split(':'); if (!salt || !h) return false;
  const a = Buffer.from(h, 'hex'), b = crypto.scryptSync(String(pw), salt, 32);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const cleanUid = v => String(v ?? '').trim();
const pub = m => ({ uid: m.uid, name: m.name, status: m.status, at: m.at, approvedAt: m.approvedAt || null, lastLogin: m.lastLogin || null, note: m.note || '' });

async function apply({ uid, name, password }) {
  await init(); uid = cleanUid(uid); name = String(name || '').trim().slice(0, 40);
  if (!/^\d{6,15}$/.test(uid)) throw err('UID 要是 6～15 位數字（BingX 個人頁面可以複製）');
  if (String(password || '').length < 6) throw err('密碼至少 6 個字');
  const old = state.members[uid];
  if (old && old.status !== 'rejected') throw err(old.status === 'approved' ? '這個 UID 已經開通，請直接登入' : '這個 UID 已經申請過，審核中', 409);
  state.members[uid] = { uid, name, pw: hash(password), status: 'pending', at: Date.now() };
  await saveM();
  return pub(state.members[uid]);
}

function limited(ip) { const t = tries.get(ip); return t && t.n >= 8 && Date.now() - t.at < 15 * 60e3; }
function fail(ip) { const t = tries.get(ip); tries.set(ip, { n: t && Date.now() - t.at < 15 * 60e3 ? t.n + 1 : 1, at: Date.now() }); }

async function login({ uid, password }, ip) {
  await init(); uid = cleanUid(uid);
  if (limited(ip)) throw err('嘗試太多次，請 15 分鐘後再試', 429);
  const m = state.members[uid];
  if (!m || !check(password, m.pw)) { fail(ip); throw err('UID 或密碼錯誤', 401); }
  if (m.status === 'pending') throw err('還在審核中，開通後就能登入', 403, { status: 'pending' });
  if (m.status === 'rejected') throw err(`申請沒有通過${m.note ? `：${m.note}` : ''}，可以重新申請`, 403, { status: 'rejected' });
  tries.delete(ip);
  return newSession(uid);
}
async function newSession(uid) {
  const token = crypto.randomBytes(24).toString('hex');
  state.sessions[token] = { uid, exp: Date.now() + SESSION_DAYS * DAY };
  if (state.members[uid]) { state.members[uid].lastLogin = Date.now(); await saveM(); }
  await saveS();
  return token;
}
async function logout(token) { await init(); if (token && state.sessions[token]) { delete state.sessions[token]; await saveS(); } }

// 從 cookie 找目前登入的人；admin 用管理員密碼登入，uid = 'admin'
function who(token) {
  const s = token && state.sessions[token];
  if (!s || s.exp < Date.now()) return null;
  if (s.uid === 'admin') return { uid: 'admin', name: '管理員', admin: true };
  const m = state.members[s.uid];
  return m && m.status === 'approved' ? { uid: m.uid, name: m.name } : null;
}

async function list() { await init(); return Object.values(state.members).sort((a, b) => (b.status === 'pending') - (a.status === 'pending') || b.at - a.at).map(pub); }
async function act({ uid, action, note }) {
  await init(); uid = cleanUid(uid); const m = state.members[uid];
  if (!m) throw err('找不到這個 UID', 404);
  if (action === 'approve') { m.status = 'approved'; m.approvedAt = Date.now(); delete m.note; }
  else if (action === 'reject' || action === 'revoke') {
    m.status = 'rejected'; m.note = String(note || '').slice(0, 80);
    for (const [k, v] of Object.entries(state.sessions)) if (v.uid === uid) delete state.sessions[k];
    await saveS();
  }
  else if (action === 'delete') { delete state.members[uid]; for (const [k, v] of Object.entries(state.sessions)) if (v.uid === uid) delete state.sessions[k]; await saveS(); }
  else throw err('不認得的動作');
  await saveM();
  return list();
}

module.exports = { init, apply, login, logout, who, list, act, newSession, state };
