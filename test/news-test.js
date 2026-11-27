// 新聞 RSS 解析／合併測試（不連網）
const assert = require('assert');
const news = require('../src/news');
const rss = `<?xml version="1.0"?><rss><channel><title>x</title>
<item><title><![CDATA[比特幣跌破 6 萬美元 &amp; 市場恐慌]]></title><link>https://example.com/a</link><pubDate>Fri, 27 Nov 2026 12:00:00 +0000</pubDate></item>
<item><title>以太坊 ETF 資金流入</title><link>https://example.com/b</link><pubDate>Fri, 27 Nov 2026 13:00:00 +0000</pubDate></item>
<item><title>沒有連結的不要</title></item></channel></rss>`;
const atom = `<feed><entry><title>Solana 升級完成</title><link href="https://example.com/c"/><updated>2026-11-27T14:00:00Z</updated></entry></feed>`;
const a = news.parse(rss, 'A'), b = news.parse(atom, 'B');
assert.strictEqual(a.length, 2, 'RSS 兩則有效');
assert.strictEqual(a[0].title, '比特幣跌破 6 萬美元 & 市場恐慌', 'CDATA 和 &amp; 要解開');
assert.strictEqual(b.length, 1); assert.strictEqual(b[0].link, 'https://example.com/c', 'Atom 的 link href');
(async () => {
  const feeds = { 'https://www.blocktempo.com/feed/': rss, 'https://abmedia.io/feed': atom, 'https://blockcast.it/feed/': rss };
  global.fetch = async (u) => feeds[u] ? { ok: true, text: async () => feeds[u] } : { ok: false, status: 404 };
  const s = await news.refresh(true);
  assert.strictEqual(s.items.length, 3, `重複標題要合併（${s.items.length}）`);
  assert.strictEqual(s.items[0].title, 'Solana 升級完成', '依時間新到舊');
  assert.strictEqual(s.errors.length, 0);
  console.log('新聞測試通過');
})().catch(e => { console.error(e); process.exit(1); });
