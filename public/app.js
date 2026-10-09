// ===== APP =====
(() => {
const $ = id => document.getElementById(id);
const store = { get(k){try{return JSON.parse(localStorage.getItem(k))}catch(e){return null}}, set(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}} };

// ---- 資料來源：有後端就讀 api/market（BingX 即時 K 線），沒有就用示範資料 ----
const BASE = {BTC:98000,ETH:3600,SOL:180,XRP:2.4,DOGE:0.21,BNB:640,ADA:0.7,AVAX:30,LINK:18,SUI:3.5,TON:3.2,DOT:5,NEAR:3,APT:6,ARB:0.5,OP:0.9,INJ:15,SEI:0.3,TIA:2.5,WIF:1,PEPE:0.0000105,FET:0.8,RENDER:4,ATOM:5,LTC:95,BCH:450,FIL:3,AAVE:260,UNI:9,ENA:0.5,JUP:0.6,ONDO:1,TAO:400,HBAR:0.2,TRX:0.3,WLD:1.5};
const SEED = {SOL:87,SUI:107,INJ:10,AVAX:290};
const unpack = a => a.map(k=>({t:k[0],o:k[1],h:k[2],l:k[3],c:k[4],v:k[5]}));
const DataSource = {
  mode:'demo', list:Object.keys(BASE), series:{}, htfs:{}, tick:0, updatedAt:null, serverRules:null, ctx:{btcDir:0,funding:{}},
  async init(){
    let r;
    try{ r=await fetch('api/market',{cache:'no-store'}); }catch(e){ return; }
    if(!r.ok || !(r.headers.get('content-type')||'').includes('json')) return;
    this.mode='live'; this.list=[]; this.series={};
    await this.apply(await r.json());
  },
  async apply(j){
    this.updatedAt=j.updatedAt; this.serverRules=j.rules; if(j.ctx) this.ctx=j.ctx;
    this.list=(j.symbols||[]).map(x=>x.sym);
    for(const x of j.symbols||[]){ this.series[x.sym]=unpack(x.ltf); this.htfs[x.sym]=unpack(x.htf); }
  },
  async refresh(){ const r=await fetch('api/market',{cache:'no-store'}); if(r.ok) await this.apply(await r.json()); },
  ltf(sym){ if(this.mode==='demo'){ if(!this.series[sym]) this.series[sym]=SMC.genSeries(sym,BASE[sym],1920,SEED[sym]||1); return SMC.aggregate(this.series[sym],4); } return this.series[sym]; }, // 示範：15M 合成 1H
  htf(sym){ return this.mode==='live'? this.htfs[sym] : undefined; },
  async advance(){
    if(this.mode==='demo'){ this.tick++; for(const s in this.series) SMC.addBar(this.series[s], s, this.tick); return; }
    const r=await fetch('api/scan',{method:'POST'}); if(r && r.ok){ const j=await r.json().catch(()=>({})); if(j.skipped) showToast('1 分鐘內剛掃描過，已顯示最新結果'); await this.refresh(); }
  }
};
// 伺服器有設 ADMIN_TOKEN 時，寫入動作需要密碼（只存在這台電腦的瀏覽器）
async function adminFetch(url,opt={}){
  const go=()=>fetch(url,{...opt,headers:{'Content-Type':'application/json','x-admin-token':store.get('smc-admin')||'',...(opt.headers||{})}});
  let r=await go();
  if(r.status===401){
    const t=(window.prompt('請輸入管理員密碼（Render 的 ADMIN_TOKEN），輸入一次後這台瀏覽器會記住')||'').trim();
    if(!t) return r;
    store.set('smc-admin',t); r=await go();
    if(r.status===401){ store.set('smc-admin',''); showToast('管理員密碼不正確，請到 Render 的 Environment 確認 ADMIN_TOKEN'); }
  }
  return r;
}

// ---- rules ----
// 策略：H4 找趨勢 → 1H 斐波便宜區裡的 OB → 1H 吞沒 K + EMA50 順勢
const DEFAULTS={swingLen:3,htfSwing:3,breakBy:'close',obInvalid:'close',fibMin:0.618,needEma:true,emaLen:50,lookback:12,entry:'close',minRR:2,stopBuf:0.1,target:'swing',btcFilter:'block',fundingMax:0.05,side:'both',stopMode:'leg'};
let rules = {...DEFAULTS, ...(store.get('smc-rules-v3')||{})};
function syncForm(){ for(const k in DEFAULTS){ const el=$(k); if(el.type==='checkbox') el.checked=rules[k]; else el.value=rules[k]; } renderSum(); }
function renderSum(){
  const t=[`斐波 ≥ ${rules.fibMin}`, rules.needEma?`EMA${rules.emaLen} 順勢`:'不看 EMA', `吞沒 ${rules.lookback}H 內`, rules.entry==='close'?'吞沒收盤進場':'OB 邊緣進場',
    `RR ≥ ${rules.minRR}`, rules.target==='swing'?'目標 1H 前高/低':'目標 H4 極值', {warn:'逆 BTC 警告',block:'逆 BTC 濾掉',off:''}[rules.btcFilter], {long:'只做多',short:'只做空'}[rules.side], `止損：${{swing:'1H 波段點',leg:'推動起點',ob:'OB 外側'}[rules.stopMode]} + ${rules.stopBuf}%`].filter(Boolean);
  $('ruleSum').innerHTML=t.map(x=>`<span>${x}</span>`).join('');
}
function readForm(){ for(const k in DEFAULTS){ const el=$(k); rules[k] = el.type==='checkbox'? el.checked : (typeof DEFAULTS[k]==='number'? (isFinite(parseFloat(el.value))?parseFloat(el.value):DEFAULTS[k]) : el.value); } store.set('smc-rules-v3',rules); renderSum(); }

// ---- state ----
let results=[], selected=null, filt='trigger', dirF=0, tf='ltf', prevTrig=null, q='';
const STAGES=[['htf','H4 趨勢'],['fib','斐波便宜區'],['ob','1H OB'],['engulf','1H 吞沒 K'],['ema','EMA 順勢'],['rr','RR 達標']];

const fp = p => p==null||!isFinite(p) ? '—' : p>=1000? p.toLocaleString('en-US',{maximumFractionDigits:1}) : p>=10? p.toFixed(2) : p>=1? p.toFixed(3) : p>=0.01? p.toFixed(4) : p.toPrecision(4);
const hhmm = d => d.toLocaleTimeString('zh-TW',{hour:'2-digit',minute:'2-digit',hour12:false});

function scan(){
  results = DataSource.list.filter(s=>(DataSource.ltf(s)||[]).length>=50).map(s=>SMC.analyze(s, DataSource.ltf(s), rules, DataSource.htf(s)));
  const btc=results.find(r=>r.sym==='BTC'), ctx={btcDir: btc? btc.dir : 0, funding:(DataSource.ctx&&DataSource.ctx.funding)||{}};
  results.forEach(r=>SMC.applyContext(r,ctx,rules));
  $('nBtc').innerHTML = ctx.btcDir? `<span class="dir ${ctx.btcDir>0?'L':'S'}" style="font-size:16px">${ctx.btcDir>0?'多':'空'}</span>` : '<span class="muted" style="font-size:16px">盤整</span>';
  const order={trigger:0,watch:1,idle:2};
  results.sort((a,b)=>order[a.status]-order[b.status] || b.met/b.need.length - a.met/a.need.length || a.sym.localeCompare(b.sym));
  const trig=new Set(results.filter(r=>r.status==='trigger').map(r=>r.sym));
  if(prevTrig){ const fresh=[...trig].filter(s=>!prevTrig.has(s)); fresh.forEach(s=>alertNew(results.find(r=>r.sym===s))); }
  prevTrig=trig;
  $('nT').textContent=trig.size; $('nW').textContent=results.filter(r=>r.status==='watch').length; $('nA').textContent=results.length;
  $('lastScan').textContent= DataSource.mode==='live' ? (DataSource.updatedAt? hhmm(new Date(DataSource.updatedAt)) : '掃描中') : hhmm(new Date());
  renderRows(); if(!$('detailModal').hidden && results.find(r=>r.sym===selected)) renderDetail();
}

function alertNew(r){
  if(DataSource.mode==='demo'){ Feed.items.unshift({id:'d'+Date.now()+r.sym,t:Date.now(),type:'signal',title:`🎯 ${r.sym}/USDT ${r.dir>0?'做多':'做空'}：訊號成立`,body:`進場 ${fp(r.entry)}　止損 ${fp(r.stop)}　RR ${r.rr.toFixed(2)}`}); renderAlerts(); }
  showToast(`新訊號：${r.sym} ${r.dir>0?'做多':'做空'}，進場 ${fp(r.entry)}，RR ${r.rr.toFixed(1)}`);
}
function showToast(msg){ const t=$('toast'); t.textContent=msg; t.hidden=false; clearTimeout(showToast._t); showToast._t=setTimeout(()=>t.hidden=true,5000); }

// 訊號多久了：觸發 = 吞沒 K 收盤時間；觀察 = 進入斐波便宜區那根收盤時間
const barMs=r=> r.ltf&&r.ltf.length>1 ? r.ltf[1].t-r.ltf[0].t : 3600e3;
const tfName=ms=> ms>=86400e3?'D1': ms>=14400e3?'H4': ms>=3600e3?'1H': `${Math.round(ms/60000)}M`;
function since(r){
  const idx = r.status==='trigger' ? r.sigIdx : r.status==='watch' ? r.fibIdx : null;
  if(idx==null || !r.ltf[idx]) return null;
  return { ts: r.ltf[idx].t + barMs(r), what: r.status==='trigger' ? '吞沒出現' : '進入便宜區', tf: tfName(barMs(r)) };
}
function ago(ts){ const m=Math.max(0,Math.floor((Date.now()-ts)/60000)); if(m<1) return '剛剛'; if(m<60) return `${m} 分鐘前`; const h=Math.floor(m/60); return h<24? `${h} 小時前` : `${Math.floor(h/24)} 天前`; }
const fullTime=ts=>new Date(ts).toLocaleString('zh-TW',{month:'numeric',day:'numeric',weekday:'short',hour:'2-digit',minute:'2-digit',hour12:false});
setInterval(()=>document.querySelectorAll('.age[data-ts]').forEach(el=>{ const ts=+el.dataset.ts; el.querySelector('b').textContent=ago(ts); el.classList.toggle('fresh',Date.now()-ts<3600e3); }),30000);

function spark(r){
  const c=(r.ltf||[]).slice(-64).map(b=>b.c); if(c.length<2) return '';
  const lo=Math.min(...c), hi=Math.max(...c), k=hi-lo||1;
  const pts=c.map((v,i)=>`${(i/(c.length-1)*100).toFixed(1)},${(28-(v-lo)/k*26).toFixed(1)}`).join(' ');
  const col = r.dir>0? 'var(--long)' : r.dir<0? 'var(--short)' : 'var(--muted)';
  let lvl=''; if(r.entry && r.entry>=lo && r.entry<=hi){ const yy=(28-(r.entry-lo)/k*26).toFixed(1); lvl=`<line x1="0" x2="100" y1="${yy}" y2="${yy}" stroke="var(--fg)" stroke-width="1" stroke-dasharray="3 3" vector-effect="non-scaling-stroke" opacity=".5"/>`; }
  return `<svg class="spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">${lvl}<polyline points="${pts}" fill="none" stroke="${col}" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>`;
}
function renderRows(){
  // 搜尋時從全部幣種找；沒搜尋時照分頁（預設只顯示推薦）
  const view=results.filter(r=>(q ? r.sym.includes(q) : (filt==='all' || r.status===filt)) && (!dirF || r.dir===dirF));
  $('rows').innerHTML = view.map(r=>{
    const stages=STAGES.map(([k,n])=>`<i class="${r.st[k]?'on':''} ${r.need.includes(k)?'':'opt'}" title="${n}${r.need.includes(k)?'':'（選用）'}"></i>`).join('');
    const dir = r.dir? `<span class="dir ${r.dir>0?'L':'S'}">${r.dir>0?'多':'空'}</span>` : '<span class="muted" style="font-size:12px">盤整</span>';
    const stTxt={trigger:'觸發',watch:'觀察',idle:'未成形'}[r.status];
    const chg = r.ltf && r.ltf.length>24 ? (r.last/r.ltf[r.ltf.length-25].c-1)*100 : null;
    const missing = r.need.filter(k=>!r.st[k]).map(k=>STAGES.find(x=>x[0]===k)[1]);
    const bottom = r.entry
      ? `<div class="kv"><div><span>進場</span><b>${fp(r.entry)}</b></div><div><span>RR</span><b>${r.rr.toFixed(1)}</b></div>
           <div><span>止損</span><b>${fp(r.stop)}</b></div><div><span>距離</span><b>${r.dist>0?'+':''}${r.dist.toFixed(1)}%</b></div></div>`
      : `<div class="miss">還差：${missing.slice(0,3).join('、')}${missing.length>3?'…':''}</div>`;
    return `<div class="card ${r.status}" data-s="${r.sym}" role="option" tabindex="0" aria-selected="${r.sym===selected}">
      <div class="hd"><b>${r.sym}</b>${dir}<span class="status ${r.status}">${stTxt}</span></div>
      ${(s=>s? `<div class="age ${Date.now()-s.ts<3600e3?'fresh':''}" data-ts="${s.ts}" title="${s.what}：${fullTime(s.ts)}"><span class="tf">${s.tf}</span>${s.what} <b>${ago(s.ts)}</b></div>` : '')(since(r))}
      ${(r.flags&&r.flags.length)||r.blocked? `<div class="tags">${r.blocked?'<span>已濾掉</span>':''}${(r.flags||[]).map(f=>`<span title="${f.t}">${{btc:'逆 BTC',fund:'費率擁擠'}[f.k]||f.t}</span>`).join('')}</div>` : ''}
      <div class="px"><span class="p">${fp(r.last)}</span><span class="d">${chg==null?'':`24h ${chg>0?'+':''}${chg.toFixed(1)}%`}</span></div>
      ${spark(r)}
      <div class="prog"><span class="stages">${stages}</span><span>${r.met}/${r.need.length}</span></div>
      ${bottom}
    </div>`;
  }).join('');
  $('empty').hidden = view.length>0;
  const canAdd = q && DataSource.mode==='live' && /^[A-Z0-9]{2,15}$/.test(q) && !results.some(r=>r.sym===q);
  const nWatch=results.filter(r=>r.status==='watch').length;
  $('showWatch').hidden = !(!q && filt==='trigger' && nWatch);
  if(!$('showWatch').hidden) $('showWatch').textContent=`看觀察中的 ${nWatch} 個幣`;
  $('emptyTxt').textContent = !q ? (filt==='trigger' ? '目前沒有推薦幣種。條件全部成立（1H 吞沒出現）時會出現在這裡，也會推到提醒中心。' : '目前沒有符合篩選的幣。')
    : canAdd ? `${q} 不在目前的掃描名單裡。` : results.some(r=>r.sym.includes(q)) ? `有符合「${q}」的幣，但被「只看多 / 只看空」擋住了。` : `找不到「${q}」。`;
  $('addBtn').hidden=!canAdd; if(canAdd) $('addBtn').textContent=`把 ${q} 加入掃描`;
}

function renderDetail(){
  const r=results.find(x=>x.sym===selected); if(!r) return;
  $('dName').innerHTML=`${r.sym}<span class="muted" style="font-size:14px">/USDT</span>`;
  const sn=since(r);
  $('dSub').textContent=`現價 ${fp(r.last)} · ${{trigger:'吞沒確認，訊號成立',watch:'便宜區有 1H OB，等吞沒',idle:'條件未成形'}[r.status]}${sn?` · ${sn.tf} ${sn.what} ${ago(sn.ts)}（${fullTime(sn.ts)}）`:''}`;
  const lv=[['進場',r.entry],['止損',r.stop],['目標',r.target],['RR',r.rr]];
  $('levels').innerHTML=lv.map(([k,v])=>`<div class="lv"><div class="label">${k}</div><div class="x">${k==='RR'?(v?v.toFixed(2):'—'):fp(v)}</div></div>`).join('');
  const D=r.dir>0;
  const n=r.ltf.length, eAt=i=>r.emaLine&&r.emaLine[i];
  const val={
    htf: r.dir? `H4 ${D?'多頭':'空頭'}（最後 ${[...r.H.events].reverse().find(e=>e.dir===r.dir).type}）` : '沒有明確結構',
    fib: r.fib? `${D?'推動':'下跌'} ${fp(D?r.fib.lo:r.fib.hi)} → ${fp(D?r.fib.hi:r.fib.lo)}，目前回撤 ${(r.retr*100).toFixed(0)}%（要 ≥ ${(rules.fibMin*100).toFixed(1).replace('.0','')}%）` : '1H 還沒有順勢推動',
    ob: r.entryOB? `${fp(r.entryOB.lo)} – ${fp(r.entryOB.hi)}` : (r.fib?'便宜區裡沒有未失效的 OB':'—'),
    engulf: r.engulf? `${new Date(r.ltf[r.engulf.idx].t).toLocaleString('zh-TW',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false})} 收盤 ${fp(r.ltf[r.engulf.idx].c)}` : (r.entryOB?'回到 OB 後還沒出現':'—'),
    ema: (()=>{ const i=r.engulf? r.engulf.idx : n-1, e=eAt(i); return e==null?'資料不足':`${r.engulf?'吞沒收盤':'現價'}在 EMA${rules.emaLen} ${r.ltf[i].c>e?'上方':'下方'}（${fp(e)}）`; })(),
    rr: r.rr? `${r.rr.toFixed(2)}（門檻 ${rules.minRR}）・止損在${r.stopBasis||''}外` : '—'
  };
  const fl=[...(r.blocked?[`⛔ ${r.blocked}`]:[]), ...(r.flags||[]).map(f=>`⚠ ${f.t}`)];
  if(r.funding!=null && !(r.flags||[]).some(f=>f.k==='fund')) fl.push(`<span class="muted" style="font-weight:400">資金費率 ${(r.funding*100).toFixed(3)}%</span>`);
  $('dFlags').hidden=!fl.length; $('dFlags').innerHTML=fl.map(x=>`<div>${x}</div>`).join('');
  $('checks').innerHTML=STAGES.map(([k,n])=>`<li><span class="k"><span class="mark ${r.st[k]?'y':'n'}">${r.st[k]?'✓':'·'}</span>${n}${r.need.includes(k)?'':' <span class="muted">（選用）</span>'}</span><span class="v mono">${val[k]}</span></li>`).join('');
  calc(); draw();
}

function calc(){
  const r=results.find(x=>x.sym===selected);
  const eq=+$('equity').value||0, rp=+$('riskPct').value||0, mg=+$('margin').value||0;
  store.set('smc-calc',{eq,rp,mg});
  if(!r||!r.entry){ $('calcOut').innerHTML='<div class="muted" style="grid-column:1/-1">這個幣還沒有進場位，無法計算倉位。</div>'; return; }
  const risk=eq*rp/100, sp=Math.abs(r.entry-r.stop)/r.entry, notional=risk/sp, lev=mg? notional/mg : 0, qty=notional/r.entry;
  $('calcOut').innerHTML=[['可虧金額',`${risk.toFixed(2)} U`],['止損距離',`${(sp*100).toFixed(2)}%`],['倉位名目',`${notional.toFixed(0)} U`],['數量',`${fp(qty)} ${r.sym}`],['所需槓桿',`${lev.toFixed(1)}x`],['達標獲利',`${(risk*r.rr).toFixed(2)} U`]]
    .map(([k,v])=>`<div><span class="muted">${k}</span><b>${v}</b></div>`).join('');
}

// ---- chart ----
function draw(){
  const r=results.find(x=>x.sym===selected); const cv=$('chart'); if(!r) return;
  const dpr=window.devicePixelRatio||1, W=cv.clientWidth, H=cv.clientHeight; cv.width=W*dpr; cv.height=H*dpr;
  const g=cv.getContext('2d'); g.setTransform(dpr,0,0,dpr,0,0); g.clearRect(0,0,W,H);
  const css=getComputedStyle(document.documentElement), C=k=>css.getPropertyValue(k).trim();
  drawChart(g,W,H,r,tf,C);
}
function drawChart(g,W,H,r,tf,C){
  const src = tf==='ltf'? r.ltf : r.htf; const N = tf==='ltf'? Math.min(120,src.length) : src.length; const off=src.length-N; const bars=src.slice(off);
  let lo=Math.min(...bars.map(b=>b.l)), hi=Math.max(...bars.map(b=>b.h));
  [r.entry,r.stop,r.target].forEach(v=>{ if(v){lo=Math.min(lo,v);hi=Math.max(hi,v);} });
  const pad=(hi-lo)*0.06; lo-=pad; hi+=pad;
  const R=82, T=10, B=18, cw=(W-R-8)/N;
  const y=p=>T+(hi-p)/(hi-lo)*(H-T-B), x=i=>8+(i-off)*cw+cw/2;
  g.font='11px "JetBrains Mono",monospace'; g.textBaseline='middle';
  // grid
  g.strokeStyle=C('--line'); g.fillStyle=C('--muted'); g.lineWidth=1;
  // level tags (entry/stop/target) placed first so grid labels can avoid them; nudged apart when close
  const lv=[['進場',r.entry,C('--fg')],['止損',r.stop,C('--short')],['目標',r.target,C('--long')]].filter(v=>v[1]).map(v=>({n:v[0],p:v[1],col:v[2],y:y(v[1]),ty:y(v[1])})).sort((a,b)=>a.y-b.y);
  for(let i=1;i<lv.length;i++) if(lv[i].ty-lv[i-1].ty<17) lv[i].ty=lv[i-1].ty+17;
  const over=lv.length? lv[lv.length-1].ty-(H-B-8) : 0; if(over>0) lv.forEach(v=>v.ty-=over);
  for(let k=0;k<=4;k++){ const p=lo+(hi-lo)*k/4, yy=Math.round(y(p))+.5; g.globalAlpha=.6; g.beginPath(); g.moveTo(8,yy); g.lineTo(W-R,yy); g.stroke(); g.globalAlpha=1;
    if(!lv.some(v=>Math.abs(v.ty-yy)<14)) { g.fillStyle=C('--muted'); g.fillText(fp(p),W-R+6,yy); } }
  const box=(x1,p1,p2,col,a)=>{ g.globalAlpha=a; g.fillStyle=col; g.fillRect(x1,y(Math.max(p1,p2)),W-R-x1,Math.max(2,Math.abs(y(p1)-y(p2)))); g.globalAlpha=1; };
  const tag=(t,xx,yy,col)=>{ g.font='600 11px "Noto Sans TC",sans-serif'; const w=g.measureText(t).width; xx=Math.min(Math.max(xx,10),W-R-w-6);
    g.globalAlpha=.85; g.fillStyle=C('--raise'); g.fillRect(xx-3,yy-8,w+6,16); g.globalAlpha=1; g.fillStyle=col; g.fillText(t,xx,yy); g.font='11px "JetBrains Mono",monospace'; };
  const dirCol = r.dir>0? C('--long') : C('--short');
  // POI
  if(r.poi){ const x1= tf==='htf'? Math.max(8,x(r.poi.idx)-cw/2) : 8; box(x1,r.poi.lo,r.poi.hi,C('--accent'),.16); tag('H4 POI',x1+4,y(r.poi.hi)+9,C('--accent')); }
  if(tf==='htf' && r.range){ g.setLineDash([2,4]); g.strokeStyle=C('--muted'); g.beginPath(); g.moveTo(8,y(r.range.eq)); g.lineTo(W-R,y(r.range.eq)); g.stroke(); g.setLineDash([]); tag('EQ',10,y(r.range.eq)-8,C('--muted')); }
  // 斐波（1H 推動段）
  if(tf==='ltf' && r.fib){ const x0=Math.max(8,x(Math.max(off,r.fib.from))-cw/2);
    r.fib.levels.forEach(L=>{ if(L.p<lo||L.p>hi) return; const yy=Math.round(y(L.p))+.5, key=L.r===0.5||L.r===rules.fibMin;
      g.strokeStyle=C('--muted'); g.globalAlpha=key?.9:.45; g.setLineDash(L.r===0||L.r===1?[]:[2,3]); g.beginPath(); g.moveTo(x0,yy); g.lineTo(W-R,yy); g.stroke(); g.setLineDash([]); g.globalAlpha=1;
      g.fillStyle=C('--muted'); g.font='10px "JetBrains Mono",monospace'; g.fillText(String(L.r),x0+2,yy-6); g.font='11px "JetBrains Mono",monospace'; });
    const z1=r.fib.levels.find(L=>L.r===1).p, zc=r.dir>0? r.fib.hi-(r.fib.hi-r.fib.lo)*rules.fibMin : r.fib.lo+(r.fib.hi-r.fib.lo)*rules.fibMin;
    g.globalAlpha=.07; g.fillStyle=dirCol; g.fillRect(x0,y(Math.max(z1,zc)),W-R-x0,Math.abs(y(z1)-y(zc))); g.globalAlpha=1; }
  if(tf==='ltf' && r.entryOB && r.entryOB.idx>=off){ const x1=x(r.entryOB.idx)-cw/2; box(x1,r.entryOB.lo,r.entryOB.hi,dirCol,.28); tag('1H OB',x1+3,y(r.entryOB.lo)+ (r.dir>0?9:-9),dirCol); }
  // candles
  bars.forEach((b,j)=>{ const i=j+off, up=b.c>=b.o, col=up?C('--long'):C('--short'); g.strokeStyle=col; g.fillStyle=col;
    const xx=Math.round(x(i))+.5; g.beginPath(); g.moveTo(xx,y(b.h)); g.lineTo(xx,y(b.l)); g.stroke();
    const bw=Math.max(1,cw*.62); g.fillRect(x(i)-bw/2,y(Math.max(b.o,b.c)),bw,Math.max(1,Math.abs(y(b.o)-y(b.c)))); });
  // EMA
  if(tf==='ltf' && r.emaLine){ g.strokeStyle=C('--watch'); g.lineWidth=1.5; g.beginPath(); let st=false;
    for(let i=off;i<src.length;i++){ const e=r.emaLine[i]; if(e==null) continue; const yy=y(e); if(!st){g.moveTo(x(i),yy);st=true;} else g.lineTo(x(i),yy); } g.stroke(); g.lineWidth=1;
    const le=r.emaLine[src.length-1]; if(le!=null) tag(`EMA${rules.emaLen}`,x(src.length-1)-58,y(le)+(r.dir>0?12:-12),C('--watch')); }
  // 吞沒 K
  if(tf==='ltf' && r.engulf && r.engulf.idx>=off){ const i=r.engulf.idx, b=src[i], xx=x(i), yy= r.dir>0? y(b.l)+12 : y(b.h)-12;
    g.fillStyle=C('--accent'); g.beginPath(); if(r.dir>0){g.moveTo(xx,yy-6);g.lineTo(xx-6,yy+4);g.lineTo(xx+6,yy+4);} else {g.moveTo(xx,yy+6);g.lineTo(xx-6,yy-4);g.lineTo(xx+6,yy-4);} g.fill();
    tag('吞沒',xx+9,yy,C('--accent')); }
  // structure events
  const evs = tf==='ltf'? [] : r.H.events.slice(-4);
  evs.forEach(e=>{ if(e.idx<off) return; const x1=Math.max(8,x(e.from)), x2=x(e.idx), yy=Math.round(y(e.level))+.5; const col=e.dir>0?C('--long'):C('--short');
    g.strokeStyle=col; g.setLineDash([4,3]); g.beginPath(); g.moveTo(x1,yy); g.lineTo(x2,yy); g.stroke(); g.setLineDash([]); tag(e.type,(x1+x2)/2-14,yy+(e.dir>0?-9:9),col); });
  // sweep
  if(tf==='ltf' && r.sweep && r.sweep.idx>=off){ const xx=x(r.sweep.idx), yy=y(r.sweep.ext)+(r.dir>0?10:-10); g.fillStyle=C('--accent'); g.beginPath();
    if(r.dir>0){g.moveTo(xx,yy-5);g.lineTo(xx-5,yy+4);g.lineTo(xx+5,yy+4);} else {g.moveTo(xx,yy+5);g.lineTo(xx-5,yy-4);g.lineTo(xx+5,yy-4);} g.fill(); tag('掃蕩',xx+8,yy,C('--accent')); }
  // levels
  lv.forEach(v=>{ const yy=Math.round(v.y)+.5;
    g.strokeStyle=v.col; g.setLineDash([6,4]); g.beginPath(); g.moveTo(8,yy); g.lineTo(W-R,yy); g.stroke(); g.setLineDash([]);
    if(Math.abs(v.ty-v.y)>1){ g.beginPath(); g.moveTo(W-R,yy); g.lineTo(W-R+3,v.ty); g.stroke(); }
    g.fillStyle=v.col; g.fillRect(W-R+3,v.ty-8,R-5,16); g.fillStyle=C('--bg'); g.font='600 10px "Noto Sans TC",sans-serif'; g.fillText(v.n,W-R+6,v.ty);
    g.font='10px "JetBrains Mono",monospace'; g.fillText(fp(v.p),W-R+30,v.ty); g.font='11px "JetBrains Mono",monospace'; });
}

// ---- events ----
// 點卡片 → 跳出詳情小視窗
let lastCard=null;
function openDetail(){ $('detailModal').hidden=false; renderDetail(); $('detailClose').focus({preventScroll:true}); }
function closeDetail(){ $('detailModal').hidden=true; if(lastCard) lastCard.focus({preventScroll:true}); }
const pick=el=>{ if(!el) return; selected=el.dataset.s; lastCard=el; renderRows(); lastCard=$('rows').querySelector(`[data-s="${selected}"]`); openDetail(); };
$('detailClose').onclick=closeDetail;
$('detailModal').addEventListener('click',e=>{ if(e.target===$('detailModal')) closeDetail(); });
$('showWatch').onclick=()=>{ filt='watch'; document.querySelectorAll('[data-f]').forEach(x=>x.setAttribute('aria-pressed',x.dataset.f==='watch')); renderRows(); };
$('rows').addEventListener('click',e=>pick(e.target.closest('[data-s]')));
$('rows').addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); pick(e.target.closest('[data-s]')); } });
document.querySelectorAll('[data-f]').forEach(b=>b.onclick=()=>{ filt=b.dataset.f; document.querySelectorAll('[data-f]').forEach(x=>x.setAttribute('aria-pressed',x===b)); renderRows(); });
document.querySelectorAll('[data-d]').forEach(b=>b.onclick=()=>{ const d=+b.dataset.d; dirF = dirF===d?0:d; document.querySelectorAll('[data-d]').forEach(x=>x.setAttribute('aria-pressed',+x.dataset.d===dirF)); renderRows(); });
document.querySelectorAll('[data-tf]').forEach(b=>b.onclick=()=>{ tf=b.dataset.tf; document.querySelectorAll('[data-tf]').forEach(x=>x.setAttribute('aria-pressed',x===b)); draw(); });
$('rules').addEventListener('input',()=>{ readForm(); scan(); });
$('rules').addEventListener('submit',e=>e.preventDefault());
$('resetRules').onclick=e=>{ e.preventDefault(); e.stopPropagation(); rules={...DEFAULTS}; store.set('smc-rules-v3',rules); syncForm(); scan(); };
$('scanBtn').onclick=async()=>{ const b=$('scanBtn'); b.disabled=true; b.textContent= DataSource.mode==='live'?'向 BingX 抓資料中…':'掃描中…';
  try{ await DataSource.advance(); scan(); } finally { b.disabled=false; b.textContent='立即掃描'; } };
