# 從 freqtrade backtesting 印出的 STRATEGY SUMMARY 表抓數字（每個檔案＝一個策略×一個期間）
import re, glob, os, sys
rows = {}
for f in glob.glob('logs/**/*.log', recursive=True):
    m = re.search(r'bt-(.+)-(2025|2026|all)\.log$', f)
    if not m: continue
    st, tag = m.group(1), m.group(2)
    txt = open(f, encoding='utf-8', errors='ignore').read()
    i = txt.rfind('STRATEGY SUMMARY')
    r = rows.setdefault(st, {})
    if i < 0:
        err = re.findall(r'ERROR - (.*)', txt); r[tag] = {'err': (err[-1] if err else '沒有結果')[:80]}; continue
    for line in txt[i:].splitlines():
        cells = [c.strip() for c in re.split(r'[│|┃]', line) if c.strip()]
        if cells and cells[0] == st and len(cells) >= 7:
            nums = lambda s: [float(x) for x in re.findall(r'-?\d+(?:\.\d+)?', s)]
            wdl = nums(cells[6]); dd = nums(cells[7]) if len(cells) > 7 else []
            r[tag] = dict(n=int(nums(cells[1])[0]), pct=nums(cells[4])[0], wr=wdl[-1] if wdl else 0, dd=dd[-1] if dd else 0, dur=cells[5])
            break
tf = {}
for f in glob.glob('tools/ft/strategies/*.py'):
    m = re.search(r"timeframe\s*=\s*['\"](\w+)['\"]", open(f).read()); tf[os.path.basename(f)[:-3]] = m.group(1) if m else ''
fmt = lambda d: '失敗' if 'err' in d else f"{d['n']} 筆｜{d['wr']:.0f}%｜{d['pct']:+.1f}%" if d else '—'
out = ['# freqtrade 社群策略回測（OKX 合約、30 個主流幣、同時最多 5 筆、每筆 100U、初始 1000U、手續費 0.05%）', '',
       '| 策略 | 週期 | 2025（筆數｜勝率｜報酬） | 2026（筆數｜勝率｜報酬） | 全部報酬 | 全部最大回撤 | 平均持倉 | 兩年都賺 |', '|---|---|---|---|---|---|---|---|']
key = lambda kv: -(kv[1].get('all', {}).get('pct', -9999))
for st, r in sorted(rows.items(), key=key):
    a, b, c = r.get('2025', {}), r.get('2026', {}), r.get('all', {})
    ok = '✅' if a.get('pct', -1) > 0 and b.get('pct', -1) > 0 else ''
    out.append(f"| {st} | {tf.get(st,'')} | {fmt(a)} | {fmt(b)} | {c.get('pct', 0):+.1f}% | {c.get('dd', 0):.1f}% | {c.get('dur','')} | {ok} |")
errs = [f"- {st} {t}：{d['err']}" for st, r in rows.items() for t, d in r.items() if 'err' in d]
if errs: out += ['', '失敗：', *errs]
os.makedirs('results', exist_ok=True); open('results/ft-summary.md', 'w').write('\n'.join(out)); print('\n'.join(out))
