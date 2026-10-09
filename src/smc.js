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

  // ---- full pipeline for one symbol ----
  // ltf = 15M K 線；htfIn = H4 K 線（後端直接抓 4h，沒給就用 15M 合成）
  function analyze(sym, ltf, s, htfIn){
    const htf = htfIn && htfIn.length ? htfIn : aggregate(ltf,16);
    const H=structure(htf,{...s,swingLen:s.htfSwing});
    const L=structure(ltf,s);
    const dir=H.trend; const last=ltf[ltf.length-1].c;
    const st={htf:false,pd:false,poi:false,sweep:false,choch:false,ob:false,fvg:false,rr:false};
    const res={sym,dir,last,st,htf,ltf,H,L};
    if(!dir) return finish(res,s);
    st.htf=true;
    const lastEv=[...H.events].reverse().find(e=>e.dir===dir);
    let rHi=-Infinity,rLo=Infinity;
    for(let i=lastEv.from;i<htf.length;i++){rHi=Math.max(rHi,htf[i].h);rLo=Math.min(rLo,htf[i].l);}
    const eq=(rHi+rLo)/2; res.range={hi:rHi,lo:rLo,eq};
    st.pd = dir>0 ? last<eq : last>eq;
    const pois=H.events.filter(e=>e.dir===dir && !e.ob.broken && (dir>0? e.ob.hi<=eq*1.002 : e.ob.lo>=eq*0.998));
    const poi=pois[pois.length-1]; if(!poi) return finish(res,s);
    st.poi=true; res.poi=poi.ob;
    // map POI time onto LTF
    const W=Math.min(s.lookback, ltf.length-1); const start=ltf.length-W;
    const inPoi=i=> dir>0 ? ltf[i].l<=poi.ob.hi*1.001 : ltf[i].h>=poi.ob.lo*0.999;
    // sweep: wick through a prior LTF swing point, close back inside, while at POI
    const pts = dir>0? L.sw.lo : L.sw.hi;
    let sweep=null;
    for(let i=ltf.length-1;i>=start;i--){
      if(!inPoi(i)) continue;
      const prev=pts.filter(p=>p.conf<i && p.i>=i-120);
      for(const p of prev.reverse()){
        if(dir>0 ? (ltf[i].l<p.price && ltf[i].c>p.price) : (ltf[i].h>p.price && ltf[i].c<p.price)){ sweep={idx:i,level:p.price,ext:dir>0?ltf[i].l:ltf[i].h,swingIdx:p.i}; break; }
      }
      if(sweep)break;
    }
    if(sweep){st.sweep=true;res.sweep=sweep;}
    const after = sweep? sweep.idx : start;
    const ch=L.events.find(e=>e.dir===dir && e.idx>after && (e.type==='CHoCH' || !s.needChoch));
    if(ch){ st.choch = ch.type==='CHoCH'; res.choch=ch;
      if(!ch.ob.broken){ st.ob=true; res.entryOB=ch.ob; st.fvg=ch.ob.fvg; } }
    if(res.entryOB){
      const ob=res.entryOB;
      const entry = dir>0? ob.hi : ob.lo;
      const ext = sweep? sweep.ext : (dir>0? ob.lo : ob.hi);
      const stop = dir>0? Math.min(ext,ob.lo)*(1-s.stopBuf/100) : Math.max(ext,ob.hi)*(1+s.stopBuf/100);
      let target = dir>0? rHi : rLo;
      if(s.target==='ltf'){ // nearest unswept LTF liquidity beyond entry
        const pool=(dir>0? L.sw.hi : L.sw.lo).filter(p=>p.i>ltf.length-300);
        const ref = dir>0? Math.max(entry,ch.level) : Math.min(entry,ch.level);
        const cand=pool.filter(p=>dir>0? p.price>ref*1.001 : p.price<ref*0.999).map(p=>p.price).sort((a,b)=>dir>0?a-b:b-a);
        if(cand.length) target=cand[0];
      }
      const rr = Math.abs(target-entry)/Math.abs(entry-stop);
      Object.assign(res,{entry,stop,target,rr,dist:(last-entry)/entry*100});
      st.rr = rr>=s.minRR && (dir>0? target>entry : target<entry);
    }
    return finish(res,s);
  }
  function finish(r,s){
    const st=r.st;
    const need=['htf','pd','poi','ob','rr']; if(s.needSweep)need.push('sweep'); if(s.needChoch)need.push('choch'); if(s.needFvg)need.push('fvg');
    r.need=need; r.met=need.filter(k=>st[k]).length;
    r.status = need.every(k=>st[k]) ? 'trigger' : (st.htf&&st.pd&&st.poi ? 'watch' : 'idle');
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
  return {genSeries,addBar,aggregate,analyze,applyContext};
})();
if(typeof module!=='undefined' && module.exports) module.exports=SMC;
