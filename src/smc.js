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

  // ---- 策略：H4 找趨勢 → 1H 斐波便宜區裡的 OB → 1H 吞沒 K + EMA50 順勢 ----
  // ltf = 1H K 線；htfIn = H4 K 線（沒給就用 1H 合成）
  function analyze(sym, ltf, s, htfIn){
    const htf = htfIn && htfIn.length ? htfIn : aggregate(ltf,4);
    const H=structure(htf,{...s,swingLen:s.htfSwing});
    const L=structure(ltf,s);
    const dir=H.trend; const n=ltf.length, last=ltf[n-1].c;
    const st={htf:false,fib:false,ob:false,engulf:false,ema:false,rr:false};
    const res={sym,dir,last,st,htf,ltf,H,L,emaLine:ema(ltf,s.emaLen||50)};
    if(!dir) return finish(res,s);
    st.htf=true;
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

    // 便宜區裡、未失效的順勢 1H OB（取最近的）
    const obs=L.events.filter(e=>e.dir===dir && !e.ob.broken).map(e=>e.ob)
      .filter(ob=> dir>0 ? (ob.lo>=lo*0.998 && retr(ob.hi)>=s.fibMin) : (ob.hi<=hi*1.002 && retr(ob.lo)>=s.fibMin));
    const ob=obs.sort((x,y)=>y.idx-x.idx)[0];
    const emaAt=i=>res.emaLine[i];
    const emaOk=i=> emaAt(i)!=null && (dir>0? ltf[i].c>emaAt(i) : ltf[i].c<emaAt(i));
    st.ema=emaOk(n-1);
    if(!ob) return finish(res,s);
    st.ob=true; res.entryOB=ob;

    // 回到 OB 後的 1H 吞沒（在有效範圍內，最新的那根）
    let eng=-1;
    for(let i=n-1;i>=Math.max(start,ob.idx+2);i--){
      if(!isEngulf(ltf,i,dir)) continue;
      const touch = dir>0 ? Math.min(ltf[i].l,ltf[i-1].l)<=ob.hi*1.002 && ltf[i].c>ob.lo
                          : Math.max(ltf[i].h,ltf[i-1].h)>=ob.lo*0.998 && ltf[i].c<ob.hi;
      if(touch){ eng=i; break; }
    }
    const pairLow = i=> Math.min(ltf[i].l,ltf[i-1].l), pairHigh = i=> Math.max(ltf[i].h,ltf[i-1].h);
    let stopRaw = dir>0? ob.lo : ob.hi;
    if(eng>=0){
      stopRaw = dir>0? Math.min(ob.lo,pairLow(eng)) : Math.max(ob.hi,pairHigh(eng));
      // 吞沒之後收盤跌破止損位 → 這個吞沒失效
      let dead=false; for(let i=eng+1;i<n;i++){ if(dir>0? ltf[i].c<stopRaw : ltf[i].c>stopRaw){dead=true;break;} }
      if(!dead){ st.engulf=true; res.engulf={idx:eng}; res.sigIdx=eng; st.ema=emaOk(eng); }
    }
    const entry = st.engulf && s.entry!=='ob' ? ltf[eng].c : (dir>0? ob.hi : ob.lo);
    const stop = dir>0? stopRaw*(1-s.stopBuf/100) : stopRaw*(1+s.stopBuf/100);
    const target = s.target==='htf' ? (dir>0? rHi : rLo) : (dir>0? hi : lo);
    const rr = Math.abs(target-entry)/Math.abs(entry-stop);
    Object.assign(res,{entry,stop,target,rr,dist:(last-entry)/entry*100});
    st.rr = rr>=s.minRR && (dir>0? target>entry && stop<entry : target<entry && stop>entry);
    return finish(res,s);
  }
  function finish(r,s){
    const st=r.st;
    const need=['htf','fib','ob','engulf','rr']; if(s.needEma!==false) need.splice(4,0,'ema');
    r.need=need; r.met=need.filter(k=>st[k]).length;
    r.status = need.every(k=>st[k]) ? 'trigger' : (st.htf&&st.fib&&st.ob ? 'watch' : 'idle');
    return r;
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
  return {genSeries,addBar,aggregate,analyze,applyContext,ema,isEngulf};
})();
if(typeof module!=='undefined' && module.exports) module.exports=SMC;
