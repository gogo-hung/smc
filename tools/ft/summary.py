# 把三段回測（2025、2026、全部）的策略總表整理成一張 markdown
import json, sys, glob, os, zipfile
rows = {}
for tag in ['2025', '2026', 'all']:
    for f in glob.glob(f'/ud/res/{tag}/*'):
        if f.endswith('.meta.json') or 'last_result' in f: continue
        d = None
        try:
            if f.endswith('.zip'):
                z = zipfile.ZipFile(f)
                for nm in z.namelist():
                    if nm.endswith('.json') and not nm.endswith('_config.json') and 'meta' not in nm:
                        j = json.loads(z.read(nm))
                        if isinstance(j, dict) and 'strategy' in j: d = j; break
            elif f.endswith('.json'): d = json.load(open(f))
        except Exception as e: print('skip', f, e)
        if not d: continue
        for name, s in (d.get('strategy') or {}).items():
            r = rows.setdefault(name, {})
            r[tag] = dict(n=s.get('total_trades', 0), wr=(s.get('wins', 0) / s['total_trades'] * 100) if s.get('total_trades') else 0,
                          pct=s.get('profit_total', 0) * 100, dd=(s.get('max_drawdown_account') or 0) * 100, tf=s.get('timeframe', ''),
                          pf=s.get('profit_factor') or 0, cal=s.get('calmar') or 0, short=s.get('trade_count_short', None))
out = ['# freqtrade 社群策略回測（OKX 合約、30 個主流幣、同時最多 5 筆、每筆 100U、初始 1000U、手續費 0.05%）', '',
       '| 策略 | 週期 | 2025 筆數 | 2025 勝率 | 2025 報酬 | 2026 筆數 | 2026 勝率 | 2026 報酬 | 全部報酬 | 最大回撤 | PF | 兩年都賺 |', '|---|---|---|---|---|---|---|---|---|---|---|---|']
def f(x): return f'{x:+.1f}%'
for name, r in sorted(rows.items(), key=lambda kv: -(kv[1].get('all', {}).get('pct', -999))):
    a, b, c = r.get('2025', {}), r.get('2026', {}), r.get('all', {})
    ok = '✅' if a.get('pct', 0) > 0 and b.get('pct', 0) > 0 else ''
    out.append(f"| {name} | {c.get('tf','')} | {a.get('n','—')} | {a.get('wr',0):.0f}% | {f(a.get('pct',0))} | {b.get('n','—')} | {b.get('wr',0):.0f}% | {f(b.get('pct',0))} | {f(c.get('pct',0))} | {c.get('dd',0):.1f}% | {c.get('pf',0):.2f} | {ok} |")
open('/ud/ft-summary.md', 'w').write('\n'.join(out)); print('\n'.join(out))
