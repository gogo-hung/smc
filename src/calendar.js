// 財經日曆：ForexFactory 公開週曆（每小時更新），重要數據公布前推播提醒
const cfg = require('./config');
const store = require('./store');

const FEEDS = [
  'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
  'https://nfs.faireconomy.media/ff_calendar_nextweek.json', // 週末前不一定有，抓不到就略過
];
const IMPACT_RANK = { Holiday: 0, Low: 1, Medium: 2, High: 3 };
const COUNTRY_ZH = { USD: '美國', EUR: '歐元區', GBP: '英國', JPY: '日本', CNY: '中國', AUD: '澳洲', CAD: '加拿大', CHF: '瑞士', NZD: '紐西蘭', All: '全球' };

// 常見數據中文名稱（由上往下比對，先比對到的優先）
const TITLE_ZH = [
  [/^FOMC Meeting Minutes/i, 'FOMC 會議紀要'],
  [/^FOMC Statement/i, 'FOMC 利率聲明'],
  [/^FOMC Press Conference/i, 'FOMC 記者會'],
  [/^Federal Funds Rate/i, '聯準會利率決議'],
  [/^Fed Chair .*Speaks/i, '聯準會主席講話'],
  [/^FOMC Member .*Speaks/i, '聯準會官員講話'],
  [/^FOMC Economic Projections/i, 'FOMC 經濟預測'],
  [/^Core PCE Price Index/i, '核心 PCE 物價指數'],
  [/^PCE Price Index/i, 'PCE 物價指數'],
  [/^Core CPI/i, '核心 CPI'],
  [/^CPI/i, 'CPI 消費者物價指數'],
  [/^Core PPI/i, '核心 PPI'],
  [/^PPI/i, 'PPI 生產者物價指數'],
  [/^ADP Non-Farm Employment Change/i, 'ADP 就業人數'],
  [/^Non-Farm Employment Change/i, '非農就業人數'],
  [/^Unemployment Claims/i, '初領失業金人數'],
  [/^Unemployment Rate/i, '失業率'],
  [/^Average Hourly Earnings/i, '平均時薪'],
  [/^JOLTS Job Openings/i, 'JOLTS 職位空缺'],
  [/^Advance GDP Price Index/i, 'GDP 物價指數初值'],
  [/^Advance GDP/i, 'GDP 初值'],
  [/^Prelim GDP/i, 'GDP 修正值'],
  [/^Final GDP/i, 'GDP 終值'],
  [/GDP/i, 'GDP'],
  [/^Core Retail Sales/i, '核心零售銷售'],
  [/^Retail Sales/i, '零售銷售'],
  [/^ISM Manufacturing PMI/i, 'ISM 製造業 PMI'],
  [/^ISM Services PMI/i, 'ISM 服務業 PMI'],
  [/^Flash Manufacturing PMI/i, '製造業 PMI 初值'],
  [/^Flash Services PMI/i, '服務業 PMI 初值'],
  [/UoM Consumer Sentiment/i, '密大消費者信心'],
  [/UoM Inflation Expectations/i, '密大通膨預期'],
  [/^CB Consumer Confidence/i, '諮商會消費者信心'],
  [/^Core Durable Goods Orders/i, '核心耐久財訂單'],
  [/^Durable Goods Orders/i, '耐久財訂單'],
  [/^Building Permits/i, '營建許可'],
  [/^Housing Starts/i, '新屋開工'],
  [/^New Home Sales/i, '新屋銷售'],
  [/^Existing Home Sales/i, '成屋銷售'],
  [/^Pending Home Sales/i, '成屋簽約銷售'],
  [/^Trade Balance/i, '貿易收支'],
  [/^Crude Oil Inventories/i, 'EIA 原油庫存'],
  [/^Empire State Manufacturing Index/i, '紐約州製造業指數'],
  [/^Philly Fed Manufacturing Index/i, '費城聯儲製造業指數'],
  [/^Main Refinancing Rate/i, '歐洲央行利率決議'],
  [/^ECB Press Conference/i, '歐洲央行記者會'],
  [/^Official Bank Rate/i, '英國央行利率決議'],
  [/^BOJ Policy Rate/i, '日本央行利率決議'],
  [/^Cash Rate/i, '澳洲央行利率決議'],
  [/^Overnight Rate/i, '加拿大央行利率決議'],
  [/^(\d+)-y Bond Auction/i, '$1 年期公債標售'],
  [/^Bank Holiday/i, '銀行假日'],
];
const SUFFIX = [[/\bm\/m\b/i, '月增率'], [/\by\/y\b/i, '年增率'], [/\bq\/q\b/i, '季增率']];

