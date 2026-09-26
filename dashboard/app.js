const $=id=>document.getElementById(id);
const nf=new Intl.NumberFormat('tr-TR',{maximumFractionDigits:2});
const money=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:4});
const state={data:null,filter:'all',sort:'newest',query:'',windowSeconds:60,paused:false};
const ago=ms=>{if(!ms)return 'henüz gözlem yok';const s=Math.max(0,Math.round((Date.now()-ms)/1000));if(s<60)return s+' sn önce';if(s<3600)return Math.floor(s/60)+' dk önce';return Math.floor(s/3600)+' sa önce'};
const short=v=>typeof v==='string'&&v.length>18?v.slice(0,8)+'…'+v.slice(-6):String(v??'—');
const fmtMs=v=>typeof v==='number'?nf.format(v)+' ms':'—';
const fmtPct=v=>typeof v==='number'?nf.format(v)+'%':'—';
const fmtMoney=v=>typeof v==='number'?money.format(v):'—';
const clear=node=>{while(node.firstChild)node.removeChild(node.firstChild)};
function setText(id,value){$(id).textContent=String(value)}
function cell(text,cls='',title=''){const td=document.createElement('td');td.textContent=String(text??'—');if(cls)td.className=cls;if(title)td.title=title;return td}
function freshnessLabel(value){return ({live:'CANLI',delayed:'GECİKMELİ',stale:'BAYAT',idle:'HAZIR',empty:'BOŞ'})[value]??'—'}
function statusClass(item){
  if(item.status==='positive')return 'pos';
  if(item.status==='unavailable')return 'muted';
  return 'neg';
}
function filteredOpportunities(){
  const items=[...(state.data?.opportunities??[])];
  const q=state.query.trim().toLowerCase();
  const filtered=items.filter(item=>{
    if(state.filter!=='all'&&item.status!==state.filter)return false;
    if(!q)return true;
    return [item.token,item.buyMarket,item.sellMarket,item.key].some(v=>String(v??'').toLowerCase().includes(q));
  });
  filtered.sort((a,b)=>{
    if(state.sort==='bestNet')return (b.bestObservedNetProfitUsd??-Infinity)-(a.bestObservedNetProfitUsd??-Infinity);
    if(state.sort==='spread')return (b.grossSpreadPct??-Infinity)-(a.grossSpreadPct??-Infinity);
    return (b.timestampMs??0)-(a.timestampMs??0);
  });
  return filtered;
}
function renderOpportunities(){
  const items=filteredOpportunities();
  const body=$('opportunities');clear(body);
  $('oppEmpty').style.display=items.length?'none':'block';
  setText('oppShown',items.length+' aday');
  for(const item of items.slice(0,100)){
    const tr=document.createElement('tr');
    const dt=new Date(item.timestampMs);
    tr.append(cell(dt.toLocaleTimeString('tr-TR',{hour:'2-digit',minute:'2-digit',second:'2-digit'}),'muted'));
    tr.append(cell(short(item.token),'token',String(item.token??'')));
    tr.append(cell((item.buyMarket??'?')+' → '+(item.sellMarket??'?'),'route'));
    tr.append(cell(fmtPct(item.grossSpreadPct)));
    const latest=item.latestNetProfitUsd;
    tr.append(cell(latest===null&&item.status==='unavailable'?'unavailable':fmtMoney(latest),latest>0?'pos':latest===null?'muted':'neg',item.reason??''));
    tr.append(cell(fmtMoney(item.bestObservedNetProfitUsd),statusClass(item)));
    tr.append(cell(item.quoteCount??0,'muted'));
    tr.append(cell(short(item.blockNumber),'muted',String(item.blockNumber??'')));
    body.append(tr);
  }
}
function renderTimings(items){
  const root=$('timings');clear(root);$('timingEmpty').style.display=items.length?'none':'block';
  setText('recentTimingCount',items.length+' kayıt');
  for(const item of items.slice(0,12)){
    const row=document.createElement('div');row.className='timing';
    const key=document.createElement('div');key.className='key';key.textContent=short(item.key);key.title=String(item.key??'');row.append(key);
    for(const [label,value] of [['ilk quote',item.discoveryToFirstQuoteCompletedMs],['sizing',item.sizingDurationMs],['post-sizing',item.discoveryToPostSizingLifecycleMs]]){
      const el=document.createElement('div');el.className='value';const small=document.createElement('span');small.textContent=label;el.append(small);el.append(document.createTextNode(fmtMs(value)));row.append(el);
    }
    root.append(row);
  }
}
function svgEl(name,attrs={}){
  const el=document.createElementNS('http://www.w3.org/2000/svg',name);
  for(const [key,value] of Object.entries(attrs))el.setAttribute(key,String(value));
  return el;
}
function renderSeriesChart(rootId,points,options={}){
  const root=$(rootId);clear(root);
  const valid=points.filter(x=>Number.isFinite(x.value));
  if(valid.length<2){
    const d=document.createElement('div');d.className='empty';d.style.display='block';d.textContent=options.empty??'Grafik için veri bekleniyor.';root.append(d);return;
  }
  const w=600,h=210,pad=14;
  let min=Math.min(...valid.map(x=>x.value)),max=Math.max(...valid.map(x=>x.value));
  if(options.includeZero){min=Math.min(min,0);max=Math.max(max,0)}
  if(min===max){min-=1;max+=1}
  const range=max-min;
  const svg=svgEl('svg',{viewBox:`0 0 ${w} ${h}`});
  const defs=svgEl('defs');
  const grad=svgEl('linearGradient',{id:options.gradientId??'chartGradient',x1:'0',x2:'0',y1:'0',y2:'1'});
  grad.append(svgEl('stop',{offset:'0%','stop-color':options.color??'#75d9a5'}));
  grad.append(svgEl('stop',{offset:'100%','stop-color':options.fade??'#75d9a500'}));
  defs.append(grad);svg.append(defs);
  for(let i=0;i<4;i++){
    const y=pad+(h-pad*2)*(i/3);svg.append(svgEl('line',{class:'gridline',x1:pad,x2:w-pad,y1:y,y2:y}));
  }
  if(options.includeZero&&min<0&&max>0){
    const zeroY=h-pad-(h-pad*2)*((0-min)/range);
    svg.append(svgEl('line',{class:'zeroline',x1:pad,x2:w-pad,y1:zeroY,y2:zeroY}));
  }
  const coords=valid.map((point,i)=>{
    const x=pad+(w-pad*2)*(i/(valid.length-1));
    const y=h-pad-(h-pad*2)*((point.value-min)/range);
    return [x,y];
  });
  const d=coords.map((p,i)=>(i?'L':'M')+p[0].toFixed(1)+' '+p[1].toFixed(1)).join(' ');
  const area=svgEl('path',{class:'area',d:d+` L ${coords.at(-1)[0]} ${h-pad} L ${coords[0][0]} ${h-pad} Z`,fill:`url(#${options.gradientId??'chartGradient'})`});
  const line=svgEl('path',{class:options.lineClass??'line',d});
  svg.append(area);svg.append(line);root.append(svg);
}
function renderSpotlight(item){
  if(!item){
    setText('spotlightRoute','Pozitif paper quote bekleniyor');
    setText('spotlightMeta','Amount-sensitive quote oluştuğunda burada özetlenecek.');
    setText('spotlightNet','—');
    $('spotlight').classList.remove('has-positive');
    return;
  }
  $('spotlight').classList.add('has-positive');
  setText('spotlightRoute',(item.buyMarket??'?')+' → '+(item.sellMarket??'?')+' · '+short(item.token));
  setText('spotlightMeta',fmtPct(item.grossSpreadPct)+' spread · '+fmtMoney(item.latestInputUsd)+' input · '+ago(item.timestampMs)+' · block '+short(item.blockNumber));
  setText('spotlightNet',fmtMoney(item.latestNetProfitUsd));
}
function render(data){
  state.data=data;
  const freshness=data.database.freshness;
  $('pulse').classList.toggle('live',freshness==='live');
  $('pulse').classList.toggle('delayed',freshness==='delayed');
  setText('updated',new Date(data.generatedAtMs).toLocaleTimeString('tr-TR'));
  setText('dbStatus',freshnessLabel(freshness));
  setText('lastSeen',data.database.exists?ago(data.database.lastObservationAtMs):'radar.sqlite henüz yok');
  setText('candidateCount',nf.format(data.radar.qualifyingScreens));
  setText('candidateWindow','son '+Math.round(data.window.durationMs/1000)+' sn');
  setText('quoteBackedCount',nf.format(data.radar.quoteBackedCandidates));
  setText('positiveCount',nf.format(data.radar.positiveExecutableQuotes));
  setText('positiveRate','oran '+fmtPct(data.radar.positiveRatePct));
  setText('quoteLatencyMetric',(data.radar.medianFirstQuoteMs??'—')+' / '+(data.radar.p95FirstQuoteMs??'—'));
  setText('rpcMetric',(data.radar.medianRpcLatencyMs??'—')+' / '+(data.radar.p95RpcLatencyMs??'—'));
  setText('timingCount',data.timings.length+' aday');
  setText('firstMedian',fmtMs(data.radar.medianFirstQuoteMs));
  setText('firstP95',fmtMs(data.radar.p95FirstQuoteMs));
  setText('sizingMedian',fmtMs(data.radar.medianSizingMs));
  setText('sizingP95',fmtMs(data.radar.p95SizingMs));
  setText('missRate',fmtPct(data.radar.missedDeadlineRatePct));
  setText('missP95',fmtMs(data.radar.p95DeadlineMissMs));
  setText('rpcCount',data.rpcLatency.length+' örnek');
  setText('rpcLatest',data.rpcLatency[0]?data.rpcLatency[0].method+' · '+nf.format(data.rpcLatency[0].durationMs)+' ms':'—');
  setText('pnlCount',data.paperPnl.length+' quote');
  const latestPnl=data.paperPnl.at(-1);
  setText('pnlLatest',latestPnl?fmtMoney(latestPnl.netProfitUsd):'—');
  setText('countLaunches',nf.format(data.counts.launches));
  setText('countMarkets',nf.format(data.counts.marketSnapshots));
  setText('countScreens',nf.format(data.counts.routeScreens));
  setText('countQuotes',nf.format(data.counts.executableQuotes));
  setText('countLifecycle',nf.format(data.counts.lifecycleRows));
  setText('countRpc',nf.format(data.counts.rpcSamples));
  setText('uniqueTokens',nf.format(data.radar.uniqueTokens));
  setText('unavailableCount',nf.format(data.radar.unavailableQuotes));
  setText('analysisCap','analysis cap '+nf.format(data.window.analysisRowCap)+' / tablo');
  const runtime=data.runtime??{};
  setText('runtimeTick',runtime.lastTickAtMs?'son tick '+ago(runtime.lastTickAtMs):'tick bekleniyor');
  setText('runtimeQueued',nf.format(runtime.queued??0));
  setText('runtimeDropped',nf.format(runtime.droppedStale??0));
  setText('runtimeProbes',nf.format(runtime.probesCompleted??0)+' / '+nf.format(runtime.probesStarted??0));
  setText('runtimeSizing',nf.format(runtime.sizingCompleted??0)+' / '+nf.format(runtime.sizingStarted??0));
  setText('runtimeProbeConcurrency',runtime.probeConcurrency??'—');
  setText('runtimeSizingConcurrency',runtime.sizingConcurrency??'—');
  setText('runtimeDuration',fmtMs(runtime.tickDurationMs));
  setText('runtimeValuation',nf.format(runtime.valuationFetches??0));

  const truncated=Object.values(data.window.truncated).some(Boolean);
  setText('qualityNote',truncated?'Analiz satır sınırına ulaştı; bu pencerenin bazı oranları kısmi olabilir. Quote tamamlanması capture/inclusion değildir.':'Quote tamamlanması capture/inclusion değildir.');
  renderSpotlight(data.radar.latestPositiveOpportunity);
  renderOpportunities();
  renderTimings(data.timings);
  renderSeriesChart('rpcChart',data.rpcLatency.slice(0,100).reverse().map(x=>({value:x.durationMs})),{gradientId:'rpcGradient',empty:'RPC örneği bekleniyor.'});
  renderSeriesChart('pnlChart',data.paperPnl.map(x=>({value:x.netProfitUsd})),{gradientId:'pnlGradient',lineClass:'pnl-line',color:'#d6b36a',fade:'#d6b36a00',includeZero:true,empty:'Paper P&L quote örneği bekleniyor.'});
}
async function refresh(){
  if(state.paused)return;
  try{
    const r=await fetch(`/api/snapshot?limit=500&windowSeconds=${state.windowSeconds}`,{cache:'no-store'});
    if(!r.ok)throw Error('HTTP '+r.status);
    render(await r.json());
  }catch(e){
    setText('dbStatus','HATA');setText('lastSeen',String(e));$('pulse').classList.remove('live','delayed');
  }
}
$('windowSelect').addEventListener('change',event=>{state.windowSeconds=Number(event.target.value)||60;refresh()});
$('searchInput').addEventListener('input',event=>{state.query=event.target.value;renderOpportunities()});
$('sortSelect').addEventListener('change',event=>{state.sort=event.target.value;renderOpportunities()});
for(const button of document.querySelectorAll('.filter')){
  button.addEventListener('click',()=>{
    state.filter=button.dataset.filter??'all';
    for(const sibling of document.querySelectorAll('.filter'))sibling.classList.toggle('active',sibling===button);
    renderOpportunities();
  });
}
$('refreshToggle').addEventListener('click',()=>{
  state.paused=!state.paused;
  setText('refreshToggle',state.paused?'Otomatik yenileme: duraklatıldı':'Otomatik yenileme: açık');
  $('refreshToggle').classList.toggle('paused',state.paused);
  if(!state.paused)refresh();
});
refresh();
setInterval(refresh,2000);
