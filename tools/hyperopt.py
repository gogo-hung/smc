# 跟 freqtrade hyperopt 一樣的做法：Optuna（TPE）自動找 MTF 參數
# 但多做一步：只用 SPLIT 之前的資料找參數（train），SPLIT 之後的資料（test）完全沒參與，用來檢查是不是過度擬合
import json, os, subprocess, threading, math, time
import optuna

EPOCHS = int(os.environ.get('EPOCHS', 800))
WORKERS = int(os.environ.get('WORKERS', 4))
MIN_N = int(os.environ.get('MIN_N', 60))
SEED = int(os.environ.get('SEED', 42))
OUT = os.environ.get('OUT', 'research-cache/hyperopt-okx.md')

B = dict(model='mtf', side='both', mtfFib=0.715, mtfBand=0.618, mtfEntry='edge', mtfWait=48, mtfReanchor='on', mtfReLo=0.382,
         mtfFvg='on', mtfMinRR=1.0, p1=0, beAt=0, stopBuf=1.0, btcFilter='off', mtfPois=6, mtfSwing=3, htfSwing=3, mtfPoiSrc='choch',
         mtfConf='on', mtfSweep='on', mtfReact='on', mtfReactBars=12, mtfBe='bos', mtfTarget='fixed', mtfTp2='off', mtfDisp=0)

def space(t):
    r = dict(B)
    r['mtfFib'] = round(t.suggest_float('mtfFib', 0.66, 0.79, step=0.005), 3)
    r['mtfBand'] = round(t.suggest_float('mtfBand', 0.5, 0.65, step=0.005), 3)
    r['mtfEntry'] = t.suggest_categorical('mtfEntry', ['edge', 'mid', 'f618', 'f715'])
    r['mtfReLo'] = t.suggest_categorical('mtfReLo', [0, 0.236, 0.3, 0.382, 0.5, 0.618])
    r['stopBuf'] = round(t.suggest_float('stopBuf', 0.2, 2.5, step=0.1), 1)
    r['mtfMinRR'] = round(t.suggest_float('mtfMinRR', 0.8, 2.5, step=0.1), 1)
    r['mtfWait'] = t.suggest_int('mtfWait', 16, 96, step=8)
    r['mtfSweep'] = t.suggest_categorical('mtfSweep', ['on', 'off'])
    r['mtfReact'] = t.suggest_categorical('mtfReact', ['on', 'off'])
    r['mtfReactBars'] = t.suggest_int('mtfReactBars', 6, 24, step=3)
    r['mtfBe'] = t.suggest_categorical('mtfBe', ['bos', 'off'])
    r['mtfTarget'] = t.suggest_categorical('mtfTarget', ['fixed', 'htf'])
    r['mtfTp2'] = t.suggest_categorical('mtfTp2', ['off', 'on'])
    r['mtfSwing'] = t.suggest_int('mtfSwing', 2, 5)
    r['htfSwing'] = t.suggest_int('htfSwing', 2, 5)
    r['mtfDisp'] = t.suggest_float('mtfDisp', 0, 1.5, step=0.25)
    r['btcFilter'] = t.suggest_categorical('btcFilter', ['off', 'block'])
    r['mtfPoiSrc'] = t.suggest_categorical('mtfPoiSrc', ['choch', 'all'])
    return r

def score(s):   # 跟 SharpeHyperOptLoss 同概念：每筆平均 R ÷ 標準差 × √筆數（＝ t 值），筆數太少直接扣分
    if s['n'] < MIN_N: return -3 + s['n'] / MIN_N
    return s['avg'] / s['sd'] * math.sqrt(s['n']) if s['sd'] > 0 else 0