$('pushRules').onclick=async e=>{ e.preventDefault(); e.stopPropagation(); const r=await adminFetch('api/rules',{method:'POST',body:JSON.stringify(rules)});
  if(r&&r.ok) showToast('Telegram 推播已改用這組參數'); else if(r&&r.status!==401) showToast('套用失敗，請確認伺服器狀態'); };
['equity','riskPct','margin'].forEach(id=>$(id).addEventListener('input',calc));
const gate=()=>{ const v=$('verdict');
  if(Feed.locked){ $('g2').checked=false; v.className='verdict stop'; v.textContent=`今天已連虧 ${Feed.lossStreak} 筆，風控鎖啟動：休息，明天再來`; return; }
  const ok=$('g1').checked&&$('g2').checked; v.className='verdict '+(ok?'ok':'stop'); v.textContent= ok? '可以照計畫下單，止損先掛好' : '兩項都確認前，先不要下單'; };
$('g1').onchange=gate; $('g2').onchange=gate;
let timer=null; $('auto').onchange=e=>{ clearInterval(timer); if(!e.target.checked) return;
  timer = DataSource.mode==='live' ? setInterval(async()=>{ await DataSource.refresh(); scan(); },60000) : setInterval(()=>{DataSource.advance(); scan();},30000); };
window.addEventListener('resize',()=>{ if(!$('detailModal').hidden) draw(); });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change',()=>draw());
new MutationObserver(()=>draw()).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
if(document.fonts) document.fonts.ready.then(()=>draw());

