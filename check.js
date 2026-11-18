
const $=x=>document.getElementById(x);let ws,rows=[],btcRows=[],lastTick=null,bid=0,ask=0,retry=1000;let hybridState={candle:0,side:'WAIT',count:0,armed:false,lastClosed:0};let currentSignal=null;let shadowPosition=null;let shadowTrades=[];const EXIT_KEY='xrpQuantExitJournalV090';try{const savedExit=JSON.parse(localStorage.getItem(EXIT_KEY)||'{}');if(Array.isArray(savedExit)){shadowTrades=savedExit;}else{shadowTrades=Array.isArray(savedExit.trades)?savedExit.trades:[];shadowPosition=savedExit.active||null;}}catch(e){shadowTrades=[];shadowPosition=null;}
function ema(a,p){let k=2/(p+1),v=a[0];for(let x of a.slice(1))v=x*k+v*(1-k);return v}
function rsi(a){if(a.length<15)return null;let g=0,l=0;for(let i=a.length-14;i<a.length;i++){let d=a[i]-a[i-1];if(d>0)g+=d;else l-=d}return l===0?100:100-100/(1+g/l)}
function atr(a){if(a.length<15)return null;let t=[];for(let i=1;i<a.length;i++){let h=+a[i][2],lo=+a[i][3],pc=+a[i-1][4];t.push(Math.max(h-lo,Math.abs(h-pc),Math.abs(lo-pc)))}return t.slice(-14).reduce((x,y)=>x+y,0)/14}
function clamp(v,a,b){return Math.max(a,Math.min(b,v))}
function predictability(closes,candles){if(closes.length<30)return {score:0,er:0,coh:0,reg:0};let n=20,net=Math.abs(closes.at(-1)-closes.at(-1-n)),path=0;for(let i=closes.length-n;i<closes.length;i++)path+=Math.abs(closes[i]-closes[i-1]);let er=path?net/path:0,diffs=[];for(let i=closes.length-n;i<closes.length;i++)diffs.push(closes[i]-closes[i-1]);let same=diffs.filter(x=>Math.sign(x)===Math.sign(diffs[diffs.length-1])&&Math.abs(x)>0).length,coh=same/n,trs=[];for(let i=candles.length-20;i<candles.length;i++){let z=candles[i],pr=candles[i-1];trs.push(Math.max(+z[2]- +z[3],Math.abs(+z[2]- +pr[4]),Math.abs(+z[3]- +pr[4])))}let mean=trs.reduce((a,b)=>a+b,0)/trs.length,sd=Math.sqrt(trs.reduce((a,b)=>a+(b-mean)**2,0)/trs.length),reg=mean?clamp(1-sd/mean,0,1):0;return {score:Math.round(100*(.45*er+.35*coh+.20*reg)),er,coh,reg}}

