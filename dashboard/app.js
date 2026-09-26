const $=id=>document.getElementById(id);
const nf=new Intl.NumberFormat('tr-TR',{maximumFractionDigits:2});
const money=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:4});
const ago=ms=>{if(!ms)return 'henüz gözlem yok';const s=Math.max(0,Math.round((Date.now()-ms)/1000));if(s<60)return s+' sn önce';if(s<3600)return Math.floor(s/60)+' dk önce';return Math.floor(s/3600)+' sa önce'};
const short=v=>typeof v==='string'&&v.length>16?v.slice(0,7)+'…'+v.slice(-5):String(v??'—');
const ms=v=>typeof v==='number'?nf.format(v)+' ms':'—';
const clear=node=>{while(node.firstChild)node.removeChild(node.firstChild)};
function setText(id,value){$(id).textContent=String(value)}
function cell(text,cls=''){const td=document.createElement('td');td.textContent=String(text??'—');if(cls)td.className=cls;return td}
function renderOpportunities(items){
 const body=$('opportunities');clear(body);$('oppEmpty').style.display=items.length?'none':'block';
 for(const item of items.slice(0,25)){
  const tr=document.createElement('tr');const dt=new Date(item.timestampMs);
  tr.append(cell(dt.toLocaleTimeString('tr-TR',{hour:'2-digit',minute:'2-digit',second:'2-digit'}),'muted'));
  tr.append(cell((item.buyMarket??'?')+' → '+(item.sellMarket??'?'),'route'));
  tr.append(cell(typeof item.grossSpreadPct==='number'?nf.format(item.grossSpreadPct)+'%':'—'));
  tr.append(cell(typeof item.inputUsd==='number'?money.format(item.inputUsd):'—'));
  const p=typeof item.netProfitUsd==='number'?money.format(item.netProfitUsd):(item.status==='unavailable'?'unavailable':'—');
  tr.append(cell(p,item.netProfitUsd>0?'pos':item.status==='unavailable'?'muted':'neg'));
  tr.append(cell(short(item.blockNumber),'muted'));body.append(tr);
 }
}
function renderTimings(items){
 const root=$('timings');clear(root);$('timingEmpty').style.display=items.length?'none':'block';
 for(const item of items.slice(0,12)){
  const row=document.createElement('div');row.className='timing';
  const key=document.createElement('div');key.className='key';key.textContent=short(item.key);row.append(key);
  for(const [label,value] of [['ilk quote',item.discoveryToFirstQuoteCompletedMs],['sizing',item.sizingDurationMs],['post-sizing',item.discoveryToPostSizingLifecycleMs]]){
   const el=document.createElement('div');el.className='value';const small=document.createElement('span');small.textContent=label;el.append(small);el.append(document.createTextNode(ms(value)));row.append(el);
  } root.append(row);
 }
}
function renderChart(items){
 const root=$('rpcChart');clear(root);const values=items.slice(0,80).reverse().map(x=>x.durationMs).filter(Number.isFinite);
 if(values.length<2){const d=document.createElement('div');d.className='empty';d.style.display='block';d.textContent='Grafik için RPC örneği bekleniyor.';root.append(d);return}
 const ns='http://www.w3.org/2000/svg',w=600,h=210,pad=12,max=Math.max(...values,1);
 const svg=document.createElementNS(ns,'svg');svg.setAttribute('viewBox',`0 0 ${w} ${h}`);
 const defs=document.createElementNS(ns,'defs'),grad=document.createElementNS(ns,'linearGradient');grad.id='areaGradient';grad.setAttribute('x1','0');grad.setAttribute('x2','0');grad.setAttribute('y1','0');grad.setAttribute('y2','1');
 for(const [o,c] of [['0%','#75d9a5'],['100%','#75d9a500']]){const s=document.createElementNS(ns,'stop');s.setAttribute('offset',o);s.setAttribute('stop-color',c);grad.append(s)}defs.append(grad);svg.append(defs);
 for(let i=0;i<4;i++){const y=pad+(h-pad*2)*(i/3);const l=document.createElementNS(ns,'line');l.classList.add('gridline');l.setAttribute('x1',pad);l.setAttribute('x2',w-pad);l.setAttribute('y1',y);l.setAttribute('y2',y);svg.append(l)}
 const pts=values.map((v,i)=>{const x=pad+(w-pad*2)*(i/(values.length-1));const y=h-pad-(h-pad*2)*(v/max);return [x,y]});
 const d=pts.map((p,i)=>(i?'L':'M')+p[0].toFixed(1)+' '+p[1].toFixed(1)).join(' ');
 const area=document.createElementNS(ns,'path');area.classList.add('area');area.setAttribute('d',d+` L ${pts.at(-1)[0]} ${h-pad} L ${pts[0][0]} ${h-pad} Z`);svg.append(area);
 const line=document.createElementNS(ns,'path');line.classList.add('line');line.setAttribute('d',d);svg.append(line);root.append(svg);
}
function render(data){
 const last=data.database.lastObservationAtMs,age=last?Date.now()-last:null,isLive=age!==null&&age<15000;
 $('pulse').classList.toggle('live',isLive);
 setText('updated',new Date(data.generatedAtMs).toLocaleTimeString('tr-TR'));
 setText('dbStatus',data.database.exists?(isLive?'CANLI':'HAZIR'):'BOŞ');
 setText('lastSeen',data.database.exists?ago(last):'radar.sqlite henüz yok');
 setText('candidateCount',nf.format(data.radar.qualifyingScreens));
 setText('positiveCount',nf.format(data.radar.positiveExecutableQuotes));
 setText('rpcMetric',(data.radar.medianRpcLatencyMs??'—')+' / '+(data.radar.p95RpcLatencyMs??'—'));
 setText('quoteTotal',nf.format(data.counts.executableQuotes)+' toplam kayıt');
 setText('rpcCount',data.rpcLatency.length+' örnek');
 setText('timingCount',data.timings.length+' aday');
 setText('rpcLatest',data.rpcLatency[0]?data.rpcLatency[0].method+' · '+nf.format(data.rpcLatency[0].durationMs)+' ms':'—');
 setText('countLaunches',nf.format(data.counts.launches));setText('countMarkets',nf.format(data.counts.marketSnapshots));setText('countScreens',nf.format(data.counts.routeScreens));setText('countQuotes',nf.format(data.counts.executableQuotes));setText('countLifecycle',nf.format(data.counts.lifecycleRows));setText('countRpc',nf.format(data.counts.rpcSamples));
 renderOpportunities(data.opportunities);renderTimings(data.timings);renderChart(data.rpcLatency);
}
async function refresh(){
 try{const r=await fetch('/api/snapshot?limit=120',{cache:'no-store'});if(!r.ok)throw Error('HTTP '+r.status);render(await r.json())}
 catch(e){setText('dbStatus','HATA');setText('lastSeen',String(e));$('pulse').classList.remove('live')}
}
refresh();setInterval(refresh,2000);