// ---- 搜尋 ----
$('q').addEventListener('input',e=>{ q=e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,'').replace(/USDT$/,''); renderRows();
 });
$('q').addEventListener('keydown',e=>{ if(e.key==='Enter' && !$('addBtn').hidden) $('addBtn').click(); });
$('addBtn').onclick=async()=>{ const b=$('addBtn'), sym=q; b.disabled=true; b.textContent=`正在抓 ${sym} 的 K 線…`;
  try{ const r=await fetch('api/add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sym})}); const j=await r.json().catch(()=>({}));
    if(!r.ok){ showToast(j.error||'加入失敗'); return; }
    await DataSource.refresh(); selected=sym; scan(); showToast(`${sym} 已加入，之後每輪都會掃描`);
  } finally { b.disabled=false; } };

// ---- 數據日曆 ----
const Cal={ events:[], cc:store.get('smc-cal-cc')||'USD', imp:+(store.get('smc-cal-imp')||3), ok:false, tab:'eco', earn:null };
const calFmt=(ts,o)=>new Date(ts).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false,...o});
const until=ms=>{ const m=Math.round(ms/60000); if(m<60) return `${m} 分鐘後`; const h=Math.floor(m/60); return h<24? `${h} 小時 ${m%60} 分後` : `${Math.floor(h/24)} 天後`; };
async function loadCal(){
  try{ const r=await fetch('api/calendar',{cache:'no-store'}); if(!r.ok||!(r.headers.get('content-type')||'').includes('json')) throw 0;
    const j=await r.json(); Cal.events=j.events||[]; Cal.ok=true; Cal.error=j.error; }
  catch(e){ Cal.ok=false; }
  renderCal();
}
function calView(){ return Cal.events.filter(e=>(Cal.cc==='ALL'||e.country===Cal.cc) && e.rank>=Cal.imp); }
function renderCal(){
  if(Cal.tab==='earn') return renderEarn();
  $('calFilters').hidden=false;
  document.querySelectorAll('[data-cc]').forEach(b=>b.setAttribute('aria-pressed',b.dataset.cc===Cal.cc));
  document.querySelectorAll('[data-imp]').forEach(b=>b.setAttribute('aria-pressed',+b.dataset.imp===Cal.imp));
  if(!Cal.ok){ $('calNext').textContent= DataSource.mode==='live'?'暫時抓不到日曆，稍後會自動重試':'數據日曆需要連上後端，在你的 Render 網站上會顯示';
    $('calBody').innerHTML='<div class="cal-empty">沒有日曆資料。</div>'; renderCalWarn(); return; }
  const now=Date.now(), list=calView(), next=list.find(e=>e.ts>now);
  const badge=$('calBadge'); badge.hidden=!next;
  if(next){ const m=Math.round((next.ts-now)/60000); badge.textContent= m<60? `${m} 分` : m<1440? `${Math.floor(m/60)}h${String(m%60).padStart(2,'0')}` : `${Math.floor(m/1440)} 天`;
    badge.classList.toggle('soon',m<60); $('calBtn').title=`下一個：${next.countryZh} ${next.titleZh}`; }
  $('calNext').innerHTML = next ? `下一個：<b>${next.countryZh} ${next.titleZh}</b> · ${calFmt(next.ts,{weekday:'short',hour:'2-digit',minute:'2-digit'})} · ${until(next.ts-now)}` : (Cal.error? '日曆更新失敗，顯示的是舊資料' : '這段期間沒有符合條件的數據');
  if(!list.length){ $('calBody').innerHTML='<div class="cal-empty">這週沒有符合篩選的數據。</div>'; renderCalWarn(); return; }
  let day='', html='';
  for(const e of list){
    const d=calFmt(e.ts,{month:'numeric',day:'numeric',weekday:'short'}); if(d!==day){ day=d; html+=`<div class="cal-day">${d}</div>`; }
    const cls=e.ts<now-60000?'past':(e.ts-now<3600e3?'soon':'');
    const imp={3:'h',2:'m',1:'l'}[e.rank]||'';
    html+=`<div class="cal-row ${cls}"><span class="tm">${calFmt(e.ts,{hour:'2-digit',minute:'2-digit'})}</span><span class="cc">${e.countryZh}</span>
      <span class="imp ${imp}" title="${e.impact}"><i></i><i></i><i></i></span>
      <span class="tt">${e.titleZh}${e.alert?'<span class="bell" title="會推播到 Telegram">● 推播</span>':''}${e.titleZh!==e.title?`<small>${e.title}</small>`:''}</span>
      <span class="fv">預測 <b>${e.forecast||'—'}</b></span><span class="fv">前值 <b>${e.previous||'—'}</b></span></div>`;
  }
  $('calBody').innerHTML=html; renderCalWarn();
}
// ---- 上方按鈕開關面板（一次只開一個） ----
const drawers={alertsBtn:'alertsPane',btBtn:'btPane',statsBtn:'statsPane',journalBtn:'journalPane',calBtn:'calPane',rulesBtn:'rulesPane'};
const onOpen={alertsPane:()=>{ Feed.seen=Date.now(); store.set('smc-seen',Feed.seen); setTimeout(renderAlerts,1500); }, statsPane:()=>loadStats(), journalPane:()=>loadJournal()};
function openDrawer(id){ for(const [bt,pn] of Object.entries(drawers)){ const on=pn===id && $(pn).hidden; $(pn).hidden=!on; $(bt).setAttribute('aria-expanded',on); if(on&&onOpen[pn]) onOpen[pn](); } }
for(const [bt,pn] of Object.entries(drawers)) $(bt).onclick=()=>openDrawer(pn);
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>{ $(b.dataset.close).hidden=true; for(const [bt,pn] of Object.entries(drawers)) if(pn===b.dataset.close) $(bt).setAttribute('aria-expanded',false); });
document.addEventListener('keydown',e=>{ if(e.key!=='Escape') return; if(!$('postModal').hidden){ $('postModal').hidden=true; return; } if(!$('detailModal').hidden){ closeDetail(); return; } for(const [bt,pn] of Object.entries(drawers)){ $(pn).hidden=true; $(bt).setAttribute('aria-expanded',false); } });

