// 會員：申請 → 審核 → 登入 → 門禁 → 停用（不需要網路）
Object.assign(process.env, { ADMIN_TOKEN: 'pw', PORT: '0', TELEGRAM_BOT_TOKEN: '', DISCORD_WEBHOOK_URL: '', UPSTASH_REDIS_REST_URL: '' });
delete process.env.MEMBER_GATE;
const fs = require('fs'), path = require('path'), assert = require('assert'), http = require('http');
const dataDir = path.join(__dirname, '..', 'data');
for (const f of ['members.json', 'sessions.json']) { const p = path.join(dataDir, f); if (fs.existsSync(p)) fs.unlinkSync(p); }
const server = require('../src/server');
(async () => {
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = (method, p, body, { cookie, token } = {}) => new Promise((resolve, reject) => {
    const r = http.request(base + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...(token ? { 'x-admin-token': token } : {}) } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, json: () => JSON.parse(d) }));
    });
    r.on('error', reject); if (body) r.write(JSON.stringify(body)); r.end();
  });
  const ck = r => (r.headers['set-cookie'] || [''])[0].split(';')[0];

  // 沒登入：首頁導去登入頁、API 擋掉、叫醒用的 API 照常
  let r = await req('GET', '/'); assert.strictEqual(r.status, 302); assert.strictEqual(r.headers.location, '/login');
  assert.strictEqual((await req('GET', '/login')).status, 200);
  assert.strictEqual((await req('GET', '/api/market')).status, 401, '沒登入要擋 API');
  assert.strictEqual((await req('GET', '/api/ping')).status, 200, 'ping 不用登入');
  assert.strictEqual((await req('GET', '/api/health')).status, 200);

  // 申請
  assert.strictEqual((await req('POST', '/api/member/apply', { uid: 'abc', password: '123456' })).status, 400, 'UID 要數字');
  assert.strictEqual((await req('POST', '/api/member/apply', { uid: '12345678', password: '12' })).status, 400, '密碼太短');
  assert.strictEqual((await req('POST', '/api/member/apply', { uid: '12345678', name: 'tester', password: 'secret1' })).status, 200);
  assert.strictEqual((await req('POST', '/api/member/apply', { uid: '12345678', password: 'secret1' })).status, 409, '重複申請');

  // 審核前不能登入
  r = await req('POST', '/api/member/login', { uid: '12345678', password: 'secret1' }); assert.strictEqual(r.status, 403); assert.strictEqual(r.json().status, 'pending');
  assert.strictEqual((await req('POST', '/api/member/login', { uid: '12345678', password: 'wrong!' })).status, 401);

  // 後台
  assert.strictEqual((await req('GET', '/api/admin/members')).status, 401, '後台要密碼');
  r = await req('POST', '/api/member/login', { admin: true, password: 'pw' }); assert.strictEqual(r.status, 200);
  const adminCk = ck(r);
  let list = (await req('GET', '/api/admin/members', null, { cookie: adminCk })).json();
  assert.strictEqual(list[0].status, 'pending'); assert(!('pw' in list[0]), '不能回傳密碼');
  await req('POST', '/api/admin/members', { uid: '12345678', action: 'approve' }, { token: 'pw' });

  // 通過後登入
  r = await req('POST', '/api/member/login', { uid: '12345678', password: 'secret1' }); assert.strictEqual(r.status, 200);
  const c = ck(r); assert(/^jbp=[a-f0-9]{48}$/.test(c));
  assert(/HttpOnly/.test(r.headers['set-cookie'][0]));
  assert.strictEqual((await req('GET', '/', null, { cookie: c })).status, 200);
  assert.strictEqual((await req('GET', '/api/member/me', null, { cookie: c })).json().uid, '12345678');
  assert.notStrictEqual((await req('GET', '/api/sentiment', null, { cookie: c })).status, 401);
  assert.strictEqual((await req('GET', '/api/admin/members', null, { cookie: c })).status, 401, '一般會員不能進後台');

  // 停用 → 立刻登出
  await req('POST', '/api/admin/members', { uid: '12345678', action: 'revoke', note: '測試' }, { cookie: adminCk });
  assert.strictEqual((await req('GET', '/api/member/me', null, { cookie: c })).status, 401);
  r = await req('POST', '/api/member/login', { uid: '12345678', password: 'secret1' }); assert.strictEqual(r.status, 403); assert(/測試/.test(r.json().error));
  // 未通過可以重新申請
  assert.strictEqual((await req('POST', '/api/member/apply', { uid: '12345678', password: 'newpass' })).status, 200);

  // 登出
  await req('POST', '/api/member/logout', null, { cookie: adminCk });
  assert.strictEqual((await req('GET', '/api/admin/members', null, { cookie: adminCk })).status, 401);

  // 連續猜密碼會被擋
  for (let i = 0; i < 8; i++) await req('POST', '/api/member/login', { uid: '99999999', password: 'x' });
  assert.strictEqual((await req('POST', '/api/member/login', { uid: '99999999', password: 'x' })).status, 429);

  console.log('會員測試通過');
  server.close(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