function titleZh(t) {
  const hit = TITLE_ZH.find(([re]) => re.test(t));
  if (!hit) return t;
  let zh = t.replace(hit[0], hit[1]);
  zh = hit[0].source.includes('(') ? zh : hit[1];
  const suf = SUFFIX.find(([re]) => re.test(t));
  return suf && !zh.includes(suf[1]) ? `${zh} ${suf[1]}` : zh;
}

const state = {
  events: [], updatedAt: null, error: null,
  sent: new Set(), emit: null,
};

async function refresh() {
  const all = new Map();
  let ok = 0;
  for (const url of FEEDS) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'smc-scanner/1.0' } });
      if (!res.ok) continue;
      const data = await res.json();
      if (!Array.isArray(data)) continue;
      ok++;
      for (const e of data) {
        const ts = Date.parse(e.date);
        if (!isFinite(ts)) continue;
        const id = `${e.country}|${e.title}|${ts}`;
        all.set(id, {
          id, ts, title: e.title, titleZh: titleZh(e.title || ''), country: e.country, countryZh: COUNTRY_ZH[e.country] || e.country,
          impact: e.impact, rank: IMPACT_RANK[e.impact] ?? 0, forecast: e.forecast || '', previous: e.previous || '',
          actual: e.actual || '',
        });
      }
    } catch (e) { state.error = e.message; }
  }
  if (ok) { state.events = [...all.values()].sort((a, b) => a.ts - b.ts); state.updatedAt = Date.now(); state.error = null; }
  else if (!state.error) state.error = '無法取得財經日曆';
  console.log(`[日曆] ${ok ? `更新 ${state.events.length} 筆` : `失敗：${state.error}`}`);
}

const watched = e => cfg.CAL_COUNTRIES.includes(e.country.toUpperCase()) && e.rank >= (IMPACT_RANK[cfg.CAL_MIN_IMPACT] ?? 3);
const twTime = ts => new Date(ts).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

function format(e, mins) {
  return [
    `${e.title}（${e.impact === 'High' ? '高' : e.impact === 'Medium' ? '中' : '低'}影響）`,
    `台灣時間 ${twTime(e.ts)}`,
    `預測 ${e.forecast || '—'}｜前值 ${e.previous || '—'}`,
    '',
    '數據前後波動大：別在公布前追單，持倉先確認止損有掛。',
  ];
}

// 每分鐘檢查：落在提醒時間內就推一次（30 分、5 分各一次；剛醒來只推最近的那一個）
async function checkAlerts() {
  const leads = [...cfg.CAL_ALERT_LEADS].sort((a, b) => b - a);
  const now = Date.now();
  let changed = false;
  for (const e of state.events) {
    if (!watched(e)) continue;
    const mins = Math.ceil((e.ts - now) / 60e3);
    if (mins <= 0 || mins > leads[0]) continue;
    const idx = leads.findIndex((L, i) => mins <= L && (i === leads.length - 1 || mins > leads[i + 1]));
    const key = `${e.id}|${leads[idx]}`;
    if (state.sent.has(key)) continue;
    leads.slice(0, idx + 1).forEach(L => state.sent.add(`${e.id}|${L}`)); // 較早的提醒一起標記，避免補發
    changed = true;
    const when = mins >= 60 ? `${Math.floor(mins / 60)} 小時 ${mins % 60} 分後` : `${mins} 分鐘後`;
    if (state.emit) await state.emit('calendar', `📅 ${when}公布｜${e.countryZh} ${e.titleZh}`, format(e, mins));
  }
  if (changed) {
    const keep = [...state.sent].slice(-300);
    state.sent = new Set(keep);
    await store.save('calSent', keep);
  }
}

function upcoming() {
  const now = Date.now();
  return state.events.filter(e => e.ts >= now - 12 * 3600e3 && e.ts <= now + 8 * 86400e3).map(e => ({ ...e, alert: watched(e) }));
}

async function start(emit) {
  if (!cfg.CAL_ENABLED) return;
  state.emit = emit;
  state.sent = new Set(await store.load('calSent', []));
  refresh().then(checkAlerts);
  setInterval(refresh, 60 * 60e3);          // 來源有頻率限制，一小時抓一次就夠
  setInterval(() => checkAlerts().catch(() => {}), 60e3);
}

module.exports = { state, refresh, checkAlerts, upcoming, start, titleZh, watched };
