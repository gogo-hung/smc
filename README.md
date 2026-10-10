# SMC 掃幣台（crypto-scanner）

掃描 BingX USDT 永續合約，策略條件全部成立時推播到 Telegram。**只提醒，不下單**，也不需要 BingX API Key。

## 策略

多空都做（逆 BTC H4 方向的訊號濾掉）。

**必要條件**（全部成立才推）
1. **H4 趨勢**：BOS / CHoCH 判斷多空
2. **1H OB 在便宜區**：最近一段順勢推動裡、未失效的 OB，位置在斐波 0.618 以下（做空 0.618 以上）
3. **OB 帶 FVG**：OB 之後留下缺口
4. **1H 吞沒 K**：回到 OB 後出現順勢吞沒
5. **EMA50 順勢**：吞沒 K 收在 EMA50 順勢一側
6. **RR ≥ 3**：目標為 H4 這段趨勢的極值（前高 / 前低）

**加分參考**（不擋訊號）：掃流動性、日線同向。

**出場**：吞沒 K 收盤進場；止損在 OB 與吞沒 K 外側 + 0.2%；獲利走到目標一半時止損移到開倉價。

回測（BingX 前 60 名、手續費 0.06%×2）：最近 1 年 193 筆、勝率 30%、+102R、獲利因子 1.87、最大回撤 −14R，多 +44R / 空 +58R。研究用回測在 `research` 分支（`tools/research.js`，GitHub Actions 執行）。

參數都在看板的「策略參數」裡調整，判斷邏輯在 `src/smc.js` 的 `analyze()`，網頁和後端共用同一份。

## 流程

```
每 15 分鐘
 → 抓合約清單 + 24h 成交額，挑出前 N 名（加上自選清單、BTC、搜尋加入的幣）
 → 每個幣抓 1H（300 根）與 4H（200 根，有新 K 棒才重抓）
 → 跑策略 + 大盤濾網
 → 新訊號 / 接近進場區 / 訊號結果 → 提醒中心 + Telegram
```

只用已收盤的 K 棒判斷；「接近進場區」用即時價。

## 需求

Node.js 18 以上，不需要安裝任何套件。

## 開始使用

```bash
cp .env.example .env     # 填 Telegram 設定（不填也能跑，提醒會印在終端機）
npm test                 # 離線測試（用假資料，不連網）
npm run scan             # 實際抓 BingX 跑一次，終端機列出結果
npm start                # 啟動看板 + 自動掃描 → http://localhost:8787
```

## 設定 Telegram

1. 在 Telegram 找 **@BotFather**，輸入 `/newbot` 建立機器人，拿到 token。
2. 對你的機器人隨便傳一則訊息。
3. 打開 `https://api.telegram.org/bot<你的token>/getUpdates`，找 `"chat":{"id":...}` 的數字，就是 `TELEGRAM_CHAT_ID`。
4. 填進 `.env`，重新 `npm start`。