const LOG_KEY='xrpQuantSignalLog_v06';
const HORIZONS=[1,2,3,6,12];
let signalLog=[];
try{signalLog=JSON.parse(localStorage.getItem(LOG_KEY)||'[]');if(!Array.isArray(signalLog))signalLog=[];}catch(e){signalLog=[];}
function persistLog(){try{localStorage.setItem(LOG_KEY,JSON.stringify(signalLog.slice(-2000)));$('storageState').textContent='Locale OK';}catch(e){$('storageState').textContent='Storage pieno';}}
function signedBps(side,entry,exit){let raw=(exit-entry)/entry*10000;return side==='SHORT'?-raw:raw;}
function strategyPick(long,short,threshold,margin){if(long>=threshold&&long-short>=margin)return 'LONG';if(short>=threshold&&short-long>=margin)return 'SHORT';return 'WAIT';}
function renderJournal(){
 $('logCount').textContent=signalLog.length;
 const names={1:'h1',2:'h2',3:'h3',6:'h6',12:'h12'};
 for(const n of HORIZONS){
  let vals=[];for(const ev of signalLog){for(const variant of ['A','B','C']){let side=ev.variants?.[variant];let out=ev.outcomes?.[n]?.[variant];if(side&&side!=='WAIT'&&out&&Number.isFinite(out.bps))vals.push({bps:out.bps,side});}}
  let wins=vals.filter(x=>x.bps>0).length,avg=vals.length?vals.reduce((a,x)=>a+x.bps,0)/vals.length:0;
  $(names[n]).textContent=vals.length?`${vals.length} esiti · ${(wins/vals.length*100).toFixed(1)}% positivi · media ${avg.toFixed(1)} bps`:'In raccolta';
 }
 for(const v of ['A','B','C']){
  let vals=[];for(const ev of signalLog){for(const n of HORIZONS){let o=ev.outcomes?.[n]?.[v];if(o&&Number.isFinite(o.bps))vals.push(o.bps);}}
  let wins=vals.filter(x=>x>0).length,avg=vals.length?vals.reduce((a,b)=>a+b,0)/vals.length:0;
  $('strat'+v).textContent=vals.length?`${vals.length} esiti · ${(wins/vals.length*100).toFixed(1)}% win · ${avg.toFixed(1)} bps medi`:'In raccolta';
 }
 let recent=signalLog.slice(-12).reverse();
 $('signalRows').innerHTML=recent.length?recent.map(ev=>`<div class="row"><span>${new Date(ev.time).toLocaleString('it-IT')} · ${ev.variants.A}/${ev.variants.B}/${ev.variants.C}</span><b>${ev.long}/${ev.short}</b></div>`).join(''):'In attesa della prima candela chiusa…';
}
let lastLoggedCandleTime=0;
function recordClosedCandle(){
 if(rows.length<60||btcRows.length<22)return;
 // Bybit keeps the currently-forming candle at the end; find the newest confirmed candle instead.
 const closed=rows.filter(c=>c[6]===true&&+c[0]>lastLoggedCandleTime);
 if(!closed.length)return;
 closed.sort((a,b)=>+a[0]-+b[0]);
 for(const candle of closed){
  const ts=+candle[0];
  if(!Number.isFinite(ts)||signalLog.some(x=>x.candleTime===ts)){lastLoggedCandleTime=Math.max(lastLoggedCandleTime,ts);continue;}
  const idx=rows.findIndex(x=>+x[0]===ts);
  if(idx<59)continue;
  const sample=rows.slice(0,idx+1),cl=sample.map(x=>+x[4]),vols=sample.map(x=>+x[5]||0);
  const e9=ema(cl.slice(-80),9),e21=ema(cl.slice(-100),21),rv=rsi(cl),roc=(cl.at(-1)/cl.at(-7)-1)*100;
  const volAvg=vols.slice(-21,-1).reduce((a,b)=>a+b,0)/20,relVol=volAvg?vols.at(-1)/volAvg:1;
  const btcClosed=btcRows.filter(x=>x[6]===true),btcSample=btcClosed.length>=22?btcClosed:btcRows;
  const btc=btcSample.map(x=>+x[4]),btcUp=ema(btc,9)>ema(btc,21),pred=predictability(cl,sample);
  const tL=e9>e21?20:0,tS=e9<e21?20:0,mL=roc>0?clamp(roc/.12*25,0,25):0,mS=roc<0?clamp(-roc/.12*25,0,25):0;
  const rL=rv>=50&&rv<=70?15:rv>70&&rv<78?8:0,rS=rv<=50&&rv>=30?15:rv<30&&rv>22?8:0,v=relVol>=1.15?15:relVol>=.9?8:0,bL=btcUp?10:0,bS=btcUp?0:10;
  const long=Math.round(clamp(tL+mL+rL+v+bL,0,100)),short=Math.round(clamp(tS+mS+rS+v+bS,0,100));
  const variants={A:strategyPick(long,short,35,10),B:strategyPick(long,short,30,5),C:strategyPick(long,short,pred.score>=65?25:pred.score>=40?30:40,5)};
  signalLog.push({time:Date.now(),candleTime:ts,entry:+candle[4],long,short,predictability:pred.score,er:+pred.er.toFixed(4),variants,outcomes:{}});openShadowPosition({candleTime:ts,entry:+candle[4],variants});
  lastLoggedCandleTime=Math.max(lastLoggedCandleTime,ts);
 }
 if(signalLog.length>2000)signalLog=signalLog.slice(-2000);
 persistLog();renderJournal();
}
function settleOutcomes(){
 if(!rows.length||!signalLog.length)return;
 let byTime=new Map(rows.map(c=>[+c[0],+c[4]])),changed=false;
 for(const ev of signalLog){
  for(const n of HORIZONS){
   const target=ev.candleTime+n*300000;
   const exit=byTime.get(target);
   if(exit===undefined)continue;
   if(!ev.outcomes[n])ev.outcomes[n]={};
   for(const v of ['A','B','C']){
    if(ev.variants[v]!=='WAIT'&&!ev.outcomes[n][v]){
     ev.outcomes[n][v]={exit,bps:+signedBps(ev.variants[v],ev.entry,exit).toFixed(2)};changed=true;
    }
   }
  }
 }
 if(changed){persistLog();renderJournal();}
}
function exportJournal(){
 const lines=[['timestamp','candle_time','entry_price','long_score','short_score','predictability','A','B','C','horizon_min','variant','gross_bps'].join(',')];
 for(const ev of signalLog){for(const n of HORIZONS){for(const v of ['A','B','C']){let o=ev.outcomes?.[n]?.[v];lines.push([new Date(ev.time).toISOString(),new Date(ev.candleTime).toISOString(),ev.entry,ev.long,ev.short,ev.predictability,ev.variants.A,ev.variants.B,ev.variants.C,n*5,v,o?.bps??''].join(','));}}}
 const blob=new Blob([lines.join('\n')],{type:'text/csv'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='xrp-quant-signal-journal.csv';a.click();URL.revokeObjectURL(url);
}
function persistExit(){try{localStorage.setItem(EXIT_KEY,JSON.stringify({trades:shadowTrades.slice(-500),active:shadowPosition}));}catch(e){}}
function recentAtr(){return rows.length>15?atr(rows):null;}
function swingTarget(side,entry){const recent=rows.slice(-21,-1);if(recent.length<10)return entry+(side==='LONG'?1:-1)*(recentAtr()||entry*.002)*2;return side==='LONG'?Math.max(...recent.map(c=>+c[2])):Math.min(...recent.map(c=>+c[3]));}
function openShadowPosition(ev){if(shadowPosition||!ev||!['LONG','SHORT'].includes(ev.variants.C))return;const side=ev.variants.C,entry=+ev.entry,a=recentAtr();if(!(entry>0&&a>0))return;const stopDist=a*1.5,target=swingTarget(side,entry);if((side==='LONG'&&target<=entry)||(side==='SHORT'&&target>=entry))return;shadowPosition={id:String(ev.candleTime),side,entry,entryTime:ev.candleTime,initialQty:1,remaining:1,stop:entry+(side==='LONG'?-stopDist:stopDist),peakPrice:entry,target,atrAtEntry:a,mode:'SWING',partialTarget:false,oppositeTrimmed:false,mfeBps:0,maeBps:0,realizedGrossBps:0,feesBps:0,events:[],lastDecision:'Apertura shadow su conferma C'};persistExit();renderExit();}
function exitOppositeState(){if(!shadowPosition||!currentSignal)return 'NONE';const p=shadowPosition,opposite=p.side==='LONG'?currentSignal.short:currentSignal.long,own=p.side==='LONG'?currentSignal.long:currentSignal.short,margin=opposite-own,threshold=currentSignal.threshold;if(opposite>=threshold&&margin>=8)return 'CONFIRMED';if(opposite>=threshold-5&&margin>=3)return 'APPROACHING';return 'NONE';}
function realizeShadow(q,price,reason){const p=shadowPosition;if(!p||q<=0)return;const qty=Math.min(q,p.remaining),gross=signedBps(p.side,p.entry,price),feeBps=11;p.realizedGrossBps+=gross*qty;p.feesBps+=feeBps*qty;p.remaining=Math.max(0,p.remaining-qty);p.events.push({time:Date.now(),price,qty,reason,grossBps:gross});p.lastDecision=reason;if(p.remaining<0.000001){const net=p.realizedGrossBps-p.feesBps,capture=p.mfeBps>0?net/p.mfeBps*100:null;shadowTrades.push({id:p.id,side:p.side,entry:p.entry,exit:price,netBps:+net.toFixed(2),mfeBps:+p.mfeBps.toFixed(2),maeBps:+p.maeBps.toFixed(2),captureRatio:capture===null?null:+capture.toFixed(1),events:p.events,closedAt:Date.now()});shadowTrades=shadowTrades.slice(-500);shadowPosition=null;persistExit();}renderExit();}
function manageShadowPosition(){const p=shadowPosition;if(!p||!lastTick||!Number.isFinite(+lastTick.lastPrice))return;const price=+lastTick.lastPrice,a=recentAtr()||p.atrAtEntry;if(!(price>0&&a>0))return;const favorable=signedBps(p.side,p.entry,price),adverse=-favorable;p.mfeBps=Math.max(p.mfeBps,favorable);p.maeBps=Math.max(p.maeBps,adverse);const closes=rows.slice(-4).map(c=>+c[4]);let speed=0;if(closes.length>=3)speed=Math.abs(closes.at(-1)-closes[0]);const momentum=speed/a>=0.75&&favorable>5;p.mode=momentum?'MOMENTUM':'SWING';const trailMult=momentum?2.2:1.25;if(p.side==='LONG'){p.peakPrice=Math.max(p.peakPrice,price);if(favorable>0)p.stop=Math.max(p.stop,p.peakPrice-a*trailMult);}else{p.peakPrice=Math.min(p.peakPrice,price);if(favorable>0)p.stop=Math.min(p.stop,p.peakPrice+a*trailMult);}const nearTarget=p.side==='LONG'?price>=p.target-a*.20:price<=p.target+a*.20,opp=exitOppositeState();if(nearTarget&&!p.partialTarget){p.partialTarget=true;realizeShadow(p.remaining*.5,price,'Target swing vicino · presa parziale 50%');if(!shadowPosition)return;}if(opp==='APPROACHING'&&!p.oppositeTrimmed){p.oppositeTrimmed=true;realizeShadow(p.remaining*.5,price,'Segnale opposto in avvicinamento · riduzione 50%');if(!shadowPosition)return;}if(opp==='CONFIRMED'){realizeShadow(p.remaining,price,'Segnale opposto confermato · chiusura residuo');return;}const stopHit=p.side==='LONG'?price<=p.stop:price>=p.stop;if(stopHit){realizeShadow(p.remaining,price,'Trailing / stop protettivo raggiunto');return;}p.lastDecision=momentum?'Momentum: trailing largo e profitto lasciato correre':'Swing: trailing protettivo e target monitorato';persistExit();renderExit();}
function renderExit(){const p=shadowPosition;$('exitPositionState').textContent=p?'APERTO · SHADOW':'IN ATTESA';$('exitPositionState').className=p?'g':'a';$('exitEntry').textContent=p?p.side+' · '+p.entry.toFixed(5):'—';$('exitMode').textContent=p?p.mode:'—';$('exitTarget').textContent=p?p.target.toFixed(5):'—';$('exitStop').textContent=p?p.stop.toFixed(5):'—';$('exitRemaining').textContent=p?(p.remaining*100).toFixed(1)+'%':'—';$('exitPnl').textContent=p?((p.realizedGrossBps-p.feesBps)+(signedBps(p.side,p.entry,lastTick?+lastTick.lastPrice:p.entry)*p.remaining-11*p.remaining)).toFixed(2)+' bps · stimato':'—';$('exitExcursions').textContent=p?p.mfeBps.toFixed(1)+' / '+p.maeBps.toFixed(1)+' bps':'—';$('exitDecision').textContent=p?p.lastDecision:(shadowTrades.length?'Ultimo trade completato':'In attesa di un segnale C confermato');$('exitTradesCount').textContent=shadowTrades.length;const ratios=shadowTrades.map(t=>t.captureRatio).filter(Number.isFinite);$('exitCapture').textContent=ratios.length?(ratios.reduce((a,b)=>a+b,0)/ratios.length).toFixed(1)+'%':'—';}
function calculateSignals(){if(rows.length<60||btcRows.length<22)return;let closes=rows.map(z=>+z[4]),vols=rows.map(z=>+z[5]||0),e9=ema(closes.slice(-80),9),e21=ema(closes.slice(-100),21),rv=rsi(closes),roc=(closes.at(-1)/closes.at(-7)-1)*100,volAvg=vols.slice(-21,-1).reduce((a,b)=>a+b,0)/20,relVol=volAvg?vols.at(-1)/volAvg:1,btc=btcRows.map(z=>+z[4]),btcUp=ema(btc,9)>ema(btc,21),pred=predictability(closes,rows),threshold=pred.score>=65?25:pred.score>=40?30:40;let tL=e9>e21?20:0,tS=e9<e21?20:0,mL=roc>0?clamp(roc/.12*25,0,25):0,mS=roc<0?clamp(-roc/.12*25,0,25):0,rL=rv>=50&&rv<=70?15:rv>70&&rv<78?8:0,rS=rv<=50&&rv>=30?15:rv<30&&rv>22?8:0,v=relVol>=1.15?15:relVol>=.9?8:0,bL=btcUp?10:0,bS=btcUp?0:10,long=Math.round(clamp(tL+mL+rL+v+bL,0,100)),short=Math.round(clamp(tS+mS+rS+v+bS,0,100));let candidate='WAIT',reason='Nessun punteggio supera la soglia adattiva o il vantaggio direzionale è insufficiente.';if(long>=threshold&&long-short>=8){candidate='LONG CANDIDATE';reason='LONG supera la soglia e prevale di almeno 8 punti. Non è un ordine.'}else if(short>=threshold&&short-long>=8){candidate='SHORT CANDIDATE';reason='SHORT supera la soglia e prevale di almeno 8 punti. Non è un ordine.'}currentSignal={long,short,threshold,btcUp,side:candidate.startsWith('LONG')?'LONG':candidate.startsWith('SHORT')?'SHORT':'WAIT'};$('longScore').textContent=long+'/100';$('shortScore').textContent=short+'/100';$('longState').textContent=long>=threshold?'Sopra soglia':'Sotto soglia';$('shortState').textContent=short>=threshold?'Sopra soglia':'Sotto soglia';$('predictability').textContent=pred.score+'/100 · ER '+pred.er.toFixed(2);$('regime').textContent=(pred.score>=65?'HIGH':pred.score>=40?'MEDIUM':'LOW')+' · soglia '+threshold;$('candidate').textContent=candidate;$('candidate').className=candidate==='LONG CANDIDATE'?'g':candidate==='SHORT CANDIDATE'?'r':'a';$('btc2').textContent=btcUp?'UP':'DOWN';$('cTrend').textContent='L '+tL+' / S '+tS;$('cMomentum').textContent='L '+mL.toFixed(0)+' / S '+mS.toFixed(0);$('cRsi').textContent='L '+rL+' / S '+rS;$('cVolume').textContent=v+' each';$('cBtc').textContent='L '+bL+' / S '+bS;$('cEr').textContent=pred.er.toFixed(2);$('signalReason').textContent=reason+' Score euristici, non probabilità, da validare con backtest.'}
function evaluateHybrid(k){
 if(!currentSignal||!k)return;
 const ts=+k.start,side=currentSignal.side,spreadBps=(bid>0&&ask>0)?((ask-bid)/((ask+bid)/2))*10000:Infinity;
 const spreadOK=spreadBps<=15;
 const strictSide=side!=='WAIT'&&((side==='LONG'&&currentSignal.long>=currentSignal.threshold+10&&currentSignal.long-currentSignal.short>=10&&currentSignal.btcUp)||(side==='SHORT'&&currentSignal.short>=currentSignal.threshold+10&&currentSignal.short-currentSignal.long>=10&&!currentSignal.btcUp));
 if(ts!==hybridState.candle){hybridState={candle:ts,side:'WAIT',count:0,armed:false,lastClosed:hybridState.lastClosed};}
 if(k.confirm){
  const closeSide=currentSignal.side;
  $('hybridClose').textContent=closeSide==='WAIT'?'CHIUSURA: WAIT':('CHIUSURA: '+closeSide);
  $('hybridClose').className=closeSide==='LONG'?'g':closeSide==='SHORT'?'r':'a';
  hybridState.lastClosed=ts;
  hybridState.count=0;hybridState.armed=false;hybridState.side='WAIT';
 }else{
  if(strictSide&&spreadOK){
   if(hybridState.side===side)hybridState.count=Math.min(3,hybridState.count+1);
   else {hybridState.side=side;hybridState.count=1;hybridState.armed=false;}
   if(hybridState.count>=3)hybridState.armed=true;
  }else{
   hybridState.side='WAIT';hybridState.count=0;hybridState.armed=false;
  }
  $('hybridClose').textContent='IN FORMAZIONE';
  $('hybridClose').className='a';
 }
 $('hybridPreview').textContent=side==='WAIT'?'WAIT':side+' PREVIEW';
 $('hybridPreview').className=side==='LONG'?'g':side==='SHORT'?'r':'a';
 $('hybridGate').textContent=hybridState.armed?(hybridState.side+' EARLY TRIGGER'):'NON ARMATO';
 $('hybridGate').className=hybridState.armed?(hybridState.side==='LONG'?'g':'r'):'a';
 $('hybridSpread').textContent=Number.isFinite(spreadBps)?spreadBps.toFixed(2)+' bps · '+(spreadOK?'OK':'BLOCCATO'):'N/D · BLOCCATO';
 $('hybridPersistence').textContent=hybridState.count+' / 3';
}
function paint(){if(!rows.length)return;let c=$('chart'),x=c.getContext('2d'),a=rows.slice(-60).map(z=>+z[4]),mn=Math.min(...a),mx=Math.max(...a);x.clearRect(0,0,600,180);x.strokeStyle='#35d49a';x.lineWidth=3;x.beginPath();a.forEach((v,i)=>{let X=8+i*584/(a.length-1),Y=170-(v-mn)/(mx-mn||1)*155;i?x.lineTo(X,Y):x.moveTo(X,Y)});x.stroke()}
function update(){if($('equityInput'))renderCapitalFee();if(lastTick&&Number.isFinite(+lastTick.lastPrice)){let p=+lastTick.lastPrice;$('price').textContent=p.toFixed(5)+' USDT';if(Number.isFinite(+lastTick.price24hPcnt))$('change').textContent=(+lastTick.price24hPcnt*100).toFixed(2)+'%';if(Number.isFinite(+lastTick.turnover24h))$('turnover').textContent=(+lastTick.turnover24h).toLocaleString('en-US',{maximumFractionDigits:0})+' USDT'}if(rows.length>15){let c=rows.map(z=>+z[4]),e9=ema(c.slice(-80),9),e21=ema(c.slice(-100),21),rv=rsi(c),av=atr(rows),p=+rows[rows.length-1][4];$('ema9').textContent=e9.toFixed(5);$('ema21').textContent=e21.toFixed(5);$('rsi').textContent=rv.toFixed(1);$('atr').textContent=(av/p*100).toFixed(3)+'%';$('trend').textContent=e9>e21?'BULLISH':'BEARISH';$('trend').className='value '+(e9>e21?'g':'r');/* legacy RSI label removed; adaptive engine renders RSI contribution */}if(btcRows.length>21){let b=btcRows.map(z=>+z[4]),d=ema(b,9)>ema(b,21)?'UP':'DOWN';$('btc').textContent=d;$('btc2').textContent=d;$('btc2').className='value '+(d==='UP'?'g':'r')}if(bid&&ask)$('spread').textContent=((ask-bid)/((ask+bid)/2)*10000).toFixed(2)+' bps';$('updated').textContent='Ultimo aggiornamento: '+new Date().toLocaleTimeString('it-IT');paint();calculateSignals();manageShadowPosition();settleOutcomes();recordClosedCandle()}
function upsert(arr,k){let i=arr.findIndex(x=>x[0]===k[0]);if(i>=0)arr[i]=k;else arr.push(k);arr.sort((a,b)=>a[0]-b[0]);if(arr.length>220)arr.shift()}
function connect(){try{ws=new WebSocket('wss://stream.bybit.com/v5/public/linear');ws.onopen=()=>{retry=1000;$('conn').textContent='● BYBIT STREAM LIVE';ws.send(JSON.stringify({op:'subscribe',args:['tickers.XRPUSDT','orderbook.1.XRPUSDT','kline.5.XRPUSDT','kline.15.BTCUSDT']}));};ws.onmessage=e=>{let m=JSON.parse(e.data);if(m.topic==='tickers.XRPUSDT'&&m.data){lastTick=m.data;update()}else if(m.topic==='orderbook.1.XRPUSDT'&&m.data){bid=+m.data.b[0][0];ask=+m.data.a[0][0];update()}else if(m.topic==='kline.5.XRPUSDT'&&m.data){m.data.forEach(k=>{upsert(rows,[+k.start,+k.start,+k.high,+k.low,+k.close,+k.volume,!!k.confirm]);update();evaluateHybrid(k)})}else if(m.topic==='kline.15.BTCUSDT'&&m.data){m.data.forEach(k=>upsert(btcRows,[+k.start,+k.start,+k.high,+k.low,+k.close,+k.volume,!!k.confirm]));update()}};ws.onerror=()=>{$('conn').textContent='● STREAM ERROR'};ws.onclose=()=>{$('conn').textContent='● RECONNECTING';setTimeout(connect,retry);retry=Math.min(retry*2,15000)}}catch(e){$('err').textContent=e.message;setTimeout(connect,retry)}}

const CAP_KEY='xrpQuantCapitalV080';
function numInput(id,fallback=0){const v=Number($(id)?.value);return Number.isFinite(v)&&v>=0?v:fallback}
function renderCapitalFee(){
 const equity=numInput('equityInput',5),allocation=equity*.25,reserve=equity-allocation;
 const atrPct=rows.length>15?((atr(rows)/Number(rows.at(-1)[4]))*100):null;
 let volFactor=1,volLabel='N/D';
 if(Number.isFinite(atrPct)){volFactor=atrPct>.50?.5:atrPct>.35?.75:1;volLabel=volFactor.toFixed(2)+'× · ATR '+atrPct.toFixed(3)+'%'}
 const risk=allocation*.01*volFactor;
 $('agentCapital').textContent=allocation.toFixed(4)+' USDT';$('reserveCapital').textContent=reserve.toFixed(4)+' USDT';$('volFactor').textContent=volLabel;$('riskBudget').textContent=risk.toFixed(5)+' USDT';
 const notional=numInput('notionalInput',10),slip=numInput('slippageInput',2),rate=$('feeType').value==='maker'?.0002:.00055;
 const spread=(bid>0&&ask>0)?((ask-bid)/((ask+bid)/2))*10000:null;
 const fee=notional*rate*2,spreadCost=spread===null?null:notional*spread/10000,slippageCost=notional*(slip*2)/10000,total=fee+(spreadCost??0)+slippageCost;
 $('feeSpread').textContent=spread===null?'N/D':spread.toFixed(2)+' bps';$('feeRoundTrip').textContent=fee.toFixed(6)+' USDT';$('executionCost').textContent=(spreadCost===null?'Spread N/D · ':'')+((spreadCost??0)+slippageCost).toFixed(6)+' USDT';$('totalCost').textContent=(spreadCost===null?'Parziale · ':'')+total.toFixed(6)+' USDT';$('breakEven').textContent=(notional>0?(total/notional*100).toFixed(4)+'% · '+(total/notional*10000).toFixed(2)+' bps':'—');
}
function exportExitJournal(){const lines=[['id','side','entry','exit','net_bps','mfe_bps','mae_bps','capture_ratio_pct','closed_at','events'].join(',')];for(const t of shadowTrades){const events=(t.events||[]).map(e=>`${e.reason} @ ${e.price} qty ${e.qty}`).join(' | ').replaceAll('"','""');lines.push([t.id,t.side,t.entry,t.exit,t.netBps,t.mfeBps,t.maeBps,t.captureRatio??'',new Date(t.closedAt).toISOString(),'"'+events+'"'].join(','));}const blob=new Blob([lines.join('\n')],{type:'text/csv'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='xrp-quant-exit-journal.csv';a.click();URL.revokeObjectURL(url);}
function loadCapital(){try{const v=JSON.parse(localStorage.getItem(CAP_KEY)||'{}');if(Number.isFinite(v.equity)&&v.equity>=0)$('equityInput').value=v.equity;if(Number.isFinite(v.notional)&&v.notional>=0)$('notionalInput').value=v.notional;if(Number.isFinite(v.slippage)&&v.slippage>=0)$('slippageInput').value=v.slippage;if(v.feeType)$('feeType').value=v.feeType}catch(e){}renderCapitalFee()}
function saveCapital(){try{localStorage.setItem(CAP_KEY,JSON.stringify({equity:numInput('equityInput',5),notional:numInput('notionalInput',10),slippage:numInput('slippageInput',2),feeType:$('feeType').value}))}catch(e){}renderCapitalFee()}
['equityInput','notionalInput','slippageInput','feeType'].forEach(id=>$(id).addEventListener('input',saveCapital));
loadCapital();renderExit();
$('exportLog').onclick=exportJournal;$('exportExit').onclick=exportExitJournal;$('clearLog').onclick=()=>{if(confirm('Cancellare definitivamente il registro segnali locale di questo dispositivo?')){signalLog=[];persistLog();renderJournal()}};renderJournal();document.querySelectorAll('.tab').forEach(b=>b.onclick=()=>{document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active',x===b));document.querySelectorAll('.panel').forEach(x=>x.classList.toggle('hidden',x.id!==b.dataset.tab))});async function bootstrap(){try{const [x,b]=await Promise.all([fetch('https://api.bybit.com/v5/market/kline?category=linear&symbol=XRPUSDT&interval=5&limit=200').then(r=>r.json()),fetch('https://api.bybit.com/v5/market/kline?category=linear&symbol=BTCUSDT&interval=15&limit=30').then(r=>r.json())]);if(x.retCode!==0||b.retCode!==0)throw Error('Bybit REST bootstrap error');rows=x.result.list.slice().reverse().map(k=>[+k[0],+k[0],+k[2],+k[3],+k[4],+k[5],true]);btcRows=b.result.list.slice().reverse().map(k=>[+k[0],+k[0],+k[2],+k[3],+k[4],+k[5],true]);if(rows.length)rows[rows.length-1][6]=false;if(btcRows.length)btcRows[btcRows.length-1][6]=false;lastLoggedCandleTime=rows.length>1?+rows[rows.length-2][0]:0;update()}catch(e){$('err').textContent='Storico iniziale non caricato: '+e.message+'; provo comunque lo streaming live.'}}
bootstrap().finally(connect);
// PWA auto-update: check the deployed worker at startup and whenever the app
// returns to the foreground. Keep localStorage (journal/settings) untouched.
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  const hadController = !!navigator.serviceWorker.controller;
  let reloadingForWorker = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !reloadingForWorker) {
      reloadingForWorker = true;
      location.reload();
    }
  });
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
    .then(async (registration) => {
      try { await registration.update(); } catch (e) {}
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') registration.update().catch(() => {});
      });
      window.addEventListener('focus', () => registration.update().catch(() => {}));
    })
    .catch((error) => console.warn('PWA update check failed:', error));
}