// 下單前自檢：一小時內有美國高影響數據就提醒
function renderCalWarn(){
  const now=Date.now(), e=Cal.events.find(x=>x.country==='USD' && x.rank>=3 && x.ts>now && x.ts-now<3600e3);
  $('calWarn').hidden=!e; if(e) $('calWarn').textContent=`⚠ ${until(e.ts-now)}公布 ${e.countryZh} ${e.titleZh}，波動大：避免數據前進場，持倉確認止損已掛。`;
}
document.querySelectorAll('[data-cc]').forEach(b=>b.onclick=e=>{ e.preventDefault(); e.stopPropagation(); Cal.cc=b.dataset.cc; store.set('smc-cal-cc',Cal.cc); renderCal(); });
document.querySelectorAll('[data-imp]').forEach(b=>b.onclick=e=>{ e.preventDefault(); e.stopPropagation(); Cal.imp=+b.dataset.imp; store.set('smc-cal-imp',Cal.imp); renderCal(); });
setInterval(renderCal,30000); setInterval(loadCal,15*60000);


// ================= 提醒中心（鈴鐺） =================
const Feed={ items:[], settings:null, locked:false, lossStreak:0, seen:+(store.get('smc-seen')||0), notified:store.get('smc-notified'), telegram:false, storage:'', persistent:false };
const TYPE_ZH={signal:'訊號成立',near:'接近進場',result:'訊號結果',calendar:'數據',earnings:'財報'};
const esc=t=>String(t==null?'':t).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function loadAlerts(poll){
  if(DataSource.mode!=='live'){ renderAlerts(); return; }
  try{ const r=await fetch('api/alerts',{cache:'no-store'}); if(!r.ok) return; const j=await r.json();
    Object.assign(Feed,{items:j.feed||[], settings:j.settings, locked:j.locked, lossStreak:j.lossStreak, telegram:j.telegram, storage:j.storage, persistent:j.persistent});
    browserNotify();
  }catch(e){}
  renderAlerts(); renderLock(); gate();
}
function browserNotify(){
  const newest=Feed.items.length? Feed.items[0].t : 0;
  if(Feed.notified==null){ Feed.notified=newest; store.set('smc-notified',newest); return; }
  const fresh=Feed.items.filter(i=>i.t>Feed.notified).reverse();
  if(fresh.length){ Feed.notified=newest; store.set('smc-notified',newest);
    if('Notification' in window && Notification.permission==='granted') fresh.slice(-5).forEach(i=>{ try{ new Notification(i.title.replace(/<[^>]+>/g,''),{body:i.body,tag:i.id}); }catch(e){} });
    showToast(fresh[fresh.length-1].title); }
}
function renderAlerts(){
  const unread=Feed.items.filter(i=>i.t>Feed.seen).length;
  $('alertBadge').hidden=!unread; $('alertBadge').textContent=unread>99?'99+':unread;
  const st=Feed.settings;
  if(st){ $('as_signal').checked=st.signal; $('as_near').checked=st.near; $('as_nearPct').value=st.nearPct; $('as_calendar').checked=st.calendar; $('as_result').checked=st.result; }
  const live=DataSource.mode==='live';
  $('alertForm').querySelectorAll('input,button').forEach(el=>{ if(el.id!=='notifyBtn') el.disabled=!live; });
  $('alertStatus').innerHTML = !live ? '示範模式：提醒只顯示在這裡。用你的 Render 網站開啟才會推 Telegram。'
    : [Feed.telegram?'Telegram：已設定':'Telegram：還沒設定（Render 加上 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID）',
       `資料儲存：${esc(Feed.storage)}`, 'Notification' in window ? `瀏覽器通知：${{granted:'已開啟',denied:'被封鎖（到瀏覽器網站設定開啟）',default:'未開啟'}[Notification.permission]}`:''].filter(Boolean).join('<br>');
  $('feed').innerHTML = Feed.items.length ? Feed.items.slice(0,100).map(i=>`<div class="feed-item ${i.t>Feed.seen?'unread':''}">
      <span class="tm">${hhmm(new Date(i.t))}<span class="tp">${new Date(i.t).toLocaleDateString('zh-TW',{month:'numeric',day:'numeric'})}</span></span>
      <div><b>${esc(i.title)}</b>${i.muted?'<span class="mut">風控鎖住，未推播</span>':''}<span class="tp">${TYPE_ZH[i.type]||''}</span><p>${esc(i.body)}</p></div></div>`).join('')
    : '<div class="cal-empty">還沒有提醒。有新訊號、價格接近進場區、或重要數據快公布時，會出現在這裡。</div>';
}
$('alertForm').addEventListener('submit',async e=>{ e.preventDefault();
  const body={signal:$('as_signal').checked, near:$('as_near').checked, nearPct:+$('as_nearPct').value||0.3, calendar:$('as_calendar').checked, result:$('as_result').checked};
  const r=await adminFetch('api/alert-settings',{method:'POST',body:JSON.stringify(body)});
  if(r&&r.ok){ Feed.settings=await r.json(); showToast('提醒設定已儲存'); renderAlerts(); } });
