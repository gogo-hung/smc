// ===== SMC ENGINE：前端與後端共用同一份判斷邏輯 =====
const SMC = (() => {
  function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
  function hash(s){let h=2166136261;for(const ch of s){h^=ch.charCodeAt(0);h=Math.imul(h,16777619)}return h>>>0}

  // ---- demo data: regime random walk on 15M ----
  function genSeries(sym, base, n, seed){
    const r = mulberry32(hash(sym)+seed);
    const out=[]; let p=base; let drift=0, left=0; const vol=0.0035+r()*0.003;
    const t0 = Date.UTC(2026,9,9,6,0) - n*900000;
    for(let i=0;i<n;i++){
      if(left<=0){ drift=(r()-0.5)*vol*0.9; left=40+Math.floor(r()*160); }
      left--;
      const o=p; const ret=drift+(r()-0.5)*vol*2;
      const c=o*(1+ret);
      const h=Math.max(o,c)*(1+r()*vol*0.8), l=Math.min(o,c)*(1-r()*vol*0.8);
      out.push({t:t0+i*900000,o,h,l,c,v:Math.round(1000+r()*9000)}); p=c;
    }
    return out;
  }
  function addBar(series, sym, k){
    const r=mulberry32(hash(sym)+k*7919); const last=series[series.length-1];
    const vol=0.004; const o=last.c, c=o*(1+(r()-0.5)*vol*2);
    series.push({t:last.t+900000,o,h:Math.max(o,c)*(1+r()*vol*0.8),l:Math.min(o,c)*(1-r()*vol*0.8),c,v:Math.round(1000+r()*9000)});
  }
  function aggregate(c, k){
    const out=[]; const start=c.length%k;
    for(let i=start;i<c.length;i+=k){const g=c.slice(i,i+k); if(g.length<k)break;
      out.push({t:g[0].t,o:g[0].o,c:g[k-1].c,h:Math.max(...g.map(x=>x.h)),l:Math.min(...g.map(x=>x.l)),v:g.reduce((a,x)=>a+x.v,0)})}
    return out;
  }

  // ---- swings: pivot high/low with L bars each side ----
  function swings(c, L){
    const hi=[], lo=[];
    for(let i=L;i<c.length-L;i++){
      let isH=true,isL=true;
      for(let j=i-L;j<=i+L;j++){ if(j===i)continue; if(c[j].h>=c[i].h)isH=false; if(c[j].l<=c[i].l)isL=false; }
      if(isH)hi.push({i,price:c[i].h,conf:i+L}); if(isL)lo.push({i,price:c[i].l,conf:i+L});
    }
    return {hi,lo};
  }

  // ---- order block for a structure break ----
  function findOB(c, ev, s){
    let m=ev.from;
    for(let i=ev.from;i<ev.idx;i++){ if(ev.dir>0? c[i].l<c[m].l : c[i].h>c[m].h) m=i; }
    let k=m;
    for(let i=m;i>=Math.max(0,m-6);i--){ const opp = ev.dir>0 ? c[i].c<c[i].o : c[i].c>c[i].o; if(opp){k=i;break;} }
    const z={idx:k, hi:c[k].h, lo:c[k].l, dir:ev.dir, broken:false, touched:false, fvg:false};
    for(let i=Math.max(k+2,2);i<=ev.idx;i++){ if(ev.dir>0? c[i].l>c[i-2].h : c[i].h<c[i-2].l){z.fvg=true;break;} }
    const mid=(z.hi+z.lo)/2;
    for(let i=ev.idx+1;i<c.length;i++){
      const b=c[i];
      if(ev.dir>0){ if(b.l<=z.hi) z.touched=true;
        if(s.obInvalid==='close'&&b.c<z.lo || s.obInvalid==='wick'&&b.l<z.lo || s.obInvalid==='half'&&b.l<mid){z.broken=true;z.brokenAt=i;break;} }
      else { if(b.h>=z.lo) z.touched=true;
        if(s.obInvalid==='close'&&b.c>z.hi || s.obInvalid==='wick'&&b.h>z.hi || s.obInvalid==='half'&&b.h>mid){z.broken=true;z.brokenAt=i;break;} }
    }
    return z;
  }

  // ---- market structure: BOS / CHoCH ----
  function structure(c, s){
    const sw=swings(c, s.swingLen);
    const events=[]; let trend=0, hp=0, lp=0, lastH=null, lastL=null;
    for(let j=0;j<c.length;j++){
      while(hp<sw.hi.length && sw.hi[hp].conf<=j){ lastH={...sw.hi[hp],used:false}; hp++; }
      while(lp<sw.lo.length && sw.lo[lp].conf<=j){ lastL={...sw.lo[lp],used:false}; lp++; }
      const up = s.breakBy==='close'? c[j].c : c[j].h;
      const dn = s.breakBy==='close'? c[j].c : c[j].l;
      if(lastH && !lastH.used && up>lastH.price){
        events.push({type:trend===-1?'CHoCH':'BOS',dir:1,idx:j,level:lastH.price,from:lastH.i}); trend=1; lastH.used=true;
      } else if(lastL && !lastL.used && dn<lastL.price){
        events.push({type:trend===1?'CHoCH':'BOS',dir:-1,idx:j,level:lastL.price,from:lastL.i}); trend=-1; lastL.used=true;
      }
    }
    events.forEach(e=>e.ob=findOB(c,e,s));
    return {sw,events,trend};
  }

  // ---- EMA（收盤價） ----
  function ema(c, n){
    const out=new Array(c.length).fill(null), k=2/(n+1); let e=null;
    for(let i=0;i<c.length;i++){
      if(i<n-1) continue;
      if(e===null){ let sum=0; for(let j=i-n+1;j<=i;j++) sum+=c[j].c; e=sum/n; } else e=c[i].c*k+e*(1-k);
      out[i]=e;
    }
    return out;
  }
  // 吞沒：這根實體完全包住前一根實體（影線不算），且方向對
  function isEngulf(c,i,dir){
    if(i<1) return false; const a=c[i-1], b=c[i];
    const aT=Math.max(a.o,a.c), aB=Math.min(a.o,a.c), bT=Math.max(b.o,b.c), bB=Math.min(b.o,b.c);
    if(bT-bB<=aT-aB) return false;
    return (dir>0? b.c>b.o : b.c<b.o) && bT>=aT && bB<=aB;
  }
  // 錘子 / 流星（Pin bar）：順勢那側的影線 ≥ 實體 2 倍、佔整根 6 成以上，收在 K 棒的順勢那一半
  function isPin(c,i,dir){
    const b=c[i]; if(!b) return false; const rg=b.h-b.l; if(rg<=0) return false;
    const body=Math.abs(b.c-b.o), wick= dir>0? Math.min(b.o,b.c)-b.l : b.h-Math.max(b.o,b.c);
    return wick>=2*body && wick>=0.6*rg && (dir>0? b.c>=b.l+rg*0.5 : b.c<=b.h-rg*0.5);
  }
  const isPattern=(c,i,dir,s)=> isEngulf(c,i,dir) || (s.pattern==='both' && isPin(c,i,dir));
  // 4H → 日線（UTC 0 點切日；最後一天沒走完就不算）
  function toDaily(htf){
    const D=864e5, out=[]; let cur=null;
    for(const b of htf){ const d=Math.floor(b.t/D)*D;
      if(!cur || cur.t!==d){ if(cur) out.push(cur); cur={t:d,o:b.o,h:b.h,l:b.l,c:b.c,v:b.v,n:1}; }
      else { cur.h=Math.max(cur.h,b.h); cur.l=Math.min(cur.l,b.l); cur.c=b.c; cur.v+=b.v; cur.n++; } }
    if(cur && cur.n>=6) out.push(cur);
    return out;
  }

  // 加分條件：每項可以設成 need（必要）/ score（加分）/ off（不看）
  const BONUS=['fib','ema','fvg','sweep','daily'];
  const condMode=(s,k)=>{ const v=s['c'+k[0].toUpperCase()+k.slice(1)]; if(v) return v;
    if(k==='fib') return 'need'; if(k==='ema') return s.needEma===false?'off':'need'; return 'off'; }; // 舊設定相容

  // ---- 策略：日線 / H4 找趨勢 → 1H 結構裡的 OB → 1H 型態（吞沒 / Pin bar）；斐波、EMA、FVG、掃流動性、日線同向 = 加分 ----
  // ltf = 1H K 線；htfIn = H4 K 線（沒給就用 1H 合成）
  function analyze(sym, ltf, s, htfIn){
    const htf = htfIn && htfIn.length ? htfIn : aggregate(ltf,4);
    const H=structure(htf,{...s,swingLen:s.htfSwing});
    const L=structure(ltf,s);
    const dir=H.trend; const n=ltf.length, last=ltf[n-1].c;
    const st={htf:false,ob:false,engulf:false,rr:false,fib:false,ema:false,fvg:false,sweep:false,daily:false};
    const res={sym,dir,last,st,htf,ltf,H,L,emaLine:ema(ltf,s.emaLen||50)};
    if(!dir) return finish(res,s);
    st.htf=true;
    const daily=toDaily(htf);
    if(daily.length>=12){ res.dailyDir=structure(daily,{...s,swingLen:Math.min(s.htfSwing||3,3)}).trend; st.daily=res.dailyDir===dir; }
    // H4 區間（圖表用）
    const lastEv=[...H.events].reverse().find(e=>e.dir===dir);
    let rHi=-Infinity,rLo=Infinity;
    for(let i=lastEv.from;i<htf.length;i++){rHi=Math.max(rHi,htf[i].h);rLo=Math.min(rLo,htf[i].l);}
    res.range={hi:rHi,lo:rLo,eq:(rHi+rLo)/2};

    // 1H 最近一段順勢推動 → 畫斐波
    const leg=[...L.events].reverse().find(e=>e.dir===dir);
    if(!leg) return finish(res,s);
    let lo=Infinity, hi=-Infinity, a=leg.from, b=leg.idx;
    if(dir>0){ for(let i=a;i<=b;i++) if(ltf[i].l<lo){lo=ltf[i].l;a=i;} for(let i=leg.idx;i<n;i++) if(ltf[i].h>hi){hi=ltf[i].h;b=i;} }
    else     { for(let i=a;i<=b;i++) if(ltf[i].h>hi){hi=ltf[i].h;a=i;} for(let i=leg.idx;i<n;i++) if(ltf[i].l<lo){lo=ltf[i].l;b=i;} }
    const span=hi-lo||1;
    const retr=p=> dir>0? (hi-p)/span : (p-lo)/span;         // 0 = 推動終點，1 = 起點
    const lvl=r=> dir>0? hi-span*r : lo+span*r;
    res.fib={lo,hi,from:a,to:b,levels:[0,0.5,0.618,0.786,1].map(r=>({r,p:lvl(r)}))};
    res.retr=retr(last);
    const W=Math.min(s.lookback||12, n-2), start=n-W;
    for(let i=Math.max(start,b);i<n;i++){ if(retr(dir>0? ltf[i].l : ltf[i].h)>=s.fibMin){ st.fib=true; res.fibIdx=i; break; } }

    // 這段推動裡、未失效的順勢 1H OB（斐波設成必要時，OB 要在便宜區裡）
    const fibNeed=condMode(s,'fib')==='need';
    const obs=L.events.filter(e=>e.dir===dir && !e.ob.broken).map(e=>e.ob)
      .filter(ob=> dir>0 ? (ob.lo>=lo*0.998 && ob.hi<=hi && (!fibNeed || retr(ob.hi)>=s.fibMin))
                         : (ob.hi<=hi*1.002 && ob.lo>=lo && (!fibNeed || retr(ob.lo)>=s.fibMin)))
      .sort((x,y)=>y.idx-x.idx);
    const emaAt=i=>res.emaLine[i];
    const emaOk=i=> emaAt(i)!=null && (dir>0? ltf[i].c>emaAt(i) : ltf[i].c<emaAt(i));
    st.ema=emaOk(n-1);
    if(!obs.length) return finish(res,s);
    st.ob=true;
    const pairLow = i=> Math.min(ltf[i].l,ltf[i-1].l), pairHigh = i=> Math.max(ltf[i].h,ltf[i-1].h);

    // 回到 OB 後的 1H 型態（在有效範圍內，最新的那根；碰到哪個 OB 就用哪個）
    let eng=-1, ob=obs[0];
    for(let i=n-1;i>=Math.max(start,1) && eng<0;i--){
      if(!isPattern(ltf,i,dir,s)) continue;
      for(const z of obs){ if(z.idx+2>i) continue;
        const touch = dir>0 ? pairLow(i)<=z.hi*1.002 && ltf[i].c>z.lo : pairHigh(i)>=z.lo*0.998 && ltf[i].c<z.hi;
        if(touch){ eng=i; ob=z; break; } }
    }
    res.entryOB=ob;
    st.fvg=!!ob.fvg;
    let stopRaw = dir>0? ob.lo : ob.hi;
    if(eng>=0){
      stopRaw = dir>0? Math.min(ob.lo,pairLow(eng)) : Math.max(ob.hi,pairHigh(eng));
      // 型態之後收盤跌破止損位 → 失效
      let dead=false; for(let i=eng+1;i<n;i++){ if(dir>0? ltf[i].c<stopRaw : ltf[i].c>stopRaw){dead=true;break;} }
      if(!dead){
        st.engulf=true; res.engulf={idx:eng, kind:isEngulf(ltf,eng,dir)?'吞沒':'Pin bar'}; res.sigIdx=eng; st.ema=emaOk(eng);
        st.fib = retr(dir>0? pairLow(eng) : pairHigh(eng))>=s.fibMin; if(st.fib) res.fibIdx=eng;
        // 掃流動性：回到 OB 的過程中，有 K 棒刺破前一個已確認的 1H 低點（做空看高點），型態 K 又收回來
        const pts=(dir>0? L.sw.lo : L.sw.hi);
        for(let j=Math.max(ob.idx+1,eng-W-2);j<=eng && !st.sweep;j++){
          for(const p of pts){ if(p.conf>=j || p.i<j-72) continue;
            if(dir>0? ltf[j].l<p.price && ltf[eng].c>p.price : ltf[j].h>p.price && ltf[eng].c<p.price){ st.sweep=true; res.sweep={idx:j,price:p.price}; break; } } }
      }
    }
    // 止損位置：swing = OB 外面最近的 1H 波段高/低點（已確認的）；leg = 推動起點（斐波 1.0）；ob = OB / 型態 K 外側
    const mode=s.stopMode||'swing';
    if(mode==='swing'){
      const pts=(dir>0? L.sw.lo : L.sw.hi).filter(p=>p.conf<n && (dir>0? p.price<=stopRaw : p.price>=stopRaw));
      const near=pts.sort((x,y)=> dir>0? y.price-x.price : x.price-y.price)[0];
      stopRaw = near? near.price : (dir>0? Math.min(stopRaw,lo) : Math.max(stopRaw,hi));
    } else if(mode==='leg'){
      stopRaw = dir>0? Math.min(stopRaw,lo) : Math.max(stopRaw,hi);
    }
    res.stopBasis={swing:'1H 波段點',leg:'推動起點',ob:'OB 外側'}[mode];
    const entry = st.engulf && s.entry!=='ob' ? ltf[eng].c : (dir>0? ob.hi : ob.lo);
    const stop = dir>0? stopRaw*(1-s.stopBuf/100) : stopRaw*(1+s.stopBuf/100);
    const target = s.target==='htf' ? (dir>0? rHi : rLo) : (dir>0? hi : lo);
    const rr = Math.abs(target-entry)/Math.abs(entry-stop);
    const be = s.beAt>0 ? entry+(target-entry)*s.beAt : null;   // 獲利到這裡 → 止損移到開倉價
    Object.assign(res,{entry,stop,target,rr,be,dist:(last-entry)/entry*100});
    st.rr = rr>=s.minRR && (dir>0? target>entry && stop<entry : target<entry && stop>entry);
    return finish(res,s);
  }
  function finish(r,s){
    const st=r.st;
    const need=['htf','ob','engulf','rr'], bonus=[];
    for(const k of BONUS){ const m=condMode(s,k); if(m==='need') need.push(k); else if(m==='score') bonus.push(k); }
    r.need=need; r.bonus=bonus; r.met=need.filter(k=>st[k]).length;
    r.score=bonus.filter(k=>st[k]).length; r.scoreMax=bonus.length;
    const minScore=Math.min(+s.minScore||0, bonus.length);
    r.status = need.every(k=>st[k]) && r.score>=minScore ? 'trigger' : (st.htf&&st.ob ? 'watch' : 'idle');
    if(r.status==='watch' && need.every(k=>st[k])) r.lowScore=true;   // 條件都到了，只是加分不夠
    // 只做多 / 只做空：反方向的訊號不觸發
    if((s.side==='long' && r.dir<0) || (s.side==='short' && r.dir>0)){ r.sideBlocked=true; if(r.status==='trigger') r.status='watch'; }
    return r;
  }
  // ---- 歷史回測：逐根 1H 收盤往前走，每次只用「當時已收盤」的 K 棒判斷，不偷看未來 ----
  // o: { window: 1H 視窗（跟實盤一樣 300）, htfWindow: 200, maxWait: 幾根內沒進場算過期, feePct: 單邊手續費+滑點 %, btcDirAt(t) }
  function backtest(sym, ltf, htf, s, o={}){
    const W=o.window||300, HW=o.htfWindow||500, maxWait=o.maxWait||24, fee=(o.feePct||0)/100;
    if(ltf.length<W+10 || htf.length<60) return {trades:[], skipped:'資料不足'};
    const bar=ltf[1].t-ltf[0].t, hbar=htf[1].t-htf[0].t, trades=[];
    let hj=0;
    for(let i=W;i<ltf.length;i++){
      if(!isPattern(ltf,i,1,s) && !isPattern(ltf,i,-1,s)) continue;   // 沒有型態就不可能觸發，先跳過省時間
      const closeT=ltf[i].t+bar;
      while(hj<htf.length && htf[hj].t+hbar<=closeT) hj++;      // 只用已收盤的 H4
      if(hj<60) continue;
      const L=ltf.slice(i+1-W,i+1), H=htf.slice(Math.max(0,hj-HW),hj);
      const r=analyze(sym,L,s,H);
      if(r.status!=='trigger' || r.sigIdx!==L.length-1) continue; // 這根收盤時才剛成立的訊號
      const t={sym,dir:r.dir,t:closeT,entry:r.entry,stop:r.stop,target:r.target,rr:r.rr,be:r.be,score:r.score,retr:r.retr,status:'pending'};
      if(o.btcDirAt && sym!=='BTC'){ const b=o.btcDirAt(closeT); if(b && b!==r.dir){ t.againstBtc=true; if(s.btcFilter==='block') continue; } }
      const up=t.dir>0;
      for(let j=i+1;j<ltf.length;j++){
        const b=ltf[j];
        if(t.status==='pending'){
          if(up? b.l<=t.entry : b.h>=t.entry){ t.status='filled'; t.filledT=b.t; }
          else if(up? b.h>=t.target : b.l<=t.target){ t.status='missed'; t.closedT=b.t; break; }
          else if(j-i>maxWait){ t.status='expired'; t.closedT=b.t; break; }
        }
        if(t.status==='filled'){
          const sl=t.beHit? t.entry : t.stop;
          const hitS= up? b.l<=sl : b.h>=sl, hitT= up? b.h>=t.target : b.l<=t.target;
          if(hitS){ t.status=t.beHit?'be':'loss'; t.R=t.beHit?0:-1; t.closedT=b.t+bar; }   // 同一根兩邊都碰到，保守算先打止損
          else if(hitT && b.t>t.filledT){ t.status='win'; t.R=t.rr; t.closedT=b.t+bar; }
          if(t.R!=null) break;
          if(t.be!=null && !t.beHit && b.t>t.filledT && (up? b.h>=t.be : b.l<=t.be)) t.beHit=true;   // 這根收盤後才把止損移到開倉價
        }
      }
      if(t.status==='filled') t.status='open';                        // 資料結束時還沒出結果
      if(t.R!=null && fee){ t.cost=fee*2*t.entry/Math.abs(t.entry-t.stop); t.R-=t.cost; }
      trades.push(t);
    }
    return {trades};
  }
  // BTC H4 在某個時間點的方向（給回測的大盤濾網用）
  function trendSeries(htf, s){
    const H=structure(htf,{...s,swingLen:s.htfSwing}); const hbar=htf[1].t-htf[0].t;
    const pts=H.events.map(e=>({t:htf[e.idx].t+hbar, dir:e.dir}));
    return T=>{ let d=0; for(const p of pts){ if(p.t<=T) d=p.dir; else break; } return d; };
  }

  // 大盤濾網：BTC H4 方向、資金費率（前後端共用）
  function applyContext(r, ctx, s){
    r.flags=[];
    if(!r.dir || !ctx) return r;
    const mode=s.btcFilter||'warn';
    if(mode!=='off' && r.sym!=='BTC' && ctx.btcDir && ctx.btcDir!==r.dir){
      r.flags.push({k:'btc',t:`逆 BTC 大盤（H4 ${ctx.btcDir>0?'多':'空'}）`});
      if(mode==='block' && r.status==='trigger'){ r.status='watch'; r.blocked='BTC 大盤方向相反，訊號被濾掉'; }
    }
    const f=ctx.funding && ctx.funding[r.sym];
    if(f!=null && isFinite(f)){
      r.funding=f; const th=(s.fundingMax==null?0.05:s.fundingMax)/100;
      if(th>0 && r.dir>0 && f>=th) r.flags.push({k:'fund',t:`資金費率 +${(f*100).toFixed(3)}% 多方擁擠`});
      if(th>0 && r.dir<0 && f<=-th) r.flags.push({k:'fund',t:`資金費率 ${(f*100).toFixed(3)}% 空方擁擠`});
    }
    return r;
  }
  return {genSeries,addBar,aggregate,analyze,applyContext,ema,isEngulf,isPin,toDaily,structure,backtest,trendSeries,BONUS};
})();
if(typeof module!=='undefined' && module.exports) module.exports=SMC;
