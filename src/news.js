// 加密貨幣新聞（交易座位模式右上角螢幕）：抓幾家中文媒體的 RSS，合併後依時間排序，每 15 分鐘更新一次
// 只取標題、連結、時間、來源，不轉載內文
const SOURCES = [
  { name: '動區動趨', url: 'https://www.blocktempo.com/feed/' },
  { name: '鏈新聞', url: 'https://abmedia.io/feed' },
  { name: '區塊客', url: 'https://blockcast.it/feed/' },
];
const EVERY = 15 * 60e3;
const state = { items: [], at: 0, errors: [] };

const unCdata = s => (s || '').replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '').trim();
const decode = s => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0*39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
const tag = (xml, t) => { const m = xml.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, 'i')); return m ? decode(unCdata(m[1])).replace(/<[^>]+>/g, '').trim() : ''; };

// RSS 2.0（<item>）和 Atom（<entry>）都吃
function parse(xml, source) {
  const out = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  for (const b of blocks) {
    const title = tag(b, 'title');
    let link = tag(b, 'link'); if (!link) { const m = b.match(/<link[^>]*href="([^"]+)"/i); link = m ? m[1] : ''; }
    const when = Date.parse(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date'));
    if (title && /^https?:\/\//.test(link)) out.push({ title: title.slice(0, 140), link, t: isFinite(when) ? when : 0, source });
  }
  return out;
}

async function refresh(force = false) {
  if (!force && Date.now() - state.at < EVERY) return state;
  const errors = [], all = [];
  await Promise.all(SOURCES.map(async s => {
    try {
      const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 12000);
      const r = await fetch(s.url, { signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (jubaopen news reader)', Accept: 'application/rss+xml, application/xml, text/xml' } });
      clearTimeout(to);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      all.push(...parse(await r.text(), s.name));
    } catch (e) { errors.push(`${s.name}：${e.message}`); }
  }));
  if (all.length) {
    const seen = new Set();
    state.items = all.sort((a, b) => b.t - a.t).filter(x => { const k = x.title.replace(/\s/g, ''); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 40);
  }
  state.at = Date.now(); state.errors = errors;
  return state;
}

module.exports = { state, refresh, parse, SOURCES };