$('notifyBtn').onclick=async()=>{ if(!('Notification' in window)) return showToast('這個瀏覽器不支援通知');
  const p=await Notification.requestPermission(); showToast(p==='granted'?'瀏覽器通知已開啟（網頁開著時會跳通知）':'瀏覽器通知沒有開啟'); renderAlerts(); };
$('tgTestBtn').onclick=async()=>{ const r=await adminFetch('api/test-alert',{method:'POST'}); if(!r) return; const j=await r.json().catch(()=>({}));
  showToast(r.ok? (j.ok?'測試訊息已送出，去 Telegram 看看':'送出失敗，檢查 token 和 chat id') : (j.error||'送出失敗')); };
function renderLock(){
  $('lockBar').hidden=!Feed.locked;
  if(Feed.locked) $('lockBar').textContent=`🔒 今天已連虧 ${Feed.lossStreak} 筆：風控鎖啟動，進場提醒暫停推播。休息，明天再來。`;
}

// ================= 匯出 CSV（Excel 可直接開，含中文） =================
function downloadCSV(name, header, rows){
  const cell=v=>{ const t=v==null?'':String(v); return /[",\n]/.test(t)? `"${t.replace(/"/g,'""')}"` : t; };
  const csv='\ufeff'+[header,...rows].map(r=>r.map(cell).join(',')).join('\r\n');
  const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));
  a.download=`${name}-${new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Taipei'})}.csv`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href),5000);
}
const tw=ts=>ts? new Date(ts).toLocaleString('sv-SE',{timeZone:'Asia/Taipei'}).slice(0,16) : '';
async function exportSignals(){
  const s=await (await fetch('api/stats?all=1',{cache:'no-store'})).json();
  downloadCSV('訊號紀錄',['訊號時間','幣種','方向','進場','止損','目標','RR','結果','R','進場時間','結束時間','警告'],
    s.recent.slice().reverse().map(x=>[tw(x.createdAt),x.sym,x.dir>0?'多':'空',x.entry,x.stop,x.target,x.rr&&x.rr.toFixed(2),ST_ZH[x.status],x.R??'',tw(x.filledAt),tw(x.closedAt),(x.flags||[]).join('；')]));
}
async function exportJournal(){
  const r=await adminFetch('api/journal?all=1',{cache:'no-store'}); if(!r||!r.ok) return;
  const j=await r.json();
  downloadCSV('交易紀錄',['時間','幣種','方向','盈虧 USDT','照訊號','備註'], j.trades.slice().reverse().map(t=>[tw(t.at),t.sym,t.dir>0?'多':'空',t.pnl,t.followedSignal?'是':'',t.note]));
}

// ================= 歷史回測 =================
const BT={cache:{}, running:false, last:null};
async function btData(sym, days){
  const k=`${sym}|${days}`; if(BT.cache[k]) return BT.cache[k];
  if(DataSource.mode!=='live'){ const l=DataSource.ltf(sym); return BT.cache[k]={ltf:l, htf:SMC.aggregate(l,4)}; }
  const r=await fetch(`api/history?sym=${encodeURIComponent(sym)}&days=${days}`,{cache:'no-store'});
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error||`HTTP ${r.status}`);
  return BT.cache[k]={ltf:unpack(j.ltf), htf:unpack(j.htf)};
}
function btProgress(p,txt){ $('btProg').hidden=false; $('btBar').style.width=`${Math.round(p*100)}%`; $('btTxt').textContent=txt; }
// 下載歷史（同時 3 個；下載過的直接用暫存）
async function btLoad(days, n, share=0.6){
  const syms=[...new Set(['BTC',...DataSource.list])].slice(0,Math.max(n,1));
  const data={}, failed=[]; let done=0; const q=[...syms];
  await Promise.all([0,1,2].map(async()=>{ while(q.length){ const sym=q.shift();
    try{ data[sym]=await btData(sym,days); }catch(err){ failed.push(`${sym}：${err.message}`); }
    done++; btProgress(done/syms.length*share, `下載歷史 K 線 ${done}/${syms.length}（${sym}）`); } }));
  return {data, syms, failed};
}
function btSpan(data){ return Object.values(data).reduce((a,d)=>{ const l=d.ltf; return l.length>300? [Math.min(a[0],l[300].t), Math.max(a[1],l[l.length-1].t)] : a; },[Infinity,0]); }
function btRunAll(syms, data, rule, opt){ let trades=[]; for(const sym of syms){ if(!data[sym]) continue; trades=trades.concat(SMC.backtest(sym,data[sym].ltf,data[sym].htf,rule,opt).trades); } return trades; }
function btLock(on, label){ BT.running=on; $('btRun').disabled=on; $('btOpt').disabled=on; if(label) (label==='opt'?$('btOpt'):$('btRun')).textContent= on? '計算中…' : (label==='opt'?'自動找最佳參數':'開始回測'); }

$('btForm').addEventListener('submit',async e=>{ e.preventDefault(); if(BT.running) return;
  btLock(true,'run');
  const days=+$('btDays').value, n=+$('btN').value, fee=+$('btFee').value||0, wait=+$('btWait').value||24;
  try{
    const {data, syms, failed}=await btLoad(days,n);
    // 2. 逐幣回測
    const ruleSnap={...rules};
    const btcDirAt = data.BTC ? SMC.trendSeries(data.BTC.htf, ruleSnap) : null;
    let trades=[], i=0;
    for(const sym of syms){ i++; if(!data[sym]) continue;
      btProgress(0.6+i/syms.length*0.4, `計算中 ${i}/${syms.length}（${sym}）`); await new Promise(r=>setTimeout(r));
      const r=SMC.backtest(sym, data[sym].ltf, data[sym].htf, ruleSnap, {feePct:fee, maxWait:wait, btcDirAt});
      trades=trades.concat(r.trades); }
    const span = btSpan(data);
    BT.last={trades, rules:ruleSnap, days, syms:syms.filter(x=>data[x]), failed, fee, span};
    btProgress(1, `完成：${BT.last.syms.length} 個幣、${trades.length} 個訊號`);
    renderBT();
  }catch(err){ showToast('回測失敗：'+err.message); }
  finally{ btLock(false,'run'); }
});

// ---- 自動找最佳參數：跑一批組合，前後兩段都要賺才算穩 ----
const OPT_GRID={ stopMode:['swing','leg','ob'], fibMin:[0.5,0.618], entry:['close','ob'], side:['both','long'], needEma:[true,false] };
const optLabel=g=>[`止損：${{swing:'1H 波段點',leg:'推動起點',ob:'OB 外側'}[g.stopMode]}`, `斐波 ${g.fibMin}`, g.entry==='close'?'吞沒收盤進場':'OB 邊緣進場', g.side==='long'?'只做多':g.side==='short'?'只做空':'多空都做', g.needEma?`EMA${g.emaLen}`:'不看 EMA'];
$('btOpt').onclick=async()=>{ if(BT.running) return; btLock(true,'opt');
  const days=+$('btDays').value, n=+$('btN').value, fee=+$('btFee').value||0, wait=+$('btWait').value||24;
  try{
    const {data, syms, failed}=await btLoad(days,n,0.25);
    const base={...rules}, combos=[];
    for(const sm of OPT_GRID.stopMode) for(const fm of OPT_GRID.fibMin) for(const en of OPT_GRID.entry) for(const sd of OPT_GRID.side) for(const em of OPT_GRID.needEma)
      combos.push({...base, stopMode:sm, fibMin:fm, entry:en, side:sd, needEma:em});
    const span=btSpan(data), mid=(span[0]+span[1])/2, out=[];
    for(let k=0;k<combos.length;k++){
      btProgress(0.25+k/combos.length*0.75, `測試第 ${k+1}/${combos.length} 組：${optLabel(combos[k]).join('、')}`); await new Promise(r=>setTimeout(r));
      const g=combos[k], btcDirAt= data.BTC? SMC.trendSeries(data.BTC.htf,g) : null;
      const trades=btRunAll(syms,data,g,{feePct:fee,maxWait:wait,btcDirAt});
      const st=btStats(trades), res=trades.filter(t=>t.R!=null);
      const R1=res.filter(t=>t.t<mid).reduce((a,t)=>a+t.R,0), R2=res.filter(t=>t.t>=mid).reduce((a,t)=>a+t.R,0);
      out.push({g, st, R1, R2, stable: R1>0 && R2>0 && st.resolved>=30});
    }
    out.sort((a,b)=> (b.stable-a.stable) || (b.st.totalR-a.st.totalR));
    BT.opt={out, days, fee, syms:syms.filter(x=>data[x]), failed, span};
    btProgress(1, `完成：測了 ${out.length} 組參數`);
    renderOpt();
  }catch(err){ showToast('最佳化失敗：'+err.message); }
  finally{ btLock(false,'opt'); }
};
function renderOpt(){
  const O=BT.opt; if(!O) return; const f2=v=>(v>0?'+':'')+v.toFixed(2);
  const nStable=O.out.filter(x=>x.stable).length;
  const rows=O.out.map((x,i)=>`<tr class="${i===0&&x.stable?'best':''}"><td class="num">${i+1}</td><td><div class="chips">${optLabel(x.g).map(c=>`<span>${c}</span>`).join('')}</div></td>
    <td class="num">${x.st.resolved}</td><td class="num">${pct(x.st.winRate)}</td>
    <td class="num" style="color:var(${x.st.totalR>0?'--long':'--short'})">${f2(x.st.totalR)}</td>
    <td class="num">${x.st.pf==null?'—':x.st.pf===Infinity?'∞':x.st.pf.toFixed(2)}</td><td class="num">${f2(x.st.maxDD)}</td><td class="num">${x.st.maxStreak}</td>
    <td class="num">${f2(x.R1)} / ${f2(x.R2)}</td><td>${x.stable?'<span class="opt-ok">✓ 穩</span>':`<span class="opt-no">${x.st.resolved<30?'樣本少':'不穩'}</span>`}</td>
    <td><button class="btn" type="button" data-opt="${i}">套用並查看</button></td></tr>`).join('');
  $('btOut').innerHTML=`<div><h3>參數排行（${O.out.length} 組・${O.syms.length} 個幣・最近 ${O.days} 天）</h3>
    <p class="hint">「穩」= 前半段和後半段都賺錢、而且至少 30 筆已結算。只在某一段賺的組合，多半是剛好貼合那段行情，實盤容易失效。排序：先看穩不穩，再看累計 R。${nStable?'':'<br><b>這次沒有任何一組是穩的</b>：代表目前的策略在這段期間不夠可靠，建議換更長期間（180 天）再試，或回頭調整進場條件。'}</p>
    <div class="tbl-wrap"><table class="mtable"><thead><tr><th class="num">#</th><th>設定</th><th class="num">已結算</th><th class="num">勝率</th><th class="num">累計 R</th><th class="num">獲利因子</th><th class="num">最大回撤</th><th class="num">最大連虧</th><th class="num">前半 / 後半 R</th><th>穩定</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></div>
    <p class="hint">其他參數沿用目前設定（逆 BTC：${{warn:'只標示',block:'濾掉',off:'不管'}[rules.btcFilter]}、止損緩衝 ${rules.stopBuf}%、RR ≥ ${rules.minRR}、目標 ${rules.target==='swing'?'1H 前高/低':'H4 極值'}）。手續費 ${O.fee}%×2。過去表現不代表未來結果。</p>`;
  $('btOut').querySelectorAll('[data-opt]').forEach(bn=>bn.onclick=()=>{ const g=O.out[+bn.dataset.opt].g;
    rules={...DEFAULTS,...g}; store.set('smc-rules-v3',rules); syncForm(); scan();
    showToast('已套用到畫面上的策略參數。確認沒問題後，記得到「策略參數」按「套用到推播」');
    $('btForm').requestSubmit ? $('btForm').requestSubmit() : $('btForm').dispatchEvent(new Event('submit',{cancelable:true})); });
}
function btStats(trades){
  const done=trades.filter(t=>t.R!=null), wins=done.filter(t=>t.R>0);
  const sumW=wins.reduce((a,t)=>a+t.R,0), sumL=done.filter(t=>t.R<=0).reduce((a,t)=>a+t.R,0);
  const seq=done.slice().sort((a,b)=>a.closedT-b.closedT);
  let eq=0, peak=0, dd=0, streak=0, maxStreak=0; const curve=[];
  for(const t of seq){ eq+=t.R; peak=Math.max(peak,eq); dd=Math.min(dd,eq-peak); streak= t.R<=0? streak+1 : 0; maxStreak=Math.max(maxStreak,streak); curve.push({t:t.closedT,eq}); }
  return { n:trades.length, resolved:done.length, winRate: done.length? wins.length/done.length : null, avgR: done.length? (sumW+sumL)/done.length : null,
    totalR: sumW+sumL, pf: sumL<0? sumW/-sumL : (sumW>0? Infinity : null), maxDD: dd, maxStreak, curve,
    missed: trades.filter(t=>t.status==='missed').length, expired: trades.filter(t=>t.status==='expired').length, open: trades.filter(t=>t.status==='open').length };
}
function btGroup(trades, key){
  const m={}; for(const t of trades){ if(t.R==null) continue; const g=key(t); (m[g] ||= []).push(t); }
  return Object.entries(m).map(([g,a])=>({g, n:a.length, winRate:a.filter(t=>t.R>0).length/a.length, R:a.reduce((x,t)=>x+t.R,0)}));
}
function renderBT(){
  const L=BT.last; if(!L) return;
  const s=btStats(L.trades), f2=v=>v==null?'—':(v>0?'+':'')+v.toFixed(2);
  const tile=(l,v,c='')=>`<div class="tile"><div class="label">${l}</div><div class="n ${c}">${v}</div></div>`;
  const tbl=(t,a,sort)=>{ a.sort(sort||((x,y)=>y.n-x.n)); return `<div><h3>${t}</h3>${a.length?`<table class="mtable"><thead><tr><th></th><th class="num">筆數</th><th class="num">勝率</th><th class="num">累計 R</th></tr></thead><tbody>${a.map(x=>`<tr><td>${esc(x.g)}</td><td class="num">${x.n}</td><td class="num">${pct(x.winRate)}</td><td class="num" style="color:var(${x.R>0?'--long':x.R<0?'--short':'--muted'})">${f2(x.R)}</td></tr>`).join('')}</tbody></table>`:'<p class="hint">沒有已結算的訊號</p>'}</div>`; };
  const month=t=>new Date(t.t).toLocaleDateString('sv-SE',{timeZone:'Asia/Taipei'}).slice(0,7);
  const r=L.rules, cmp=[`止損：${{swing:'1H 波段點',leg:'推動起點',ob:'OB 外側'}[r.stopMode||'swing']} + ${r.stopBuf}%`, {long:'只做多',short:'只做空'}[r.side]||'多空都做', `斐波 ≥ ${r.fibMin}`, r.needEma?`EMA${r.emaLen}`:'不看 EMA', `吞沒 ${r.lookback}H 內`, r.entry==='close'?'吞沒收盤進場':'OB 邊緣進場', `RR ≥ ${r.minRR}`, r.target==='swing'?'目標 1H 前高/低':'目標 H4 極值', {warn:'逆 BTC 只標示',block:'逆 BTC 濾掉',off:'不管 BTC'}[r.btcFilter], `手續費 ${L.fee}%×2`];
  const ST={win:'✅ 目標',loss:'❌ 止損',missed:'錯過',expired:'過期',open:'持倉中',pending:'等待'};
  const rows=L.trades.slice().sort((a,b)=>b.t-a.t).slice(0,200).map(t=>`<tr><td class="num">${new Date(t.t).toLocaleString('zh-TW',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false})}</td><td><b>${esc(t.sym)}</b>${t.againstBtc?' <span class="pill">逆BTC</span>':''}</td><td><span class="dir ${t.dir>0?'L':'S'}">${t.dir>0?'多':'空'}</span></td>
    <td class="num">${fp(t.entry)}</td><td class="num">${fp(t.stop)}</td><td class="num">${fp(t.target)}</td><td class="num">${t.rr.toFixed(2)}</td><td>${t.R!=null?`<span class="pill ${t.R>0?'win':'loss'}">${f2(t.R)}R</span>`:`<span class="pill">${ST[t.status]}</span>`}</td></tr>`).join('');
  const sp=L.span[0]<Infinity? `${new Date(L.span[0]).toLocaleDateString('zh-TW')} – ${new Date(L.span[1]).toLocaleDateString('zh-TW')}` : '';
  $('btOut').innerHTML=`
    <div class="bt-cmp">${cmp.map(x=>`<span>${x}</span>`).join('')}<span>${L.syms.length} 個幣 · ${sp}</span></div>
    <div class="tiles">${tile('訊號數',s.n)}${tile('已結算',s.resolved)}${tile('勝率',pct(s.winRate))}${tile('平均 R',f2(s.avgR),s.avgR>0?'pos':s.avgR<0?'neg':'')}${tile('累計 R',f2(s.totalR),s.totalR>0?'pos':s.totalR<0?'neg':'')}${tile('獲利因子',s.pf==null?'—':s.pf===Infinity?'∞':s.pf.toFixed(2))}${tile('最大回撤',s.maxDD?f2(s.maxDD)+'R':'0R','neg')}${tile('最大連虧',s.maxStreak+' 筆')}</div>
    <div><h3>資金曲線（累計 R，依出場時間）</h3><canvas id="btEq" aria-label="回測累計 R 曲線"></canvas></div>
    <div class="split">${tbl('依方向',btGroup(L.trades,t=>t.dir>0?'做多':'做空'))}${tbl('順 / 逆 BTC 大盤',btGroup(L.trades,t=>t.againstBtc?'逆 BTC':'順 BTC'))}${tbl('依月份',btGroup(L.trades,month),(a,b)=>a.g.localeCompare(b.g))}</div>
    <div class="split">${tbl('表現最好的幣',btGroup(L.trades,t=>t.sym),(a,b)=>b.R-a.R)}</div>
    <div><h3>訊號明細（最新 200 筆）</h3><div class="tbl-wrap"><table class="mtable"><thead><tr><th>時間</th><th>幣種</th><th>方向</th><th class="num">進場</th><th class="num">止損</th><th class="num">目標</th><th class="num">RR</th><th>結果</th></tr></thead><tbody>${rows||''}</tbody></table></div></div>
    <div><button class="btn" type="button" id="btCsv">匯出全部回測明細（CSV）</button></div>
    <p class="hint">錯過 ${s.missed}・過期 ${s.expired}・資料結束時仍持倉 ${s.open}（不計入勝率）。同一根 K 棒同時碰到止損與目標保守算止損；進場後下一根才可能打到目標。${L.failed.length?`<br>抓不到資料：${esc(L.failed.slice(0,5).join('；'))}`:''}${DataSource.mode!=='live'?'<br>示範模式：用的是程式產生的 K 線，只有約 20 天。':''}<br>過去表現不代表未來結果。</p>`;
  $('btCsv').onclick=()=>downloadCSV('回測明細',['訊號時間','幣種','方向','進場','止損','目標','RR','結果','R','逆BTC','回撤位置'],
    L.trades.slice().sort((a,b)=>a.t-b.t).map(t=>[tw(t.t),t.sym,t.dir>0?'多':'空',t.entry,t.stop,t.target,t.rr.toFixed(2),ST[t.status],t.R!=null?t.R.toFixed(3):'',t.againstBtc?'是':'',t.retr!=null?(t.retr*100).toFixed(0)+'%':'']));
  drawEquity(s.curve);
}
function drawEquity(curve){
  const cv=$('btEq'); if(!cv) return; const dpr=window.devicePixelRatio||1, W=cv.clientWidth, H=cv.clientHeight; cv.width=W*dpr; cv.height=H*dpr;
  const g=cv.getContext('2d'); g.setTransform(dpr,0,0,dpr,0,0); g.clearRect(0,0,W,H);
  const css=getComputedStyle(document.documentElement), C=k=>css.getPropertyValue(k).trim();
  if(!curve.length){ g.fillStyle=C('--muted'); g.font='13px "Noto Sans TC",sans-serif'; g.fillText('沒有已結算的訊號',16,30); return; }
  const pts=[{eq:0},...curve], lo=Math.min(0,...pts.map(p=>p.eq)), hi=Math.max(0,...pts.map(p=>p.eq)), pad=(hi-lo||1)*0.1;
  const L=44, R=12, T=12, B=18, x=i=>L+i/(pts.length-1||1)*(W-L-R), y=v=>T+(hi+pad-v)/((hi+pad)-(lo-pad))*(H-T-B);
  g.font='11px "JetBrains Mono",monospace'; g.textBaseline='middle'; g.fillStyle=C('--muted'); g.strokeStyle=C('--line');
  for(let k=0;k<=4;k++){ const v=lo-pad+((hi+pad)-(lo-pad))*k/4, yy=Math.round(y(v))+.5; g.beginPath(); g.moveTo(L,yy); g.lineTo(W-R,yy); g.stroke(); g.fillText(`${v>0?'+':''}${v.toFixed(1)}R`,4,yy); }
  g.strokeStyle=C('--muted'); g.setLineDash([3,3]); g.beginPath(); g.moveTo(L,y(0)); g.lineTo(W-R,y(0)); g.stroke(); g.setLineDash([]);
  const last=pts[pts.length-1].eq, col= last>=0? C('--long') : C('--short');
  g.beginPath(); pts.forEach((p,i)=>i?g.lineTo(x(i),y(p.eq)):g.moveTo(x(i),y(p.eq))); g.lineTo(x(pts.length-1),y(0)); g.lineTo(x(0),y(0)); g.closePath(); g.globalAlpha=.12; g.fillStyle=col; g.fill(); g.globalAlpha=1;
  g.strokeStyle=col; g.lineWidth=2; g.beginPath(); pts.forEach((p,i)=>i?g.lineTo(x(i),y(p.eq)):g.moveTo(x(i),y(p.eq))); g.stroke(); g.lineWidth=1;
  g.fillStyle=col; g.beginPath(); g.arc(x(pts.length-1),y(last),3.5,0,7); g.fill();
}
window.addEventListener('resize',()=>{ if(!$('btPane').hidden && BT.last) drawEquity(btStats(BT.last.trades).curve); });

// ================= 成績單 =================
const ST_ZH={pending:'等待進場',filled:'已進場',win:'打到目標',loss:'打到止損',missed:'沒回進場就走了',expired:'24h 未成交'};
const pct=v=>v==null?'—':`${(v*100).toFixed(0)}%`;
async function loadStats(){
  const box=$('statsBody');
  if(DataSource.mode!=='live'){ box.innerHTML='<div class="cal-empty">成績單需要後端記錄每個訊號，在你的 Render 網站上會顯示。</div>'; return; }
  box.innerHTML='<div class="cal-empty">載入中…</div>';
  let s; try{ s=await (await fetch('api/stats',{cache:'no-store'})).json(); }catch(e){ box.innerHTML='<div class="cal-empty">載入失敗，稍後再試。</div>'; return; }
  const tile=(l,v,c='')=>`<div class="tile"><div class="label">${l}</div><div class="n ${c}">${v}</div></div>`;
  const grp=(t,a)=>`<div><h3>${t}</h3>${a.length?`<table class="mtable"><thead><tr><th></th><th class="num">筆數</th><th class="num">勝率</th><th class="num">累計 R</th></tr></thead><tbody>${a.map(x=>`<tr><td>${esc(x.g)}</td><td class="num">${x.n}</td><td class="num">${pct(x.winRate)}</td><td class="num">${x.R>0?'+':''}${x.R}</td></tr>`).join('')}</tbody></table>`:'<p class="hint">還沒有已結算的訊號</p>'}</div>`;
  const rows=s.recent.map(x=>{ const res= x.status==='win'?`<span class="pill win">+${x.R}R</span>`: x.status==='loss'?'<span class="pill loss">-1R</span>' : `<span class="pill ${x.status==='filled'?'filled':''}">${ST_ZH[x.status]}</span>`;
    return `<tr><td class="num">${new Date(x.createdAt).toLocaleString('zh-TW',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false})}</td><td><b>${esc(x.sym)}</b></td><td><span class="dir ${x.dir>0?'L':'S'}">${x.dir>0?'多':'空'}</span></td>
      <td class="num">${fp(x.entry)}</td><td class="num">${fp(x.stop)}</td><td class="num">${fp(x.target)}</td><td class="num">${x.rr.toFixed(2)}</td><td>${res}</td></tr>`; }).join('');
  setTimeout(()=>{ const b=$('exportSig'); if(b) b.onclick=exportSignals; });
  box.innerHTML=`<div class="tiles">${tile('已結算',s.resolved)}${tile('勝率',pct(s.winRate))}${tile('平均 R',s.avgR==null?'—':(s.avgR>0?'+':'')+s.avgR, s.avgR>0?'pos':s.avgR<0?'neg':'')}${tile('累計 R',(s.totalR>0?'+':'')+s.totalR, s.totalR>0?'pos':s.totalR<0?'neg':'')}${tile('等待進場',s.pending)}${tile('已進場',s.filled)}${tile('錯過 / 過期',s.missed+s.expired)}</div>
    <div class="split">${grp('依方向',s.byDir)}${grp('依幣種（前 10）',s.bySym)}</div>
    <div><h3>最近的訊號</h3>${s.recent.length?`<div class="tbl-wrap"><table class="mtable"><thead><tr><th>時間</th><th>幣種</th><th>方向</th><th class="num">進場</th><th class="num">止損</th><th class="num">目標</th><th class="num">RR</th><th>結果</th></tr></thead><tbody>${rows}</tbody></table></div>`:'<p class="hint">還沒有訊號。之後每個觸發都會記在這裡。</p>'}</div>
    <div><button class="btn" type="button" id="exportSig">匯出全部訊號紀錄（CSV）</button></div>
    <p class="hint">贏輸都會保留（最近 5000 筆）。統計的是「推播用參數」下的訊號。同一根 K 棒同時碰到止損和目標，保守算止損；24 小時沒回到進場位算過期。</p>`;
}

// ================= 交易紀錄 + 風控鎖 =================
async function loadJournal(){
  if(DataSource.mode!=='live'){ $('jSum').innerHTML='<p class="hint">交易紀錄存在後端，在你的 Render 網站上才能用。</p>'; $('jList').innerHTML=''; return; }
  const r=await adminFetch('api/journal',{cache:'no-store'});
  if(!r||!r.ok){ $('jSum').innerHTML='<p class="hint">交易紀錄是私人資料，需要管理員密碼才能看。</p><button class="btn" type="button" id="jRetry">輸入密碼</button>'; $('jList').innerHTML=''; $('jRetry').onclick=loadJournal; return; }
  renderJournal(await r.json());
}
function renderJournal(j){
  Feed.locked=j.locked; Feed.lossStreak=j.lossStreak; renderLock(); gate();
  const pnl=v=>`<span style="color:var(${v>0?'--long':v<0?'--short':'--muted'})">${v>0?'+':''}${(+v).toFixed(2)} U</span>`;
  $('jSum').innerHTML=`<div class="stat"><div class="label">今日筆數</div><div class="n mono" style="font-size:22px">${j.today.count}</div></div>
    <div class="stat"><div class="label">今日盈虧</div><div class="n mono" style="font-size:22px">${pnl(j.today.pnl)}</div></div>
    <div class="stat"><div class="label">今日連虧</div><div class="n mono" style="font-size:22px;color:var(${j.lossStreak>=j.lockAfter?'--short':'--fg'})">${j.lossStreak} / ${j.lockAfter}</div></div>
    <div class="stat"><div class="label">全部 ${j.all.count} 筆</div><div class="n mono" style="font-size:22px">${pnl(j.all.pnl)}</div></div>
    <div class="stat"><div class="label">勝率</div><div class="n mono" style="font-size:22px">${pct(j.all.winRate)}</div></div>`;
  $('jList').innerHTML = j.trades.length ? `<div class="tbl-wrap"><table class="mtable"><thead><tr><th>時間</th><th>幣種</th><th>方向</th><th class="num">盈虧</th><th>備註</th><th></th></tr></thead><tbody>${j.trades.map(t=>`<tr>
      <td class="num">${new Date(t.at).toLocaleString('zh-TW',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false})}</td><td><b>${esc(t.sym)}</b></td>
      <td><span class="dir ${t.dir>0?'L':'S'}">${t.dir>0?'多':'空'}</span></td><td class="num">${pnl(t.pnl)}</td>
      <td style="white-space:normal">${t.followedSignal?'<span class="pill">照訊號</span> ':''}${esc(t.note)}</td><td><button class="j-del" type="button" data-del="${t.id}">刪除</button></td></tr>`).join('')}</tbody></table></div>`
    : '<p class="hint">還沒有紀錄。每筆平倉後記一下盈虧，連虧兩筆系統會幫你上鎖。</p>';
  $('jList').insertAdjacentHTML('beforeend','<div style="margin-top:10px"><button class="btn" type="button" id="exportJ">匯出全部交易紀錄（CSV）</button></div>');
  $('exportJ').onclick=exportJournal;
}
$('jForm').addEventListener('submit',async e=>{ e.preventDefault();
  const body={sym:$('jSym').value, dir:+$('jDir').value, pnl:$('jPnl').value, note:$('jNote').value, followedSignal:$('jSig').checked};
  const r=await adminFetch('api/journal',{method:'POST',body:JSON.stringify(body)}); if(!r) return; const j=await r.json().catch(()=>({}));
  if(!r.ok) return showToast(j.error||'新增失敗');
  $('jPnl').value=''; $('jNote').value=''; $('jSig').checked=false; renderJournal(j); loadAlerts();
  showToast(j.locked?'已記錄。今天連虧兩筆，風控鎖啟動，休息一下。':'已記錄'); });
$('jList').addEventListener('click',async e=>{ const id=e.target.dataset&&e.target.dataset.del; if(!id) return;
  if(e.target.dataset.confirm!=='1'){ e.target.dataset.confirm='1'; e.target.textContent='確定刪除？'; return; }
  const r=await adminFetch('api/journal?id='+encodeURIComponent(id),{method:'DELETE'}); if(r&&r.ok){ renderJournal(await r.json()); loadAlerts(); } });
$('logTradeBtn').onclick=()=>{ const r=results.find(x=>x.sym===selected); $('detailModal').hidden=true; if($('journalPane').hidden) openDrawer('journalPane');
  if(r){ $('jSym').value=r.sym; if(r.dir) $('jDir').value=String(r.dir); $('jSig').checked=r.status==='trigger'; }
  $('journalPane').scrollIntoView({behavior:'smooth',block:'start'}); setTimeout(()=>$('jPnl').focus(),300); };

// ================= 美股財報 =================
document.querySelectorAll('[data-ctab]').forEach(b=>b.onclick=e=>{ e.preventDefault(); Cal.tab=b.dataset.ctab;
  document.querySelectorAll('[data-ctab]').forEach(x=>x.setAttribute('aria-pressed',x===b)); if(Cal.tab==='earn' && !Cal.earn) loadEarn(); else renderCal(); });
async function loadEarn(){
  try{ const r=await fetch('api/earnings',{cache:'no-store'}); if(!r.ok||!(r.headers.get('content-type')||'').includes('json')) throw 0; Cal.earn=await r.json(); }
  catch(e){ Cal.earn={error:'offline',events:[],tickers:[]}; }
  renderCal();
}
function renderEarn(){
  $('calFilters').hidden=true;
  const e=Cal.earn||{events:[],tickers:[]};
  if(DataSource.mode!=='live'){ $('calNext').textContent='財報日曆需要連上後端'; $('calBody').innerHTML='<div class="cal-empty">在你的 Render 網站上會顯示。</div>'; return; }
  $('calNext').textContent = e.updatedAt ? `BingX 美股 ${e.tickers.length} 檔的財報；標「● 推播」的會提醒（在 Render 的 EARNINGS_TICKERS 設定）` : (e.error?'財報資料暫時抓不到，稍後會自動重試':'第一次抓取中…');
  if(!e.events.length){ $('calBody').innerHTML=`<div class="cal-empty">未來兩週追蹤的股票沒有財報。${e.error&&!e.updatedAt?'':'要加股票，在 Render 的 EARNINGS_TICKERS 加上代號。'}</div>`; return; }
  const tw=s=>s==='盤前'?'約台灣晚上 8–9 點半':s==='盤後'?'約台灣隔天凌晨 4–5 點':'時間未定';
  $('calBody').innerHTML=e.events.map(x=>`<div class="cal-row"><span class="tm">${x.date.slice(5).replace('-','/')}</span><span class="cc">${x.session}</span><span class="imp h"><i></i><i></i><i></i></span>
    <span class="tt"><b>${esc(x.sym)}</b> ${esc(x.name)}${x.alert?'<span class="bell" title="會推播到 Telegram">● 推播</span>':''}<small>${tw(x.session)}${x.quarter?'｜'+esc(x.quarter):''}</small></span><span class="fv">EPS 預估 <b>${esc(x.eps)||'—'}</b></span><span class="fv"></span></div>`).join('');
}

// ================= 貼文圖卡 =================
const POST_C={'--bg':'#0f131c','--surface':'#171c28','--raise':'#1e2433','--line':'#283044','--fg':'#e8ebf2','--muted':'#8b93a7','--accent':'#e5a13a','--long':'#2fbf9b','--short':'#ee6a6a','--watch':'#c9a25a'};
$('postRef').value=store.get('smc-post-ref')||'';
function drawPost(){
  const r=results.find(x=>x.sym===selected); if(!r) return;
  const cv=$('postCanvas'), g=cv.getContext('2d'), W=1080, H=1350, C=k=>POST_C[k];
  g.setTransform(1,0,0,1,0,0); g.fillStyle=C('--bg'); g.fillRect(0,0,W,H);
  g.textBaseline='alphabetic'; const D=r.dir>0, dc=r.dir? (D?C('--long'):C('--short')) : C('--muted');
  g.fillStyle=C('--accent'); g.font='700 30px "Chakra Petch","Noto Sans TC",sans-serif'; g.fillText('SMC 訊號',64,96);
  g.fillStyle=C('--muted'); g.font='400 26px "Noto Sans TC",sans-serif'; const ts=new Date().toLocaleString('zh-TW',{timeZone:'Asia/Taipei',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});
  g.textAlign='right'; g.fillText(`${ts}（台灣）`,W-64,96); g.textAlign='left';
  g.fillStyle=C('--fg'); g.font='700 104px "Chakra Petch","Noto Sans TC",sans-serif'; g.fillText(r.sym,64,214);
  const sw=g.measureText(r.sym).width; g.font='500 40px "Chakra Petch",sans-serif'; g.fillStyle=C('--muted'); g.fillText('/USDT',72+sw,214);
  if(r.dir){ const t=D?'做多':'做空'; g.font='700 40px "Noto Sans TC",sans-serif'; const tw=g.measureText(t).width; g.fillStyle=dc; g.globalAlpha=.18; g.fillRect(W-64-tw-44,150,tw+44,70); g.globalAlpha=1; g.fillText(t,W-64-tw-22,200); }
  const st={trigger:'條件全到，訊號成立',watch:'已到 H4 POI，等待確認',idle:'條件未成形'}[r.status];
  g.font='400 30px "Noto Sans TC",sans-serif'; g.fillStyle=C('--muted'); g.fillText(`${st}　現價 ${fp(r.last)}`,64,270);
  const note=$('postNote').value.trim(); if(note){ g.fillStyle=C('--fg'); g.font='500 32px "Noto Sans TC",sans-serif'; g.fillText(note,64,322); }
  // chart (drawn at half size then scaled 2x)
  g.save(); g.translate(56,350); g.fillStyle=C('--surface'); g.fillRect(0,0,968,600); g.translate(8,8); g.scale(2,2); drawChart(g,476,292,r,'ltf',C); g.restore();
  // levels
  const lv=[['進場',fp(r.entry),C('--fg')],['止損',fp(r.stop),C('--short')],['目標',fp(r.target),C('--long')],['RR',r.rr?r.rr.toFixed(2):'—',C('--accent')]];
  lv.forEach(([k,v,col],i)=>{ const x=64+i*244; g.fillStyle=C('--raise'); g.fillRect(x,990,224,130); g.fillStyle=C('--muted'); g.font='400 26px "Noto Sans TC",sans-serif'; g.fillText(k,x+22,1036);
    g.fillStyle=col; g.font='600 40px "JetBrains Mono",monospace'; let vv=v; while(g.measureText(vv).width>190 && vv.length>4) vv=vv.slice(0,-1); g.fillText(vv,x+22,1094); });
  const ref=$('postRef').value.trim();
  g.fillStyle=C('--line'); g.fillRect(64,1170,W-128,2);
  if(ref){ g.fillStyle=C('--fg'); g.font='600 32px "Noto Sans TC",sans-serif'; g.fillText(ref,64,1230); }
  g.fillStyle=C('--muted'); g.font='400 24px "Noto Sans TC",sans-serif'; g.fillText('H4 趨勢 → 1H OB × 斐波便宜區 → 吞沒 K + EMA50｜僅供參考，非投資建議',64,ref?1280:1230);
}
$('postBtn').onclick=()=>{ $('postModal').hidden=false; $('postDl').hidden=DataSource.mode!=='live'; drawPost(); if(document.fonts) document.fonts.ready.then(drawPost); };
$('postClose').onclick=()=>{ $('postModal').hidden=true; };
$('postModal').addEventListener('click',e=>{ if(e.target===$('postModal')) $('postModal').hidden=true; });
['postRef','postNote'].forEach(id=>$(id).addEventListener('input',()=>{ if(id==='postRef') store.set('smc-post-ref',$('postRef').value); drawPost(); }));
$('postDl').onclick=()=>{ $('postCanvas').toBlob(b=>{ if(!b) return showToast('產生圖片失敗'); const a=document.createElement('a'); a.href=URL.createObjectURL(b); a.download=`${selected}-smc-${Date.now()}.png`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href),5000); },'image/png'); };
$('postCopy').onclick=()=>{ $('postCanvas').toBlob(async b=>{ try{ await navigator.clipboard.write([new ClipboardItem({'image/png':b})]); showToast('圖片已複製，可以直接貼到 IG / Threads'); }catch(e){ showToast('這個瀏覽器不能直接複製圖片，請用「下載圖片」'); } },'image/png'); };

const c=store.get('smc-calc'); if(c){ $('equity').value=c.eq; $('riskPct').value=c.rp; $('margin').value=c.mg; }
(async()=>{
  await DataSource.init();
  if(DataSource.mode==='live'){
    if(DataSource.serverRules) rules={...DEFAULTS,...DataSource.serverRules};
    $('srcChip').classList.add('live'); $('srcTxt').textContent='BingX 即時資料';
    $('autoLbl').textContent='每分鐘自動更新'; $('pushRules').hidden=false;
    $('note').textContent='資料來自 BingX USDT 永續合約（已收盤的 1H / H4 K 棒）。後端每 15 分鐘掃描一次，新訊號、接近進場區、數據公布前都會推到 Telegram；策略參數改完按「套用到推播」，推播才會改用新規則。';
    if(!DataSource.list.length){ $('note').textContent='伺服器第一次掃描中，完成後會自動顯示。';
      const wait=setInterval(async()=>{ await DataSource.refresh(); if(DataSource.list.length){ clearInterval(wait); scan(); } },8000); }
  }
  syncForm(); scan(); loadCal(); loadAlerts();
  if(DataSource.mode==='live') setInterval(()=>loadAlerts(true),60000);
})();
})();
