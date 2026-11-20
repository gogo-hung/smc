# 讀網站的成績單＋目前持倉，算實際勝率和「現在全部平倉」的結果（策略①趨勢單）
import json, sys, datetime
stats = json.load(open(sys.argv[1])); market = json.load(open(sys.argv[2]))
tw = lambda ms: datetime.datetime.utcfromtimestamp(ms / 1000 + 8 * 3600).strftime('%m/%d %H:%M') if ms else '—'
sig = [s for s in stats.get('recent', []) if s.get('model') == 'trend']
closed = [s for s in sig if s.get('status') in ('win', 'loss', 'be', 'tp1')]
skipped = [s for s in sig if s.get('status') == 'skipped']
last = {}
for x in market.get('symbols', []):
    if x.get('ltf'): last[x['sym']] = x['ltf'][-1][4]
pos = market.get('positions', [])
out = ['# 策略① 實際成績（網站成績單，' + datetime.datetime.utcfromtimestamp(market.get('updatedAt', 0) / 1000 + 8 * 3600).strftime('%Y-%m-%d %H:%M') + ' 台灣時間）', '']
w = [s for s in closed if s['R'] > 0.05]; b = [s for s in closed if -0.05 <= s['R'] <= 0.05]; l = [s for s in closed if s['R'] < -0.05]
sumR = sum(s['R'] for s in closed)
out += ['## 已出場', '', f'- 筆數 {len(closed)}：賺 {len(w)}、保本 {len(b)}、虧 {len(l)}',
        f'- 勝率（賺 ÷ 全部）{len(w) / max(1, len(closed)) * 100:.0f}%；不算保本 {len(w) / max(1, len(w) + len(l)) * 100:.0f}%',
        f'- 累計 {sumR:+.2f}R，平均每筆 {sumR / max(1, len(closed)):+.2f}R', '',
        '| 幣 | 方向 | 進場時間 | 進場 | 出場 | 結果 |', '|---|---|---|---|---|---|']
out += [f"| {s['sym']} | {'多' if s['dir'] > 0 else '空'} | {tw(s.get('filledAt'))} | {s['entry']:.6g} | {s.get('exit', 0):.6g} | {s['R']:+.2f}R |" for s in sorted(closed, key=lambda s: s.get('closedAt') or 0)]
out += ['', '## 目前持倉：如果現在全部平倉', '', '| 幣 | 方向 | 進場時間 | 進場 | 現價 | 目前止損 | 現在平倉 | 已保本 |', '|---|---|---|---|---|---|---|---|']
tot = 0; nW = 0; rows = []
for p in pos:
    px = last.get(p['sym']); risk = abs(p['entry'] - p['stop0'])
    if px is None or not risk: rows.append(f"| {p['sym']} | {'多' if p['dir'] > 0 else '空'} | {tw(p.get('filledAt'))} | {p['entry']:.6g} | 抓不到 | {p['stop']:.6g} | — | — |"); continue
    R = (px - p['entry']) * p['dir'] / risk - 2 * 0.00022 * p['entry'] / risk
    tot += R; nW += R > 0
    rows.append(f"| {p['sym']} | {'多' if p['dir'] > 0 else '空'} | {tw(p.get('filledAt'))} | {p['entry']:.6g} | {px:.6g} | {p['stop']:.6g} | {R:+.2f}R | {'是' if p.get('be') or (p['stop'] - p['entry']) * p['dir'] >= 0 else '否'} |")
out += rows
allR = sumR + tot; allN = len(closed) + len(pos); allW = len(w) + nW
out += ['', f'- 持倉 {len(pos)} 筆，現在全部平倉合計 **{tot:+.2f}R**（其中 {nW} 筆是賺的）',
        f'- 加上已出場：總共 {allN} 筆、勝率 {allW / max(1, allN) * 100:.0f}%、累計 **{allR:+.2f}R**',
        f'- 現價用的是最近一根已收盤 1H 的收盤價；手續費以 0.022%×2 估算', '',
        f'（另有 {len(skipped)} 筆是之前「同時最多 5 筆」限制時沒做的訊號，不算在內）']
open('results/live-pnl.md', 'w').write('\n'.join(out)); print('\n'.join(out))