## API

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/api/signals?status=trigger` | 目前訊號（`trigger` / `watch` / 不填全部） |
| GET | `/api/market` | 所有幣的 15M / 4H K 線（看板用） |
| GET | `/api/health` | 上次掃描時間、錯誤 |
| POST | `/api/scan` | 立即掃描（不需密碼，1 分鐘冷卻） |
| GET | `/api/calendar` | 財經日曆（過去 12 小時到未來 8 天） |
| GET | `/api/earnings` | 美股財報（未來 14 天） |
| GET | `/api/alerts` | 提醒紀錄、提醒設定、風控鎖狀態 |
| POST | `/api/alert-settings` | 更新提醒設定（需密碼） |
| POST | `/api/test-alert` | 送一則 Telegram 測試訊息（需密碼） |
| GET | `/api/stats` | 訊號成績單（`?all=1` 全部） |
| GET | `/api/history?sym=SOL&days=90` | 回測用歷史 1H / 4H K 線（分段抓，暫存 2 小時） |
| GET / POST / DELETE | `/api/journal` | 交易紀錄（需密碼） |
| POST | `/api/add` | 加入幣種 `{"sym":"PEPE"}` |
| GET / POST | `/api/rules` | 讀取 / 更新推播用的策略參數 |

`POST /api/scan` 不需要密碼（1 分鐘內只會掃一次）。設了 `ADMIN_TOKEN` 時，`POST /api/rules` 需要帶 `x-admin-token` header（看板會跳出輸入框，輸入一次後會記住）。

## 功能

| 按鈕 | 做什麼 |
|---|---|
| 🔔 提醒中心 | 新訊號成立、價格接近進場區（或碰到進場位）、訊號結果、數據公布前、財報前一天。全部記在這裡並推 Telegram；可開瀏覽器通知 |
| 回測 | 用過去 30–180 天的 1H / 4H K 線跑目前的策略參數（每根收盤只看當時已收盤的資料），算勝率、平均 R、獲利因子、最大回撤、資金曲線，可匯出明細。計算在瀏覽器跑，歷史資料由 `/api/history` 提供 |
| 成績單 | 每個觸發的訊號都追蹤：先碰進場位 → 先打止損還是目標。統計勝率、平均 R、依方向/幣種 |
| 交易紀錄 | 記每筆實際盈虧。今天（台灣時間）連虧 2 筆自動上鎖：進場提醒只記錄不推播，自檢區顯示休息 |
| 數據日曆 | ForexFactory 週曆（中文、台灣時間）＋美股財報（Nasdaq；顯示 BingX 上架的美股，只推播 `EARNINGS_TICKERS` 裡的股票） |
| 策略參數 | SMC 條件 + 大盤濾網（逆 BTC H4 方向警告或濾掉、資金費率擁擠門檻） |
| 卡片 → 產生貼文圖卡 | 1080×1350 圖片，含圖表、進出場位、推薦碼，下載或複製後直接發 IG / Threads |

看板上方的搜尋框可以篩選卡片；搜尋不在名單裡的幣，按「加入掃描」就會立刻抓資料，之後每輪都會掃（最多 20 個）。

## 永久儲存（建議設定）

Render 免費方案每次重新部署都會清空檔案，交易紀錄和成績單會不見。用 Upstash Redis（免費）保存：

1. 到 [upstash.com](https://upstash.com) 註冊 → Create Database（Redis，Region 選 Singapore）
2. 在資料庫頁面的 REST API 區塊，複製 `UPSTASH_REDIS_REST_URL` 和 `UPSTASH_REDIS_REST_TOKEN`
3. 貼到 Render 的 Environment，儲存後自動重新部署

提醒中心下方會顯示目前的儲存方式。

## 調整策略

- 看板左側改參數只會影響畫面；按「套用到推播」才會寫進 `data/rules.json`，之後的推播改用新規則。
- 要改判斷方式本身（例如加入新條件），改 `src/smc.js` 的 `analyze()`，前後端會同時生效。

## 部署到 Render（免費方案）

1. Render → New → **Blueprint** → 選這個 repo，會照 `render.yaml` 建立服務（新加坡機房、免費方案）。
2. 填 `TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID`；`ADMIN_TOKEN` 會自動產生，到服務的 Environment 頁面複製下來。
3. 免費方案閒置 15 分鐘會休眠，所以到 [cron-job.org](https://cron-job.org) 建一個排程，每 10 分鐘打一次：
   `https://<你的服務>.onrender.com/api/cron?token=<ADMIN_TOKEN>`
   這會叫醒服務並掃描；服務醒著時，也會在每根 15M 收盤後自己掃描。

免費方案的限制：
- 重啟會清掉 `data/`，「套用到推播」的規則會回到預設。要長期改規則，直接改 `src/scanner.js` 的 `DEFAULT_RULES` 再推上 GitHub。
- 推播只發「最近 3 根 15M 內才成立」的訊號（`ALERT_MAX_AGE_BARS`），所以重啟不會重推舊訊號；休眠期間錯過的訊號仍會出現在看板上。

要完全常駐，改用付費方案或自己的機器跑 `npm start`（可用 pm2 常駐）。

## 注意

- 只用 BingX 公開行情端點：`/openApi/swap/v2/quote/contracts`、`/openApi/swap/v2/quote/ticker`、`/openApi/swap/v3/quote/klines`。
- 預設前 60 名，每輪約 120 次請求、同時 4 條；遇到 429 會自動重試。被限流的話調低 `CONCURRENCY` 或調高 `REQUEST_GAP_MS`。
- 訊號是篩選工具，不是下單指令。進場前照自己的規則：先確認是訊號不是情緒、連虧兩筆就休息、止損放在結構位、槓桿由止損距離推出來。
