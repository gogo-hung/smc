# 讀 freqtrade 匯出的交易明細，拆多空、每月、最大虧損、出場原因、連虧、年度
import json, glob, zipfile, os, re, collections
def trades_of(path):
    z = zipfile.ZipFile(path)
    for nm in z.namelist():
        if nm.endswith('.json') and 'config' not in nm and 'meta' not in nm:
            d = json.loads(z.read(nm))
            if isinstance(d, dict) and 'strategy' in d:
                for st, s in d['strategy'].items(): return st, s.get('trades', [])
    return None, []
EXIT_ZH = {'roi': '止盈階梯（ROI）', 'trailing_stop_loss': '移動止損', 'stop_loss': '止損', 'exit_signal': '反向訊號出場', 'force_exit': '回測結束強制平倉', 'liquidation': '爆倉'}
out = ['# FSupertrendStrategy 拆解（OKX 合約、30 個主流幣、2025/1 ～ 現在、同時最多 5 筆、每筆 100U、初始 1000U、手續費 0.05%）', '']
summary = ['| 版本 | 筆數 | 勝率 | 2025 | 2026 | 全部（U） | 多單 | 空單 | 最大單筆虧 | 最長連虧 | 止損出場 |', '|---|---|---|---|---|---|---|---|---|---|---|']
detail = []
for path in sorted(glob.glob('logs/**/*.zip', recursive=True)):
    st, tr = trades_of(path)
    if not st: continue
    tr.sort(key=lambda t: t['close_date'])
    n = len(tr); win = sum(1 for t in tr if t['profit_abs'] > 0)
    yr = lambda y: sum(t['profit_abs'] for t in tr if t['close_date'].startswith(y))
    side = lambda s: [t for t in tr if bool(t.get('is_short')) == s]
    L, S = side(False), side(True)
    fmt = lambda a: f"{len(a)} 筆 {sum(t['profit_abs'] for t in a):+.0f}U（勝率 {sum(1 for t in a if t['profit_abs']>0)/max(1,len(a))*100:.0f}%）"
    streak = mx = 0
    for t in tr: streak = streak + 1 if t['profit_abs'] <= 0 else 0; mx = max(mx, streak)
    ex = collections.Counter(t['exit_reason'] for t in tr); exP = collections.defaultdict(float)
    for t in tr: exP[t['exit_reason']] += t['profit_abs']
    worst = sorted(tr, key=lambda t: t['profit_abs'])[:5]
    sl = ex.get('stop_loss', 0)
    summary.append(f"| {st} | {n} | {win/max(1,n)*100:.0f}% | {yr('2025'):+.0f}U | {yr('2026'):+.0f}U | {sum(t['profit_abs'] for t in tr):+.0f}U | {fmt(L)} | {fmt(S)} | {worst[0]['profit_ratio']*100:.1f}% | {mx} | {sl} 筆 {exP.get('stop_loss',0):+.0f}U |")
    mon = collections.defaultdict(float)
    for t in tr: mon[t['close_date'][:7]] += t['profit_abs']
    detail += ['', f'## {st}', '', '**出場原因**', '', '| 原因 | 筆數 | 合計 |', '|---|---|---|']
    detail += [f"| {EXIT_ZH.get(k, k)} | {c} | {exP[k]:+.0f}U |" for k, c in ex.most_common()]
    detail += ['', '**最大的 5 筆虧損**', '', '| 幣 | 方向 | 進場 | 出場 | 虧損 | 原因 |', '|---|---|---|---|---|---|']
    detail += [f"| {t['pair'].split('/')[0]} | {'空' if t.get('is_short') else '多'} | {t['open_date'][:16]} | {t['close_date'][:16]} | {t['profit_ratio']*100:.1f}%（{t['profit_abs']:+.0f}U） | {EXIT_ZH.get(t['exit_reason'], t['exit_reason'])} |" for t in worst]
    pos = sum(1 for v in mon.values() if v > 0)
    detail += ['', f'**每月盈虧**（賺錢月份 {pos}/{len(mon)}）', '', '| 月份 | 盈虧 |', '|---|---|'] + [f"| {k} | {v:+.0f}U |" for k, v in sorted(mon.items())]
md = '\n'.join(out + summary + detail)
os.makedirs('results', exist_ok=True); open('results/ft2-fst.md', 'w').write(md); print(md[:3000])
