# 聚寶盆（crypto-scanner）

掃描 BingX USDT 永續合約，策略觸發時推到 Discord（只提醒，不下單）。部署在 Render 免費方案：https://smc-scanner-krbg.onrender.com
回覆一律用繁體中文。

## 分支
- `main`：網站本體，push 後 Render 自動部署。
- `research`：回測與研究工具（`tools/`、`results/`、`.github/workflows/research.yml`、`ft.yml`、`ft2.yml`），跑在 GitHub Actions，結果 commit 回 `results/`。不會影響網站。

## 目前上線的策略：策略①（`src/trend.js`）
- 4H：EMA50 > EMA200 且收盤 > EMA50（做空相反）＋ MACD 柱由負翻正（死叉相反）＋ 成交量 > 20 根均量 1.5 倍
- 4H 收盤後市價進場；止損 = 進場 − 2×ATR(14)（ATR 用訊號那根）
- 保本：1H 出現同向 BOS（打破進場後形成的擺動點）且已賺 ≥ 0.5R → 止損移到開倉價
- 移動止損：持倉後最高價 − 3×ATR，只收緊；沒有固定止盈
- 推播用 TP1 = 1R（提醒可出場或移保本），TP2 = 移動止損
- 持倉數量不限（`maxOpen: Infinity`，有訊號就推）；同一幣一次一筆；4H 收盤 1 小時內才建單
- 回測（OKX 56 幣，2025/1～2026/10）：不限筆數 1107 筆、2025 +58.9R、2026 +27.3R、最大回撤 −32.8R；同時最多 5 筆則 699 筆、+31R／+38R、回撤 −21R
- `src/trend.js` 前後端共用（瀏覽器透過 `/trend.js` 載入），回測工具也直接用它，改規則時三邊要一致

SMC（`src/smc.js`）還在跑，但已改成輔助：`smcPush: 'off'`，不建單不推送，看板也不顯示。

## 檔案
- `src/server.js`：HTTP 伺服器與 API（`/api/market`、`/api/stats`、`/api/sentiment`、`/api/ping`、`/api/cron`…）；含不休眠（每 10 分鐘自我喚醒＋太久沒掃就補掃）
- `src/scanner.js`：每 15 分鐘掃描（挑幣 → 抓 1H/4H K 線 → 策略 → 市場情緒 → tracker）
- `src/tracker.js`：建單、追蹤（保本／移動止損／出場）、成績單、推播文字（`onTrend`）
- `src/notify.js`：Discord Webhook／Telegram；卡片顏色依標題文字決定
- `src/sentiment.js`：右側情緒卡（市場平均 RSI、恐懼貪婪、整體市場、BTC 多空比／未平倉量、穩定幣、資金費率；Binance 失敗改 OKX）＋「分析師」頁（`analyze()` 把以上數據用固定規則打分判斷多空，頁首「分析師」按鈕打開）
- `src/members.js`：會員（回測頁和 `/api/history` 只有管理員能用；不開放註冊；超級管理者在 `/admin` 新增會員＝BingX UID＋初始密碼，可停用／重設密碼）；session 存 cookie `jbp`（30 天）。`MEMBER_GATE` 預設開：沒登入的人首頁導到 `/login`、`/api/*` 回 401（`/api/ping`、`/api/health`、`/api/cron` 例外）。超級管理者帳號 `admin`，密碼只存雜湊（`SUPER_HASH`，可用環境變數 `SUPER_ADMIN_HASH` 換）；密碼填 `ADMIN_TOKEN` 也能登入
- `public/login.html`（登入頁，區塊輸送帶動畫）、`public/admin.html`（會員管理）
- `src/store.js`：有 Upstash Redis 就永久保存，沒有就存 `data/`
- `public/index.html`、`public/app.js`：前端（左側選單，每個按鈕是一個分頁（`go()`，網址 `#room`、`#stats`、`#analyst`…，上一頁可回）；總覽＝資金流地球（可拖曳旋轉、滾輪縮放）＋網站底色切換（8 種，`data-theme` 存 localStorage `smc-theme`）；交易室（`#room`）＝左主欄（招呼＋5 個 KPI＋6 個情緒小卡＋持倉卡（止損→TP1 軌道）＋訊號看板）＋右欄（分析師＋今天的重要數據＋最新推播＋情緒卡）；整頁滑鼠光暈）
- `.github/workflows/keepalive.yml`：每 10 分鐘叫醒 Render；掃描超過 40 分鐘沒更新會失敗並寄信

## 推播格式（`tracker.js` 的 `onTrend`）
```
{幣}USDT　{多/空}
進場: …
TP1: …（可選擇出場，或把止損移到開倉價）
TP2: 移動止損出場（…）
止損: …
⚠️以上內容僅供個人投資記錄使用，並不構成任何形式的投資建議或財務建議
```
後續：到達 TP1／止損移到開倉價／移動止損（每多鎖 1R 推一次）／TP2 出場、保本出場、止損出場。

