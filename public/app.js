// ===== APP =====
(() => {
const $ = id => document.getElementById(id);
const store = { get(k){try{return JSON.parse(localStorage.getItem(k))}catch(e){return null}}, set(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}} };

// ---- 資料來源：有後端就讀 api/market（BingX 即時 K 線），沒有就用示範資料 ----
const BASE = {BTC:98000,ETH:3600,SOL:180,XRP:2.4,DOGE:0.21,BNB:640,ADA:0.7,AVAX:30,LINK:18,SUI:3.5,TON:3.2,DOT:5,NEAR:3,APT:6,ARB:0.5,OP:0.9,INJ:15,SEI:0.3,TIA:2.5,WIF:1,PEPE:0.0000105,FET:0.8,RENDER:4,ATOM:5,LTC:95,BCH:450,FIL:3,AAVE:260,UNI:9,ENA:0.5,JUP:0.6,ONDO:1,TAO:400,HBAR:0.2,TRX:0.3,WLD:1.5};
const SEED = {ETH:152,SUI:594,DOGE:358,INJ:423};
const unpack = a => a.map(k=>({t:k[0],o:k[1],h:k[2],l:k[3],c:k[4],v:k[5]}));
const DataSource = {
  mode:'demo', list:Object.keys(BASE), series:{}, htfs:{}, tick:0, updatedAt:null, serverRules:null,
  async init(){
    let r;
    try{ r=await fetch('api/market',{cache:'no-store'}); }catch(e){ return; }
    if(!r.ok || !(r.headers.get('content-type')||'').includes('json')) return;
    this.mode='live'; this.list=[]; this.series={};
    await this.apply(await r.json());
  },
  async apply(j){
    this.updatedAt=j.updatedAt; this.serverRules=j.rules;
    this.list=(j.symbols||[]).map(x=>x.sym);
    for(const x of j.symbols||[]){ this.series[x.sym]=unpack(x.ltf); this.htfs[x.sym]=unpack(x.htf); }
  },
  async refresh(){ const r=await fetch('api/market',{cache:'no-store'}); if(r.ok) await this.apply(await r.json()); },
  ltf(sym){ if(this.mode==='demo' && !this.series[sym]) this.series[sym]=SMC.genSeries(sym,BASE[sym],1920,SEED[sym]||1); return this.series[sym]; },
  htf(sym){ return this.mode==='live'? this.htfs[sym] : undefined; },
  async advance(){
    if(this.mode==='demo'){ this.tick++; for(const s in this.series) SMC.addBar(this.series[s], s, this.tick); return; }
    const r=await adminFetch('api/scan',{method:'POST'}); if(r && r.ok) await this.refresh();
  }
};
// 伺服器有設 ADMIN_TOKEN 時，寫入動作需要密碼（只存在這台電腦的瀏覽器）
async function adminFetch(url,opt={}){
  const go=()=>fetch(url,{...opt,headers:{'Content-Type':'application/json','x-admin-token':store.get('smc-admin')||'',...(opt.headers||{})}});
  let r=await go();
  if(r.status===401){ const t=window.prompt('伺服器需要管理密碼（ADMIN_TOKEN）'); if(!t) return r; store.set('smc-admin',t); r=await go(); }
  return r;
}

// ---- rules ----
const DEFAULTS={swingLen:3,htfSwing:3,breakBy:'close',obInvalid:'close',needSweep:true,needChoch:true,needFvg:false,minRR:2,lookback:64,stopBuf:0.1,target:'ltf'};
let rules = {...DEFAULTS, ...(store.get('smc-rules-v1')||{})};
function syncForm(){ for(const k in DEFAULTS){ const el=$(k); if(el.type==='checkbox') el.checked=rules[k]; else el.value=rules[k]; } }
function readForm(){ for(const k in DEFAULTS){ const el=$(k); rules[k] = el.type==='checkbox'? el.checked : (typeof DEFAULTS[k]==='number'? (parseFloat(el.value)||DEFAULTS[k]) : el.value); } store.set('smc-rules-v1',rules); }

// ---- state ----
let results=[], selected=null, filt='all', dirF=0, tf='ltf', prevTrig=null;
const STAGES=[['htf','H4 結構'],['pd','折 / 溢價'],['poi','H4 POI'],['sweep','流動性掃蕩'],['choch','15M CHoCH'],['ob','進場 OB'],['fvg','FVG'],['rr','RR 達標']];

const fp = p => p==null||!isFinite(p) ? '—' : p>=1000? p.toLocaleString('en-US',{maximumFractionDigits:1}) : p>=10? p.toFixed(2) : p>=1? p.toFixed(3) : p>=0.01? p.toFixed(4) : p.toPrecision(4);
const hhmm = d => d.toLocaleTimeString('zh-TW',{hour:'2-digit',minute:'2-digit',hour12:false});

function scan(){
  results = DataSource.list.filter(s=>(DataSource.ltf(s)||[]).length>=50).map(s=>SMC.analyze(s, DataSource.ltf(s), rules, DataSource.htf(s)));
  const order={trigger:0,watch:1,idle:2};
  results.sort((a,b)=>order[a.status]-order[b.status] || b.met/b.need.length - a.met/a.need.length || a.sym.localeCompare(b.sym));
  const trig=new Set(results.filter(r=>r.status==='trigger').map(r=>r.sym));
  if(prevTrig){ const fresh=[...trig].filter(s=>!prevTrig.has(s)); fresh.forEach(s=>alertNew(results.find(r=>r.sym===s))); }
  prevTrig=trig;
  $('nT').textContent=trig.size; $('nW').textContent=results.filter(r=>r.status==='watch').length; $('nA').textContent=results.length;
  $('lastScan').textContent= DataSource.mode==='live' ? (DataSource.updatedAt? hhmm(new Date(DataSource.updatedAt)) : '掃描中') : hhmm(new Date());
  if(!selected || !results.find(r=>r.sym===selected)) selected=(results[0]||{}).sym;
  renderRows(); renderDetail();
}

function alertNew(r){
  const log=$('log'); if(log.firstElementChild && log.firstElementChild.classList.contains('muted')) log.innerHTML='';
  const li=document.createElement('li');
  li.innerHTML=`<span class="mono muted">${hhmm(new Date())}</span><b>${r.sym}</b><span class="dir ${r.dir>0?'L':'S'}">${r.dir>0?'多':'空'}</span><span class="mono">進場 ${fp(r.entry)} · 止損 ${fp(r.stop)} · RR ${r.rr.toFixed(1)}</span>`;
  log.prepend(li);
  showToast(`新訊號：${r.sym} ${r.dir>0?'做多':'做空'}，進場 ${fp(r.entry)}，RR ${r.rr.toFixed(1)}`);
}
function showToast(msg){ const t=$('toast'); t.textContent=msg; t.hidden=false; clearTimeout(showToast._t); showToast._t=setTimeout(()=>t.hidden=true,5000); }

function renderRows(){
  const view=results.filter(r=>(filt==='all' || r.status===filt) && (!dirF || r.dir===dirF));
  $('rows').innerHTML = view.map(r=>{
    const stages=STAGES.map(([k,n])=>`<i class="${r.st[k]?'on':''} ${r.need.includes(k)?'':'opt'}" title="${n}${r.need.includes(k)?'':'（選用）'}"></i>`).join('');
    const dir = r.dir? `<span class="dir ${r.dir>0?'L':'S'}">${r.dir>0?'多':'空'}</span>` : '<span class="muted">盤整</span>';
    const stTxt={trigger:'觸發',watch:'觀察',idle:'—'}[r.status];
    const dist = r.entry? `${r.dist>0?'+':''}${r.dist.toFixed(2)}%` : '—';
    return `<tr data-s="${r.sym}" aria-selected="${r.sym===selected}" tabindex="0">
      <td class="sym"><b>${r.sym}</b><span>USDT</span></td><td>${dir}</td>
      <td><span class="status ${r.status}">${stTxt}</span></td><td><span class="stages">${stages}</span></td>
      <td class="num mono">${fp(r.last)}</td><td class="num mono">${r.entry?fp(r.entry):'—'}</td><td class="num mono">${r.stop?fp(r.stop):'—'}</td>
      <td class="num mono">${r.rr?r.rr.toFixed(1):'—'}</td><td class="num mono">${dist}</td></tr>`;
  }).join('');
  $('empty').hidden = view.length>0;
}

function renderDetail(){
  const r=results.find(x=>x.sym===selected); if(!r) return;
  $('dName').innerHTML=`${r.sym}<span class="muted" style="font-size:14px">/USDT</span>`;
  $('dSub').textContent=`現價 ${fp(r.last)} · ${{trigger:'訊號觸發',watch:'已到 POI，等確認',idle:'條件未成形'}[r.status]}`;
  const lv=[['進場',r.entry],['止損',r.stop],['目標',r.target],['RR',r.rr]];
  $('levels').innerHTML=lv.map(([k,v])=>`<div class="lv"><div class="label">${k}</div><div class="x">${k==='RR'?(v?v.toFixed(2):'—'):fp(v)}</div></div>`).join('');
  const D=r.dir>0;
  const val={
    htf: r.dir? `H4 ${D?'多頭':'空頭'}（最後 ${[...r.H.events].reverse().find(e=>e.dir===r.dir).type}）` : '沒有明確結構',
    pd: r.range? `${D?'折價':'溢價'}區判斷，EQ ${fp(r.range.eq)}` : '—',
    poi: r.poi? `${fp(r.poi.lo)} – ${fp(r.poi.hi)}` : '找不到未失效的 H4 OB',
    sweep: r.sweep? `掃過 ${fp(r.sweep.level)}，影線到 ${fp(r.sweep.ext)}` : '尚未掃蕩',
    choch: r.choch? `${r.choch.type} @ ${fp(r.choch.level)}` : '尚未出現',
    ob: r.entryOB? `${fp(r.entryOB.lo)} – ${fp(r.entryOB.hi)}` : (r.choch?'OB 已失效':'—'),
    fvg: r.entryOB? (r.entryOB.fvg?'推動段有 FVG':'沒有 FVG') : '—',
    rr: r.rr? `${r.rr.toFixed(2)}（門檻 ${rules.minRR}）` : '—'
  };
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
  const src = tf==='ltf'? r.ltf : r.htf; const N = tf==='ltf'? Math.min(140,src.length) : src.length; const off=src.length-N; const bars=src.slice(off);
  let lo=Math.min(...bars.map(b=>b.l)), hi=Math.max(...bars.map(b=>b.h));
  [r.entry,r.stop,r.target].forEach(v=>{ if(v){lo=Math.min(lo,v);hi=Math.max(hi,v);} });
  const pad=(hi-lo)*0.06; lo-=pad; hi+=pad;
  const R=66, T=10, B=18, cw=(W-R-8)/N;
  const y=p=>T+(hi-p)/(hi-lo)*(H-T-B), x=i=>8+(i-off)*cw+cw/2;
  g.font='11px "JetBrains Mono",monospace'; g.textBaseline='middle';
  // grid
  g.strokeStyle=C('--line'); g.fillStyle=C('--muted'); g.lineWidth=1;
  for(let k=0;k<=4;k++){ const p=lo+(hi-lo)*k/4, yy=Math.round(y(p))+.5; g.globalAlpha=.6; g.beginPath(); g.moveTo(8,yy); g.lineTo(W-R,yy); g.stroke(); g.globalAlpha=1; g.fillText(fp(p),W-R+6,yy); }
  const box=(x1,p1,p2,col,a)=>{ g.globalAlpha=a; g.fillStyle=col; g.fillRect(x1,y(Math.max(p1,p2)),W-R-x1,Math.max(2,Math.abs(y(p1)-y(p2)))); g.globalAlpha=1; };
  const tag=(t,xx,yy,col)=>{ g.fillStyle=col; g.font='600 11px "Noto Sans TC",sans-serif'; g.fillText(t,xx,yy); g.font='11px "JetBrains Mono",monospace'; };
  const dirCol = r.dir>0? C('--long') : C('--short');
  // POI
  if(r.poi){ const x1= tf==='htf'? Math.max(8,x(r.poi.idx)-cw/2) : 8; box(x1,r.poi.lo,r.poi.hi,C('--accent'),.16); tag('H4 POI',x1+4,y(r.poi.hi)+9,C('--accent')); }
  if(tf==='htf' && r.range){ g.setLineDash([2,4]); g.strokeStyle=C('--muted'); g.beginPath(); g.moveTo(8,y(r.range.eq)); g.lineTo(W-R,y(r.range.eq)); g.stroke(); g.setLineDash([]); tag('EQ',10,y(r.range.eq)-8,C('--muted')); }
  if(tf==='ltf' && r.entryOB && r.entryOB.idx>=off){ const x1=x(r.entryOB.idx)-cw/2; box(x1,r.entryOB.lo,r.entryOB.hi,dirCol,.28); tag('OB',x1+3,y(r.entryOB.lo)+ (r.dir>0?9:-9),dirCol); }
  // candles
  bars.forEach((b,j)=>{ const i=j+off, up=b.c>=b.o, col=up?C('--long'):C('--short'); g.strokeStyle=col; g.fillStyle=col;
    const xx=Math.round(x(i))+.5; g.beginPath(); g.moveTo(xx,y(b.h)); g.lineTo(xx,y(b.l)); g.stroke();
    const bw=Math.max(1,cw*.62); g.fillRect(x(i)-bw/2,y(Math.max(b.o,b.c)),bw,Math.max(1,Math.abs(y(b.o)-y(b.c)))); });
  // structure events
  const evs = tf==='ltf'? (r.choch? [r.choch]:[]) : r.H.events.slice(-4);
  evs.forEach(e=>{ if(e.idx<off) return; const x1=Math.max(8,x(e.from)), x2=x(e.idx), yy=Math.round(y(e.level))+.5; const col=e.dir>0?C('--long'):C('--short');
    g.strokeStyle=col; g.setLineDash([4,3]); g.beginPath(); g.moveTo(x1,yy); g.lineTo(x2,yy); g.stroke(); g.setLineDash([]); tag(e.type,(x1+x2)/2-14,yy+(e.dir>0?-9:9),col); });
  // sweep
  if(tf==='ltf' && r.sweep && r.sweep.idx>=off){ const xx=x(r.sweep.idx), yy=y(r.sweep.ext)+(r.dir>0?10:-10); g.fillStyle=C('--accent'); g.beginPath();
    if(r.dir>0){g.moveTo(xx,yy-5);g.lineTo(xx-5,yy+4);g.lineTo(xx+5,yy+4);} else {g.moveTo(xx,yy+5);g.lineTo(xx-5,yy-4);g.lineTo(xx+5,yy-4);} g.fill(); tag('掃蕩',xx+8,yy,C('--accent')); }
  // levels
  [['進場',r.entry,C('--fg')],['止損',r.stop,C('--short')],['目標',r.target,C('--long')]].forEach(([n,v,col])=>{ if(!v) return; const yy=Math.round(y(v))+.5;
    g.strokeStyle=col; g.setLineDash([6,4]); g.beginPath(); g.moveTo(8,yy); g.lineTo(W-R,yy); g.stroke(); g.setLineDash([]);
    g.fillStyle=col; g.fillRect(W-R+2,yy-8,R-4,16); g.fillStyle=C('--bg'); g.font='600 10px "Noto Sans TC",sans-serif'; g.fillText(n,W-R+6,yy); g.font='11px "JetBrains Mono",monospace'; });
}

// ---- events ----
$('rows').addEventListener('click',e=>{ const tr=e.target.closest('tr'); if(!tr) return; selected=tr.dataset.s; renderRows(); renderDetail(); });
$('rows').addEventListener('keydown',e=>{ if(e.key==='Enter'){ const tr=e.target.closest('tr'); if(tr){selected=tr.dataset.s; renderRows(); renderDetail();} } });
document.querySelectorAll('[data-f]').forEach(b=>b.onclick=()=>{ filt=b.dataset.f; document.querySelectorAll('[data-f]').forEach(x=>x.setAttribute('aria-pressed',x===b)); renderRows(); });
document.querySelectorAll('[data-d]').forEach(b=>b.onclick=()=>{ const d=+b.dataset.d; dirF = dirF===d?0:d; document.querySelectorAll('[data-d]').forEach(x=>x.setAttribute('aria-pressed',+x.dataset.d===dirF)); renderRows(); });
document.querySelectorAll('[data-tf]').forEach(b=>b.onclick=()=>{ tf=b.dataset.tf; document.querySelectorAll('[data-tf]').forEach(x=>x.setAttribute('aria-pressed',x===b)); draw(); });
$('rules').addEventListener('input',()=>{ readForm(); scan(); });
$('rules').addEventListener('submit',e=>e.preventDefault());
$('resetRules').onclick=()=>{ rules={...DEFAULTS}; store.set('smc-rules-v1',rules); syncForm(); scan(); };
$('scanBtn').onclick=async()=>{ const b=$('scanBtn'); b.disabled=true; b.textContent= DataSource.mode==='live'?'向 BingX 抓資料中…':'掃描中…';
  try{ await DataSource.advance(); scan(); } finally { b.disabled=false; b.textContent='立即掃描'; } };
$('pushRules').onclick=async()=>{ const r=await adminFetch('api/rules',{method:'POST',body:JSON.stringify(rules)});
  showToast(r&&r.ok? 'Telegram 推播已改用這組參數' : '套用失敗，請確認伺服器狀態'); };
['equity','riskPct','margin'].forEach(id=>$(id).addEventListener('input',calc));
const gate=()=>{ const ok=$('g1').checked&&$('g2').checked; const v=$('verdict'); v.className='verdict '+(ok?'ok':'stop'); v.textContent= ok? '可以照計畫下單，止損先掛好' : '兩項都確認前，先不要下單'; };
$('g1').onchange=gate; $('g2').onchange=gate;
let timer=null; $('auto').onchange=e=>{ clearInterval(timer); if(!e.target.checked) return;
  timer = DataSource.mode==='live' ? setInterval(async()=>{ await DataSource.refresh(); scan(); },60000) : setInterval(()=>{DataSource.advance(); scan();},30000); };
window.addEventListener('resize',()=>draw());
matchMedia('(prefers-color-scheme: dark)').addEventListener('change',()=>draw());
new MutationObserver(()=>draw()).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
if(document.fonts) document.fonts.ready.then(()=>draw());

const c=store.get('smc-calc'); if(c){ $('equity').value=c.eq; $('riskPct').value=c.rp; $('margin').value=c.mg; }
(async()=>{
  await DataSource.init();
  if(DataSource.mode==='live'){
    if(DataSource.serverRules) rules={...DEFAULTS,...DataSource.serverRules};
    $('srcChip').classList.add('live'); $('srcTxt').textContent='BingX 即時資料';
    $('autoLbl').textContent='每分鐘自動更新'; $('pushRules').hidden=false;
    $('note').textContent='資料來自 BingX USDT 永續合約（已收盤的 K 棒）。後端每根 15M 收盤後自動掃描，新觸發會推到 Telegram；左側改完參數按「套用到推播」，推播才會改用新規則。';
    if(!DataSource.list.length){ $('note').textContent='伺服器第一次掃描中，完成後會自動顯示。';
      const wait=setInterval(async()=>{ await DataSource.refresh(); if(DataSource.list.length){ clearInterval(wait); scan(); } },8000); }
  }
  syncForm(); scan();
})();
})();
