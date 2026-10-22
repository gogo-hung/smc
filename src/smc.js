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
    for(let i=Math.max(k+2,2);i<=ev.idx;i++){ if(ev.dir>0? c[i].l>c[i-2].h : c[i].h<c[i-2].l){
      z.fvg=true; z.fz= ev.dir>0? {lo:c[i-2].h, hi:c[i].l, idx:i} : {lo:c[i].h, hi:c[i-2].l, idx:i}; break; } }
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

  // 品質分數 0–100：用 1 年回測找出「跟賺錢真的有關」的特徵（前後半年都成立）
  // 止損空間（OB 夠大，不容易被雜訊掃掉）35、吞沒實體 20、成交量放大 20、回撤沒太深 15、日線同向 10
  const clamp=x=>Math.max(0,Math.min(1,x));
  function quality(f){
    if(!f) return null;
    const parts=[
      {k:'stop', n:'止損空間', w:35, v:clamp((f.stopAtr-0.8)/1.2), t:`${f.stopAtr.toFixed(2)} ATR`},
      {k:'body', n:'吞沒實體', w:20, v:clamp((f.body-0.2)/0.6), t:`${f.body.toFixed(2)} ATR`},
      {k:'vol',  n:'成交量',   w:20, v:clamp((f.vol-0.7)/0.6), t:`${f.vol.toFixed(2)} 倍均量`},
      {k:'retr', n:'回撤深度', w:15, v:clamp((0.98-f.retr)/0.05), t:`${(f.retr*100).toFixed(0)}%`},
      {k:'daily',n:'日線同向', w:10, v:f.daily?1:0, t:f.daily?'是':'否'},
    ];
    const score=Math.round(parts.reduce((a,p)=>a+p.w*p.v,0));
    return {score, grade: score>=70?'S':score>=55?'A':score>=40?'B':'C', parts};
  }
  // 加分條件：每項可以設成 need（必要）/ score（加分）/ off（不看）
  const BONUS=['fib','ema','fvg','sweep','daily'];
  const condMode=(s,k)=>{ const v=s['c'+k[0].toUpperCase()+k.slice(1)]; if(v) return v;
    if(k==='fib') return 'need'; if(k==='ema') return s.needEma===false?'off':'need'; return 'off'; }; // 舊設定相容

  // ---- 策略：日線 / H4 找趨勢 → 1H 結構裡的 OB → 1H 型態（吞沒 / Pin bar）；斐波、EMA、FVG、掃流動性、日線同向 = 加分 ----
  // ltf = 1H K 線；htfIn = H4 K 線（沒給就用 1H 合成）
  function analyze(sym, ltf, s, htfIn){
    if(s.model==='bf') return analyzeBF(sym, ltf, s, htfIn);
    if(s.model==='mtf') return analyzeMTF(sym, ltf, s, htfIn);
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

    // FVG 有沒有被收盤穿過（做多：收盤跌破 FVG 下緣）
    const fvgOn = s.fvgEntry==='on';
    const fvgBroken=(z,upto)=>{ for(let j=z.fz.idx+1;j<upto;j++){ if(dir>0? ltf[j].c<z.fz.lo : ltf[j].c>z.fz.hi) return true; } return false; };
    // 回到 FVG / OB 後的 1H 型態（在有效範圍內，最新的那根）
    // OB 帶 FVG 時先看 FVG：FVG 沒被收盤穿過、型態碰到 FVG → 從 FVG 進場；FVG 被穿過就改看 OB
    let eng=-1, ob=obs[0], zone='ob';
    for(let i=n-1;i>=Math.max(start,1) && eng<0;i--){
      if(!isPattern(ltf,i,dir,s)) continue;
      for(const z of obs){ if(z.idx+2>i) continue;
        if(fvgOn && z.fz && z.fz.idx+1<i && !fvgBroken(z,i)){
          const f=z.fz, tf= dir>0 ? pairLow(i)<=f.hi*1.002 && ltf[i].c>f.lo : pairHigh(i)>=f.lo*0.998 && ltf[i].c<f.hi;
          if(tf){ eng=i; ob=z; zone='fvg'; break; }
        }
        const touch = dir>0 ? pairLow(i)<=z.hi*1.002 && ltf[i].c>z.lo : pairHigh(i)>=z.lo*0.998 && ltf[i].c<z.hi;
        if(touch){ eng=i; ob=z; zone='ob'; break; } }
    }
    res.entryOB=ob; res.zone=zone;
    if(fvgOn && ob.fz){ res.fvgZone=ob.fz;
      res.fvgState = eng>=0 && zone==='fvg' ? 'entry' : fvgBroken(ob,n) ? 'broken' : (dir>0? Math.min(...ltf.slice(ob.fz.idx+1).map(b=>b.l))<=ob.fz.hi : Math.max(...ltf.slice(ob.fz.idx+1).map(b=>b.h))>=ob.fz.lo) ? 'testing' : 'waiting'; }
    st.fvg=!!ob.fvg;
    let stopRaw = dir>0? ob.lo : ob.hi;
    if(eng>=0){
      stopRaw = zone==='fvg' && s.fvgStop!=='ob' ? (dir>0? Math.min(ob.fz.lo,pairLow(eng)) : Math.max(ob.fz.hi,pairHigh(eng)))
                                                  : (dir>0? Math.min(ob.lo,pairLow(eng)) : Math.max(ob.hi,pairHigh(eng)));
      // 型態之後收盤跌破止損位 → 失效
      let dead=false; for(let i=eng+1;i<n;i++){ if(dir>0? ltf[i].c<stopRaw : ltf[i].c>stopRaw){dead=true;break;} }
      if(!dead){
        st.engulf=true; res.engulf={idx:eng, kind:isEngulf(ltf,eng,dir)?'吞沒':'Pin bar'}; res.sigIdx=eng; st.ema=emaOk(eng);
        const fibTh = zone==='fvg' && +s.fvgFib>0 ? +s.fvgFib : s.fibMin;   // fvgFib 0 = 跟 OB 用同一個斐波門檻
        st.fib = retr(dir>0? pairLow(eng) : pairHigh(eng))>=fibTh; if(st.fib) res.fibIdx=eng;
        // 掃流動性：回到 OB 的過程中，有 K 棒刺破前一個已確認的 1H 低點（做空看高點），型態 K 又收回來
        const pts=(dir>0? L.sw.lo : L.sw.hi);
        for(let j=Math.max(ob.idx+1,eng-W-2);j<=eng && !st.sweep;j++){
          for(const p of pts){ if(p.conf>=j || p.i<j-72) continue;
            if(dir>0? ltf[j].l<p.price && ltf[eng].c>p.price : ltf[j].h>p.price && ltf[eng].c<p.price){ st.sweep=true; res.sweep={idx:j,price:p.price}; break; } } }
      }
    }
    // 止損位置：swing = OB 外面最近的 1H 波段高/低點（已確認的）；leg = 推動起點（斐波 1.0）；ob = OB / 型態 K 外側
    const mode= zone==='fvg' && s.fvgStop!=='ob' ? 'fvg' : (s.stopMode||'swing');
    if(mode==='swing'){
      const pts=(dir>0? L.sw.lo : L.sw.hi).filter(p=>p.conf<n && (dir>0? p.price<=stopRaw : p.price>=stopRaw));
      const near=pts.sort((x,y)=> dir>0? y.price-x.price : x.price-y.price)[0];
      stopRaw = near? near.price : (dir>0? Math.min(stopRaw,lo) : Math.max(stopRaw,hi));
    } else if(mode==='leg'){
      stopRaw = dir>0? Math.min(stopRaw,lo) : Math.max(stopRaw,hi);
    }
    res.stopBasis={swing:'1H 波段點',leg:'推動起點',ob:'OB 外側',fvg:'FVG 外側'}[mode];
    const entry = st.engulf && s.entry!=='ob' ? ltf[eng].c : (zone==='fvg'? (dir>0? ob.fz.hi : ob.fz.lo) : (dir>0? ob.hi : ob.lo));
    const stop = dir>0? stopRaw*(1-s.stopBuf/100) : stopRaw*(1+s.stopBuf/100);
    const target = s.target==='htf' ? (dir>0? rHi : rLo) : (dir>0? hi : lo);
    const rr = Math.abs(target-entry)/Math.abs(entry-stop);
    const be = s.beAt>0 ? entry+(target-entry)*s.beAt : null;   // 獲利到這裡 → 止損移到開倉價
    Object.assign(res,{entry,stop,target,rr,be,dist:(last-entry)/entry*100});
    if(eng>=0){   // 訊號特徵（算品質分數用）
      const atr=(()=>{ let a=0,k=0; for(let i=Math.max(1,eng-13);i<=eng;i++){ a+=Math.max(ltf[i].h-ltf[i].l,Math.abs(ltf[i].h-ltf[i-1].c),Math.abs(ltf[i].l-ltf[i-1].c)); k++; } return a/k||1; })();
      let v=0,vk=0; for(let i=Math.max(0,eng-20);i<eng;i++){ v+=ltf[i].v; vk++; }
      const e=emaAt(eng);
      res.feat={ rr, retr: retr(dir>0? pairLow(eng) : pairHigh(eng)), sweep:st.sweep?1:0, daily:st.daily?1:0,
        vol: vk&&v? ltf[eng].v/(v/vk) : 1, body: Math.abs(ltf[eng].c-ltf[eng].o)/atr, emaDist: e? Math.abs(ltf[eng].c-e)/atr : 0,
        obSize:(ob.hi-ob.lo)/atr, stopAtr:Math.abs(entry-stop)/atr, legAtr:span/atr, obAge: eng-ob.idx,
        htfPos: (dir>0? (entry-rLo)/((rHi-rLo)||1) : (rHi-entry)/((rHi-rLo)||1)) };
    }
    res.quality=quality(res.feat);
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
    if(r.status==='trigger' && s.minQuality>0 && (!r.quality || r.quality.score<s.minQuality)){ r.status='watch'; r.lowQuality=true; }
    // 只做多 / 只做空：反方向的訊號不觸發
    if((s.side==='long' && r.dir<0) || (s.side==='short' && r.dir>0)){ r.sideBlocked=true; if(r.status==='trigger') r.status='watch'; }
    return r;
  }
  // ==== 策略 BF：H4 趨勢 → 1H 順勢 BOS（推動留下 FVG）→ 價格在折價區回到 FVG 中間掛單；止損 OB 外；固定 R 目標 ====
  // 1 年回測（BingX 前 60 名、同一幣一次一單）：勝率約 45%、每筆 +0.27R、最大回撤 −8R、多空都賺
  function htfRange(H, htf, dir){
    const ev=[...H.events].reverse().find(e=>e.dir===dir); if(!ev) return null;
    let hi=-Infinity, lo=Infinity; for(let i=ev.from;i<htf.length;i++){ hi=Math.max(hi,htf[i].h); lo=Math.min(lo,htf[i].l); }
    return {hi,lo,eq:(hi+lo)/2};
  }
  function bfLevels(ev, dir, rg, s){
    const f=ev.ob.fz, entry= s.bfEntry==='edge'? (dir>0? f.hi : f.lo) : (f.lo+f.hi)/2;
    const stop=(dir>0? ev.ob.lo : ev.ob.hi)*(1-dir*(s.stopBuf==null?0.2:+s.stopBuf)/100);
    const risk=Math.abs(entry-stop);
    const target= s.bfTarget==='htf' ? (dir>0? rg.hi : rg.lo) : entry+dir*risk*(+s.tpR||2);
    return {entry, stop, target, risk, rr: risk>0? Math.abs(target-entry)/risk : 0};
  }
  function analyzeBF(sym, ltf, s, htfIn){
    const htf = htfIn && htfIn.length ? htfIn : aggregate(ltf,4);
    const H=structure(htf,{...s,swingLen:s.htfSwing}), L=structure(ltf,s);
    const dir=H.trend, n=ltf.length, last=ltf[n-1].c;
    const st={htf:false,bos:false,fvg:false,pd:false,ema:false,rr:false,live:false};
    const res={sym,dir,last,st,htf,ltf,H,L,emaLine:ema(ltf,s.emaLen||50),model:'bf',bonus:[],score:0,scoreMax:0};
    if(!dir) return finishBF(res,s);
    st.htf=true;
    const rg=htfRange(H,htf,dir); res.range=rg;
    const ev=[...L.events].reverse().find(e=>e.dir===dir && e.type==='BOS');
    if(!ev) return finishBF(res,s);
    st.bos=true; res.bos={idx:ev.idx, level:ev.level, age:n-1-ev.idx}; res.entryOB=ev.ob; res.sigIdx=ev.idx;
    if(!ev.ob.fz) return finishBF(res,s);
    st.fvg=true; res.fvgZone=ev.ob.fz; res.zone='fvg';
    const lv=bfLevels(ev,dir,rg,s), e=res.emaLine[ev.idx];
    st.pd = dir>0? lv.entry<=rg.eq : lv.entry>=rg.eq;
    st.ema = e!=null && (dir>0? ltf[ev.idx].c>e : ltf[ev.idx].c<e);
    st.rr = lv.risk>0 && (dir>0? lv.stop<lv.entry && lv.target>lv.entry : lv.stop>lv.entry && lv.target<lv.entry) && (s.bfTarget!=='htf' || lv.rr>=s.minRR);
    // BOS 之後：有沒有成交、打到止損 / 目標、或沒成交就先跑到目標（錯過）
    let filled=-1, gone=null;
    for(let j=ev.idx+1;j<n;j++){ const b=ltf[j];
      if(filled<0){ if(dir>0? b.l<=lv.entry : b.h>=lv.entry) filled=j; else if(dir>0? b.h>=lv.target : b.l<=lv.target){ gone='missed'; break; } else if(j-ev.idx>(s.bfWait||24)){ gone='expired'; break; } }
      if(filled>=0){ if(dir>0? b.l<=lv.stop : b.h>=lv.stop){ gone='stopped'; break; } if(j>filled && (dir>0? b.h>=lv.target : b.l<=lv.target)){ gone='done'; break; } }
    }
    if(filled<0 && !gone && n-1-ev.idx>(s.bfWait||24)) gone='expired';
    res.filledIdx=filled; res.gone=gone; st.live=!gone; res.waitMs=(s.bfWait||24)*(ltf[1].t-ltf[0].t);
    Object.assign(res,{entry:lv.entry, stop:lv.stop, target:lv.target, rr:lv.rr, be: s.beAt>0 && !(s.p1>0)? lv.entry+(lv.target-lv.entry)*s.beAt : null,
      p1: s.p1>0? lv.entry+dir*lv.risk*s.p1 : null, p1R: s.p1>0? +s.p1 : null, dist:(last-lv.entry)/lv.entry*100});
    return finishBF(res,s);
  }
  function finishBF(r,s){
    const need=['htf','bos','fvg','pd','ema','rr','live'].filter(k=>!(k==='ema'&&s.bfEma==='off') && !(k==='pd'&&s.bfPd==='off'));
    r.need=need; r.met=need.filter(k=>r.st[k]).length;
    r.status = need.every(k=>r.st[k]) ? 'trigger' : (r.st.htf && r.st.bos && r.st.fvg ? 'watch' : 'idle');
    if((s.side==='long' && r.dir<0) || (s.side==='short' && r.dir>0)){ r.sideBlocked=true; if(r.status==='trigger') r.status='watch'; }
    return r;
  }
  // BF 回測：結構一次算好（逐根都只看已收盤的資料），同一幣一次只做一單
  function backtestBF(sym, ltf, htf, s, o={}){
    if(ltf.length<350 || htf.length<60) return {trades:[], skipped:'資料不足'};
    const fee=(o.feePct||0)/100, bar=ltf[1].t-ltf[0].t, hbar=htf[1].t-htf[0].t;
    const L=structure(ltf,s), Hs=structure(htf,{...s,swingLen:s.htfSwing}), em=ema(ltf,s.emaLen||50);
    const hev=Hs.events.map(e=>({T:htf[e.idx].t+hbar, dir:e.dir, from:e.from, idx:e.idx}));
    const trades=[]; let busy=-1;
    for(const ev of L.events){
      const i=ev.idx; if(i<300 || ev.type!=='BOS' || !ev.ob.fz || i<=busy) continue;
      const T=ltf[i].t+bar; let k=-1; for(let a=0;a<hev.length && hev[a].T<=T;a++) k=a; if(k<0 || hev[k].dir!==ev.dir) continue;
      const dir=ev.dir, he=hev[k]; let lastH=he.idx; while(lastH+1<htf.length && htf[lastH+1].t+hbar<=T) lastH++;
      let hi=-Infinity, lo=Infinity; for(let j=he.from;j<=lastH;j++){ hi=Math.max(hi,htf[j].h); lo=Math.min(lo,htf[j].l); }
      const rg={hi,lo,eq:(hi+lo)/2}, lv=bfLevels(ev,dir,rg,s);
      if(s.bfPd!=='off' && !(dir>0? lv.entry<=rg.eq : lv.entry>=rg.eq)) continue;
      if(s.bfEma!=='off' && !(em[i]!=null && (dir>0? ltf[i].c>em[i] : ltf[i].c<em[i]))) continue;
      if(!(lv.risk>0) || (dir>0? lv.stop>=lv.entry : lv.stop<=lv.entry) || (s.bfTarget==='htf' && lv.rr<s.minRR)) continue;
      if((s.side==='long'&&dir<0)||(s.side==='short'&&dir>0)) continue;
      const t={sym,dir,t:T,entry:lv.entry,stop:lv.stop,target:lv.target,rr:lv.rr,zone:'fvg',status:'pending'};
      const p1=+s.p1>0? +s.p1 : 0; let got=0, size=1, p1Hit=false;
      if(o.btcDirAt && sym!=='BTC'){ const b=o.btcDirAt(T); if(b && b!==dir){ t.againstBtc=true; if(s.btcFilter==='block') continue; } }
      const up=dir>0; let fill=-1, sl=t.stop, beHit=false, end=ltf.length;
      for(let j=i+1;j<ltf.length;j++){ const b=ltf[j];
        if(fill<0){
          if(j-i>(s.bfWait||24)){ t.status='expired'; end=j; break; }
          if(up? b.l<=t.entry : b.h>=t.entry){ fill=j; t.status='filled'; t.filledT=b.t; }
          else if(up? b.h>=t.target : b.l<=t.target){ t.status='missed'; end=j; break; }
        }
        if(fill>=0){
          if(up? b.l<=sl : b.h>=sl){ t.R=got+size*(sl-t.entry)*dir/Math.abs(t.entry-t.stop); t.status= p1Hit? 'tp1' : beHit? 'be' : 'loss'; t.closedT=b.t+bar; end=j; break; }
          if(p1 && !p1Hit && j>fill && (up? b.h>=t.entry+(t.entry-t.stop)*p1 : b.l<=t.entry-(t.stop-t.entry)*p1)){ p1Hit=true; got=0.5*p1; size=0.5; sl=t.entry; }
          if(j>fill && (up? b.h>=t.target : b.l<=t.target)){ t.status='win'; t.R=got+size*t.rr; t.closedT=b.t+bar; end=j; break; }
          if(!p1 && s.beAt>0 && !beHit && j>fill && (up? b.h>=t.entry+(t.target-t.entry)*s.beAt : b.l<=t.entry-(t.entry-t.target)*s.beAt)){ beHit=true; sl=t.entry; }
        }
      }
      if(t.status==='filled'){ t.status='open'; }
      busy=end;
      if(t.R!=null && fee){ t.cost=fee*2*t.entry/Math.abs(t.entry-t.stop); t.R-=t.cost; }
      trades.push(t);
    }
    return {trades};
  }
  // ==== 策略 MTF：4H 結構找順勢 OB / FVG → 價格回到 4H 區域 → 15M CHoCH 換方向（推動留下 FVG）→ 15M 推動拉斐波，0.715 掛單；止損前低、止盈前高 ====
  // ltf 這裡傳 15M K 線，htf 傳 4H
  function poisAt(Hs, htf, dir, k, s){   // 截至第 k 根 4H（已收盤）還有效的順勢 OB / FVG
    const out=[];
    // mtfPoiSrc='choch'：只用讓這段趨勢成立的那次 4H 結構轉換（CHoCH）留下的 OB / FVG
    const evs= s.mtfPoiSrc==='choch' ? Hs.events.filter(e=>e.dir===dir && e.idx<=k && e.type==='CHoCH').slice(-1)
                                     : Hs.events.filter(e=>e.dir===dir && e.idx<=k).slice(-(s.mtfPois||6));
    for(const e of evs){
      const zs=[{kind:'OB',lo:e.ob.lo,hi:e.ob.hi,idx:e.ob.idx}]; if(e.ob.fz) zs.push({kind:'FVG',lo:e.ob.fz.lo,hi:e.ob.fz.hi,idx:e.ob.fz.idx});
      for(const z of zs){ let dead=false; for(let j=Math.max(z.idx+1,e.idx+1);j<=k;j++){ if(dir>0? htf[j].c<z.lo : htf[j].c>z.hi){ dead=true; break; } } if(!dead) out.push(z); }
    }
    return out;
  }
  const inZone=(z,dir,p)=> dir>0 ? p<=z.hi && p>=z.lo-(z.hi-z.lo)*0.5 : p>=z.lo && p<=z.hi+(z.hi-z.lo)*0.5;
  function mtfSetup(L15, e, n, s){   // CHoCH 那段推動：起點（前低）、目前的推動高點、0.715 掛單價
    const c=L15, dir=e.dir; let m=e.from; for(let j=e.from;j<=e.idx;j++) if(dir>0? c[j].l<c[m].l : c[j].h>c[m].h) m=j;
    const lo= dir>0? c[m].l : c[m].h;
    return {m, lo};
  }
  function mtfLevels(lo, hi, dir, s, rg){
    const fe=+s.mtfFib||0.715, span=Math.abs(hi-lo);
    const entry= dir>0? hi-span*fe : hi+span*fe;   // dir<0 時 hi 代表推動低點
    const stop= lo*(1-dir*(s.stopBuf==null?0.2:+s.stopBuf)/100), target= s.mtfTarget==='htf' && rg ? (dir>0? Math.max(hi,rg.hi) : Math.min(hi,rg.lo)) : hi;
    const risk=Math.abs(entry-stop);
    return {entry, stop, target, risk, rr: risk>0? Math.abs(target-entry)/risk : 0};
  }
  function analyzeMTF(sym, ltf, s, htfIn){
    const htf=htfIn||[], H=structure(htf,{...s,swingLen:s.htfSwing}), L=structure(ltf,{...s,swingLen:s.mtfSwing||3});
    const dir=H.trend, n=ltf.length, last=ltf[n-1].c;
    const st={htf:false,poi:false,choch:false,fvg15:false,rr:false,live:false};
    const res={sym,dir,last,st,htf,ltf,H,L,emaLine:ema(ltf,s.emaLen||50),model:'mtf',bonus:[],score:0,scoreMax:0,tf:'15M'};
    if(!dir || htf.length<30) return finishMTF(res,s);
    st.htf=true;
    const pois=poisAt(H,htf,dir,htf.length-1,s); res.pois=pois; const rg=htfRange(H,htf,dir); res.range=rg;
    const e=[...L.events].reverse().find(x=>x.dir===dir && x.type==='CHoCH');
    if(!e) { res.inPoi=pois.find(z=>inZone(z,dir,dir>0? Math.min(...ltf.slice(-16).map(b=>b.l)) : Math.max(...ltf.slice(-16).map(b=>b.h)))); return finishMTF(res,s); }
    st.choch=true; res.choch={idx:e.idx, level:e.level, age:n-1-e.idx}; res.sigIdx=e.idx; res.entryOB=e.ob;
    const {m, lo}=mtfSetup(ltf,e,n,s);
    const poi=pois.find(z=>inZone(z,dir,lo)); st.poi=!!poi; res.poi=poi||null;
    st.fvg15=!!e.ob.fz || s.mtfFvg==='off'; if(e.ob.fz) res.fvgZone=e.ob.fz;
    // 推動高點：CHoCH 之後如果再創高，斐波跟著更新（成交前）
    let hi= dir>0? -Infinity : Infinity; for(let j=m;j<=e.idx;j++) hi= dir>0? Math.max(hi,ltf[j].h) : Math.min(hi,ltf[j].l);
    let lv=mtfLevels(lo,hi,dir,s,rg), filled=-1, gone=null, hiAtFill=null;
    for(let j=e.idx+1;j<n;j++){ const b=ltf[j];
      if(filled<0){
        if(j-e.idx>(s.mtfWait||48)){ gone='expired'; break; }
        if(dir>0? b.l<=lv.entry : b.h>=lv.entry){ filled=j; hiAtFill=lv.target; }
        else if(dir>0? b.c<lo : b.c>lo){ gone='invalid'; break; }
        else if(s.mtfReanchor!=='off' && (dir>0? b.h>hi : b.l<hi)){ hi= dir>0? b.h : b.l; lv=mtfLevels(lo,hi,dir,s,rg); }
      }
      if(filled>=0){ if(dir>0? b.l<=lv.stop : b.h>=lv.stop){ gone='stopped'; break; } if(j>filled && (dir>0? b.h>=lv.target : b.l<=lv.target)){ gone='done'; break; } }
    }
    if(filled<0 && !gone && n-1-e.idx>(s.mtfWait||48)) gone='expired';
    res.filledIdx=filled; res.gone=gone; st.live=!gone;
    st.rr= lv.risk>0 && lv.rr>=(+s.mtfMinRR||1.5) && Math.abs(lv.entry-lv.stop)/lv.entry*100>=(+s.mtfMinStop||0);
    res.fib={lo: dir>0? lo:hi, hi: dir>0? hi:lo, from:m, to:n-1, levels:[0,0.5,+s.mtfFib||0.715,1].map(r=>({r, p: dir>0? hi-(hi-lo)*r : hi+(lo-hi)*r}))};
    Object.assign(res,{entry:lv.entry, stop:lv.stop, target:lv.target, rr:lv.rr, p1: s.p1>0? lv.entry+dir*lv.risk*s.p1 : null, p1R: s.p1>0? +s.p1 : null,
      be: s.beAt>0 && !(s.p1>0)? lv.entry+(lv.target-lv.entry)*s.beAt : null, dist:(last-lv.entry)/lv.entry*100, stopBasis:'前低', zone:'fib',
      waitMs:(s.mtfWait||48)*(ltf[1].t-ltf[0].t), legLo:lo});
    return finishMTF(res,s);
  }
  function finishMTF(r,s){
    const need=['htf','poi','choch','fvg15','rr','live'];
    r.need=need; r.met=need.filter(k=>r.st[k]).length;
    r.status = need.every(k=>r.st[k]) ? 'trigger' : (r.st.htf && (r.st.poi || r.inPoi) ? 'watch' : 'idle');
    if((s.side==='long' && r.dir<0) || (s.side==='short' && r.dir>0)){ r.sideBlocked=true; if(r.status==='trigger') r.status='watch'; }
    return r;
  }
  // MTF 回測：結構一次算好（只用已收盤資料），同一幣一次一單
  function backtestMTF(sym, ltf, htf, s, o={}){
    if(ltf.length<500 || htf.length<60) return {trades:[], skipped:'資料不足'};
    const fee=(o.feePct||0)/100, bar=ltf[1].t-ltf[0].t, hbar=htf[1].t-htf[0].t;
    const L=structure(ltf,{...s,swingLen:s.mtfSwing||3}), Hs=structure(htf,{...s,swingLen:s.htfSwing});
    const trades=[]; let busy=-1, hk=-1;
    for(const e of L.events){
      const i=e.idx; if(i<300 || e.type!=='CHoCH' || i<=busy) continue;
      if(s.mtfFvg!=='off' && !e.ob.fz) continue;
      const T=ltf[i].t+bar; while(hk+1<htf.length && htf[hk+1].t+hbar<=T) hk++; if(hk<30) continue;
      let hd=0; for(const he of Hs.events){ if(he.idx>hk) break; hd=he.dir; } if(hd!==e.dir) continue;
      const dir=e.dir; if((s.side==='long'&&dir<0)||(s.side==='short'&&dir>0)) continue;
      const {m, lo}=mtfSetup(ltf,e,ltf.length,s);
      const poi=poisAt(Hs,htf,dir,hk,s).find(z=>inZone(z,dir,lo)); if(!poi) continue;
      let hi= dir>0? -Infinity : Infinity; for(let j=m;j<=i;j++) hi= dir>0? Math.max(hi,ltf[j].h) : Math.min(hi,ltf[j].l);
      let rg=null; { const ev=[...Hs.events].filter(x=>x.idx<=hk && x.dir===dir).pop(); if(ev){ let a=-Infinity,b=Infinity; for(let j=ev.from;j<=hk;j++){ a=Math.max(a,htf[j].h); b=Math.min(b,htf[j].l); } rg={hi:a,lo:b}; } }
      let lv=mtfLevels(lo,hi,dir,s,rg);
      const t={sym,dir,t:T,entry:lv.entry,stop:lv.stop,target:lv.target,rr:lv.rr,zone:'fib',poi:poi.kind,status:'pending'};
      if(o.btcDirAt && sym!=='BTC'){ const b=o.btcDirAt(T); if(b && b!==dir){ t.againstBtc=true; if(s.btcFilter==='block') continue; } }
      const up=dir>0, p1=+s.p1>0? +s.p1 : 0; let fill=-1, sl=0, got=0, size=1, p1Hit=false, beHit=false, end=ltf.length;
      for(let j=i+1;j<ltf.length;j++){ const b=ltf[j];
        if(fill<0){
          if(j-i>(s.mtfWait||48)){ t.status='expired'; end=j; break; }
          if(up? b.l<=lv.entry : b.h>=lv.entry){ fill=j; t.status='filled'; t.filledT=b.t; Object.assign(t,{entry:lv.entry,stop:lv.stop,target:lv.target,rr:lv.rr}); sl=t.stop; }
          else if(up? b.c<lo : b.c>lo){ t.status='invalid'; end=j; break; }
          else { if(s.mtfReanchor!=='off' && (up? b.h>hi : b.l<hi)){ hi= up? b.h : b.l; lv=mtfLevels(lo,hi,dir,s,rg); } continue; }
        }
        if(fill>=0){
          if(up? b.l<=sl : b.h>=sl){ t.R=got+size*(sl-t.entry)*dir/Math.abs(t.entry-t.stop); t.status= p1Hit? 'tp1' : beHit? 'be' : 'loss'; t.closedT=b.t+bar; end=j; break; }
          if(p1 && !p1Hit && j>fill && (up? b.h>=t.entry+(t.entry-t.stop)*p1 : b.l<=t.entry-(t.stop-t.entry)*p1)){ p1Hit=true; got=0.5*p1; size=0.5; sl=t.entry; }
          if(j>fill && (up? b.h>=t.target : b.l<=t.target)){ t.status='win'; t.R=got+size*t.rr; t.closedT=b.t+bar; end=j; break; }
          if(!p1 && s.beAt>0 && !beHit && j>fill && (up? b.h>=t.entry+(t.target-t.entry)*s.beAt : b.l<=t.entry-(t.entry-t.target)*s.beAt)){ beHit=true; sl=t.entry; }
        }
      }
      if(t.status==='filled') t.status='open';
      if(t.status==='filled'||t.status==='open'||t.R!=null){ if(!(lv.risk>0) || t.rr<(+s.mtfMinRR||1.5) || Math.abs(t.entry-t.stop)/t.entry*100<(+s.mtfMinStop||0)){ continue; } }
      busy=end;
      if(t.R!=null && fee){ t.cost=fee*2*t.entry/Math.abs(t.entry-t.stop); t.R-=t.cost; }
      trades.push(t);
    }
    return {trades};
  }
  // ---- 歷史回測：逐根 1H 收盤往前走，每次只用「當時已收盤」的 K 棒判斷，不偷看未來 ----
  // o: { window: 1H 視窗（跟實盤一樣 300）, htfWindow: 200, maxWait: 幾根內沒進場算過期, feePct: 單邊手續費+滑點 %, btcDirAt(t) }
  function backtest(sym, ltf, htf, s, o={}){
    if(s.model==='bf') return backtestBF(sym, ltf, htf, s, o);
    if(s.model==='mtf') return backtestMTF(sym, ltf, htf, s, o);
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
      const t={sym,dir:r.dir,t:closeT,entry:r.entry,stop:r.stop,target:r.target,rr:r.rr,be:r.be,score:r.score,zone:r.zone,feat:r.feat,q:r.quality&&r.quality.score,grade:r.quality&&r.quality.grade,retr:r.retr,status:'pending'};
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
  return {genSeries,addBar,aggregate,analyze,quality,applyContext,ema,isEngulf,isPin,toDaily,structure,backtest,trendSeries,BONUS};
})();
if(typeof module!=='undefined' && module.exports) module.exports=SMC;