## 開發
- `npm start` 本機跑（需要 `.env`：`DISCORD_WEBHOOK_URL`、`ADMIN_TOKEN`、`UPSTASH_REDIS_REST_URL`、`UPSTASH_REDIS_REST_TOKEN`，對照 Render 的 Environment）
- `npm test`：`test/mock-test.js`（假 BingX 跑完整流程，`MEMBER_GATE=off`）＋ `test/trend-test.js`（策略①建單→保本→移動止損→出場）＋ `test/member-test.js`（管理者新增→登入→門禁→停用／重設密碼）。改完一定要跑。
- 改策略規則前先在 `research` 分支回測，兩年（2025、2026）都要賺、回撤要用「同時持倉」的方式看，才上線。

## 研究結論（避免重做）
- SMC 各版本（OB 吞沒、BOS+FVG、4H→15M 斐波 0.715、B 版）：打平到小賺，2025 年虧，不穩
- 教科書高勝率（RSI 回檔、布林均值回歸）：兩年都虧，免手續費也虧
- hyperopt 調參數：前段 +84R、沒看過的後段打平 → 過度擬合
- 小週期找進場（1H 吞沒、限價回踩、15M BOS）都讓策略①變差
- freqtrade 社群策略（OKX 合約）：只有 FSupertrendStrategy 兩年都賺（只做多、每筆約 +0.17%、一個月約 145 筆）；建議用止損 −15% 版本，還沒接進網站
- freqtrade 不支援 BingX 合約
- 網路短線策略（OKX 5 分鐘、2025/1～）：E0V1EFt 23 個月只 32 筆、打平（2025 +11U、2026 −11U）；NostalgiaForInfinityX8 帳面 +131%、勝率 99%，但靠加碼攤平、不止損（輸的單抱 100 天以上）、平均抱 2 天，無法照推播格式給會員，不採用
- 日內策略（`research` 的 `tools/intraday.js`，每筆最多抱 1 天）：15M MACD 動能、VWAP 回踩、ICT 亞洲盤掃流動性＋15M CHoCH 都大虧；1H MACD 動能、亞洲盤突破約打平。只有 1H Supertrend 翻轉（4H 順勢）穩：同時 5 筆 2025 +18.5R／2026 +58.5R、回撤 −30R，20 組參數 17 組兩年都賺，隨機排序 196/200 兩年都賺，手續費 0.05% 還 +30R；但「不限筆數」2025 是虧的，要限制同時筆數
- 短線第二批（`research` 的 `tools/intraday2.js`，1H、4H 順勢、最多抱 1 天、同時 5 筆）：Donchian 20 突破（2ATR 止損、3R 或跌破 10 根低點出）最好：2025 +164R／2026 +107R、回撤 −54R、18/23 個月賺，打亂 200 次全賺，手續費 0.05% 仍 +110R／+15R；UT Bot、SSL、PSAR、Squeeze 用 0.022% 兩年都賺，但手續費 0.05% 就有一年虧；15M EMA 9/21、RSI(2) 回檔、UT Bot key 1 大虧
- 1000U、每筆固定虧 50U（5%）、1:2、走到 60% 移保本（`research` 的 `tools/sizing.js`）：手續費 0.05% 時 Donchian 同時 5 筆 2025 +2066U／2026 −1348U、本金一度跌到負的（爆倉）；1H Supertrend +100U／+2470U、本金最低 285U。移保本幾乎沒差（±幾百 U）。不限筆數兩個都爆。止損太近的幣倉位會很大（最大名目價值 111 倍本金），手續費吃掉獲利
- 照使用者開單方式（`research` 的 `tools/margin.js`：1000U、定損 50U、保證金 100U 逐倉、槓桿＝倉位÷100U、BTC/ETH 上限 125 倍、其他 50 倍）：保證金是定損 2 倍時不會先爆倉。市價 0.05%：Donchian 全部幣 +3414U／−269U，手續費共 −8981U（比獲利還多），1535 筆因槓桿超過 50 倍開不了；Supertrend +104U／+2536U、本金最低 259U。限價 0.02%：Donchian +5331U／+3434U（本金 9765U）、Supertrend +642U／+3628U。只做 BTC 兩個策略都約打平到虧
- 盈虧比 1:3（同上設定，市價 0.05%、全部幣）：Donchian 1:3＋60% 移保本 2025 +4828U／2026 +2124U（1:2 是 +3414／−269），本金最低 325U、最長連虧 31 筆；Supertrend 1:3、最多抱 48 小時 +1683U／+4044U、本金最低 766U（最好）。24 小時內很少走到 3R（Supertrend 1860 筆只有 67 筆打到止盈，大多是時間到出場）。只做 BTC 仍約打平
- 不限持倉時間（同上，市價 0.05%）：Supertrend 1:3＋60% 移保本 2025 +2685U／2026 +2531U、本金最低 796U、回撤 −1605U、738 筆（最平均最穩）；不限時間時不移保本會爆（Supertrend 1:2 本金最低 −954U），移保本變得很重要。Donchian 不限時間沒比 24 小時好（1:3＋移保本 24h 7951U 仍最高，但本金最低 325U）。資金費率未計入