class Worker:
    def __init__(self):
        self.p = subprocess.Popen(['node', 'tools/eval-worker.js'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
        while True:
            l = self.p.stdout.readline()
            if not l: raise RuntimeError('worker died')
            if l.startswith('{') and '"ready"' in l: break
    def run(self, rules, id=0):
        self.p.stdin.write(json.dumps({'id': id, 'rules': rules}) + '\n'); self.p.stdin.flush()
        while True:
            l = self.p.stdout.readline()
            if not l: raise RuntimeError('worker died')
            if l.startswith('{'): return json.loads(l)

optuna.logging.set_verbosity(optuna.logging.WARNING)
study = optuna.create_study(direction='maximize', sampler=optuna.samplers.TPESampler(seed=SEED, n_startup_trials=40, multivariate=True))
lock = threading.Lock(); done = [0]; t0 = time.time()

def loop(w):
    while True:
        with lock:
            if done[0] >= EPOCHS: return
            done[0] += 1; t = study.ask()
            r = space(t)
        res = w.run(r, t.number)
        with lock:
            if 'error' in res: study.tell(t, state=optuna.trial.TrialState.FAIL); continue
            t.set_user_attr('train', res['train']); t.set_user_attr('test', res['test']); t.set_user_attr('rules', r)
            study.tell(t, score(res['train']))
            if t.number % 50 == 0: print(f'epoch {t.number}  best train={study.best_value:.2f}  {time.time()-t0:.0f}s', flush=True)

ws = [Worker() for _ in range(WORKERS)]
base = ws[0].run(B)
th = [threading.Thread(target=loop, args=(w,)) for w in ws]
[x.start() for x in th]; [x.join() for x in th]

f = lambda v: ('+' if v > 0 else '') + f'{v:.1f}'
row = lambda name, tr, te: f"| {name} | {tr['n']} | {tr['wr']*100:.0f}% | {f(tr['R'])} | {score(tr):.2f} | {te['n']} | {te['wr']*100:.0f}% | {f(te['R'])} | {te['avg']:+.2f} | {te['dd']:.1f} |"
H = ['| 設定 | train 筆數 | train 勝率 | train R | train 分數 | test 筆數 | test 勝率 | test R | test 每筆 | test 回撤 |', '|---|---|---|---|---|---|---|---|---|---|']
ok = [t for t in study.trials if t.state == optuna.trial.TrialState.COMPLETE]
top = sorted(ok, key=lambda t: t.value, reverse=True)
lines = [f'# Hyperopt（Optuna TPE，{len(ok)} 組，train < {os.environ.get("SPLIT","2026-06-20")} ≤ test，分數＝t 值，筆數 < {MIN_N} 扣分）', '', *H, row('B 你改的版本（基準）', base['train'], base['test'])]
for i, t in enumerate(top[:20]): lines.append(row(f'第 {i+1} 名 #{t.number}', t.user_attrs['train'], t.user_attrs['test']))
pos = lambda k: sum(1 for t in top[:k] if t.user_attrs['test']['R'] > 0)
lines += ['', f'train 前 10 名裡 test 賺錢的：{pos(10)}/10；前 20 名：{pos(20)}/20；全部 {len(ok)} 組 train 分數和 test R 的相關：' +
          (lambda xs, ys: f'{(sum((a-sum(xs)/len(xs))*(b-sum(ys)/len(ys)) for a,b in zip(xs,ys)) / math.sqrt(sum((a-sum(xs)/len(xs))**2 for a in xs)*sum((b-sum(ys)/len(ys))**2 for b in ys)) if len(xs)>2 else 0):.2f}')([t.value for t in ok if t.user_attrs['train']['n']>=MIN_N], [t.user_attrs['test']['R'] for t in ok if t.user_attrs['train']['n']>=MIN_N])]
lines += ['', '## 前 5 名參數', '']
for i, t in enumerate(top[:5]): lines.append(f'{i+1}. `{json.dumps({k:(round(v,3) if isinstance(v,float) else v) for k,v in t.params.items()}, ensure_ascii=False)}`')
try:
    imp = optuna.importance.get_param_importances(study)
    lines += ['', '## 參數重要性（對 train 分數）', ''] + [f'- {k}: {v:.2f}' for k, v in list(imp.items())[:10]]
except Exception as e: lines += ['', f'(重要性算不出來：{e})']
md = '\n'.join(lines); print(md)
open(OUT, 'w').write(md)
json.dump([{'n': t.number, 'score': t.value, 'params': t.params, 'train': t.user_attrs['train'], 'test': t.user_attrs['test']} for t in top[:50]], open(OUT.replace('.md', '.json'), 'w'), ensure_ascii=False)
for w in ws: w.p.kill()
