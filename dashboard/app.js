const $=id=>document.getElementById(id);
const nf=new Intl.NumberFormat('tr-TR',{maximumFractionDigits:2});
const money=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:4});
const state={data:null,filter:'all',sort:'newest',query:'',windowSeconds:60,runId:'current',paused:false,selectedKey:null};
const ago=ms=>{if(!ms)return 'henüz gözlem yok';const s=Math.max(0,Math.round((Date.now()-ms)/1000));if(s<60)return s+' sn önce';if(s<3600)return Math.floor(s/60)+' dk önce';return Math.floor(s/3600)+' sa önce'};
const short=v=>typeof v==='string'&&v.length>18?v.slice(0,8)+'…'+v.slice(-6):String(v??'—');
const fmtMs=v=>typeof v==='number'?nf.format(v)+' ms':'—';
const fmtPct=v=>typeof v==='number'?nf.format(v)+'%':'—';
const fmtMarginalPct=v=>{
  if(typeof v!=='number'||!Number.isFinite(v))return '—';
  return Math.abs(v)>=1000?v.toExponential(2)+'%':nf.format(v)+'%';
};
const depthEdgePct=item=>{
  const b=item?.firstProbeCostBreakdown;
  return b&&typeof b.inputUsd==='number'&&b.inputUsd>0&&typeof b.outputUsd==='number'
    ? ((b.outputUsd/b.inputUsd)-1)*100
    : null;
};
const fmtMoney=v=>typeof v==='number'?money.format(v):'—';
const clear=node=>{while(node.firstChild)node.removeChild(node.firstChild)};
function setText(id,value){const el=$(id);if(el)el.textContent=String(value)}
function cell(text,cls='',title=''){const td=document.createElement('td');td.textContent=String(text??'—');if(cls)td.className=cls;if(title)td.title=title;return td}
function freshnessLabel(value){return ({live:'CANLI',delayed:'GECİKMELİ',stale:'BAYAT',idle:'HAZIR',empty:'BOŞ'})[value]??'—'}
function statusClass(item){if(item.status==='positive')return 'pos';if(item.status==='unavailable')return 'muted';return 'neg'}
function moneyClass(value){return typeof value==='number'?(value>0?'pos':value<0?'neg':''):'muted'}
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
    if(state.sort==='spread')return (depthEdgePct(b)??-Infinity)-(depthEdgePct(a)??-Infinity);
    return (b.timestampMs??0)-(a.timestampMs??0);
  });
  return filtered;
}
function ensureSelection(){
  const all=state.data?.opportunities??[];
  if(state.selectedKey&&all.some(x=>x.key===state.selectedKey))return;
  state.selectedKey=all[0]?.key??null;
}
function renderOpportunities(){
  const items=filteredOpportunities();
  const body=$('opportunities');clear(body);
  $('oppEmpty').style.display=items.length?'none':'block';
  setText('oppShown',items.length+' aday');
  for(const item of items.slice(0,100)){
    const tr=document.createElement('tr');
    tr.classList.toggle('selected-row',item.key===state.selectedKey);
    tr.tabIndex=0;
    tr.title='Maliyet ayrıntısını görmek için seç';
    const choose=()=>{state.selectedKey=item.key;renderOpportunities();renderSelectedCandidate()};
    tr.addEventListener('click',choose);
    tr.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();choose()}});
    const dt=new Date(item.timestampMs);
    tr.append(cell(dt.toLocaleTimeString('tr-TR',{hour:'2-digit',minute:'2-digit',second:'2-digit'}),'muted'));
    tr.append(cell(short(item.token),'token',String(item.token??'')));
    tr.append(cell((item.buyMarket??'?')+' → '+(item.sellMarket??'?'),'route'));
    tr.append(cell(item.baseSymbol??'—','muted'));
    tr.append(cell(item.hopCount??'—','muted'));
    const depth=depthEdgePct(item);
    tr.append(cell(fmtPct(depth),typeof depth==='number'?(depth>0?'pos':depth<0?'neg':'muted'):'muted',depth===null?'Exact probe yok':'Exact first-probe gross return'));
    tr.append(cell(fmtMoney(item.firstProbeNetProfitUsd),item.verifiedClosedCycle?moneyClass(item.firstProbeNetProfitUsd):'muted'));
    const latest=item.latestNetProfitUsd;
    tr.append(cell(latest===null&&item.status==='unavailable'?'unavailable':fmtMoney(latest),moneyClass(latest),item.reason??''));
    tr.append(cell(fmtMoney(item.bestObservedNetProfitUsd),statusClass(item)));
    tr.append(cell(item.quoteCount??0,'muted'));
    tr.append(cell(short(item.blockNumber),'muted',String(item.blockNumber??'')));
    body.append(tr);
  }
}
const reasonLabels={
  'positive-after-explicit-costs':'Explicit maliyetlerden sonra pozitif.',
  'quoted-route-negative-before-explicit-costs':'Router output, gas ve araştırma tamponları eklenmeden önce bile input değerinin altında.',
  'gas-erased-quoted-edge':'Pozitif quoted edge vardı ancak gas maliyeti edge’i tamamen sildi.',
  'extra-cost-erased-remaining-edge':'Gas sonrası kalan edge, extra allowance ile negatife döndü.',
  'safety-margin-erased-remaining-edge':'Edge explicit maliyetleri karşılıyordu fakat safety margin sonrası negatife döndü.',
  'negative-after-explicit-costs':'Explicit araştırma maliyetleri sonrası net sonuç negatif.'
};
function setNetClass(id,value){
  const el=$(id);if(!el)return;
  el.classList.remove('pos','neg','muted');
  el.classList.add(typeof value==='number'?(value>0?'pos':value<0?'neg':'muted'):'muted');
}
function renderBreakdown(prefix,breakdown){
  const map={
    Input:'inputUsd',Output:'outputUsd',Gross:'grossQuotedEdgeUsd',Gas:'gasUsd',
    Extra:'extraCostsUsd',Safety:'safetyMarginUsd',Net:'netProfitUsd',Net2:'netProfitUsd'
  };
  for(const [suffix,key] of Object.entries(map)){
    const value=breakdown?.[key];
    setText(prefix+suffix,fmtMoney(value));
    if(suffix==='Net'||suffix==='Net2'||suffix==='Gross')setNetClass(prefix+suffix,value);
  }
  setText(prefix+'Reason',breakdown?reasonLabels[breakdown.reason]??String(breakdown.reason):'Bu candidate için sayısal executable quote yok.');
}
function renderSelectedCandidate(){
  ensureSelection();
  const item=(state.data?.opportunities??[]).find(x=>x.key===state.selectedKey);
  if(!item){
    setText('selectedCandidateTitle','Aday seçilmedi');
    setText('selectedCandidateMeta','Tablodan bir candidate seç.');
    setText('selectedCandidateStatus','—');
    renderBreakdown('probe',null);renderBreakdown('best',null);return;
  }
  setText('selectedCandidateTitle',(item.buyMarket??'?')+' → '+(item.sellMarket??'?')+' · '+short(item.token));
  const depth=depthEdgePct(item);
  setText('selectedCandidateMeta','depth '+fmtPct(depth)+' · marginal '+fmtMarginalPct(item.grossSpreadPct)+' · '+(item.baseSymbol??'base ?')+' · '+(item.hopCount??'?')+' hop · '+(item.quoteCount??0)+' exact quote · '+ago(item.timestampMs));
  setText('selectedCandidateStatus',item.status==='positive'&&item.verifiedClosedCycle?'VERIFIED POSITIVE':item.status==='unavailable'?'UNAVAILABLE':item.verifiedClosedCycle?'VERIFIED NEGATIVE':'LEGACY / UNVERIFIED');
  renderBreakdown('probe',item.firstProbeCostBreakdown);
  renderBreakdown('best',item.bestObservedCostBreakdown);
}
function renderTimings(items){
  const root=$('timings');clear(root);$('timingEmpty').style.display=items.length?'none':'block';
  setText('recentTimingCount',items.length+' kayıt');
  for(const item of items.slice(0,12)){
    const row=document.createElement('div');row.className='timing';
    const key=document.createElement('div');key.className='key';key.textContent=short(item.key);key.title=String(item.key??'');row.append(key);
    for(const [label,value] of [['queue',item.queueDelayMs],['prepare',item.preparationDurationMs],['ilk quote',item.firstQuoteDurationMs]]){
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
  svg.append(svgEl('path',{class:options.lineClass??'line',d}));
  root.append(svg);
}
function renderDualPnlChart(traces){
  const root=$('pnlChart');clear(root);
  const first=traces?.firstProbe??[],best=traces?.bestObserved??[];
  const values=[...first,...best].map(x=>x.netProfitUsd).filter(Number.isFinite);
  if(values.length<2){
    const d=document.createElement('div');d.className='empty';d.style.display='block';d.textContent='Candidate P&L serisi için veri bekleniyor.';root.append(d);return;
  }
  const w=600,h=210,pad=14,min=Math.min(0,...values),max=Math.max(0,...values);
  const range=(max-min)||1;
  const svg=svgEl('svg',{viewBox:`0 0 ${w} ${h}`});
  for(let i=0;i<4;i++){const y=pad+(h-pad*2)*(i/3);svg.append(svgEl('line',{class:'gridline',x1:pad,x2:w-pad,y1:y,y2:y}))}
  if(min<0&&max>0){const y=h-pad-(h-pad*2)*((0-min)/range);svg.append(svgEl('line',{class:'zeroline',x1:pad,x2:w-pad,y1:y,y2:y}))}
  const draw=(series,cls)=>{
    if(!series.length)return;
    const coords=series.map((point,i)=>{
      const x=series.length===1?w/2:pad+(w-pad*2)*(i/(series.length-1));
      const y=h-pad-(h-pad*2)*((point.netProfitUsd-min)/range);
      return [x,y];
    });
    if(coords.length===1){svg.append(svgEl('circle',{class:cls,cx:coords[0][0],cy:coords[0][1],r:3}));return}
    const d=coords.map((p,i)=>(i?'L':'M')+p[0].toFixed(1)+' '+p[1].toFixed(1)).join(' ');
    svg.append(svgEl('path',{class:cls,d}));
  };
  draw(first,'probe-pnl-line');draw(best,'best-pnl-line');root.append(svg);
}
const phaseLabels={
  queueDelay:'queue',preparation:'preparation',firstQuote:'first quote',
  sizingBarrierWait:'sizing barrier',sizingQueueWait:'sizing queue',sizingExecution:'sizing execution'
};
const simLabels={
  blockRead:'block read',buySimulation:'buy simulation',sellSimulation:'sell simulation',
  buyGasEstimate:'buy gas estimate',sellGasEstimate:'sell gas estimate',gasPrice:'gas price',blockConfirm:'block confirm'
};
function renderPipeline(pipeline){
  const phases=pipeline?.phases??{};
  const bind=(key,medianId,p95Id)=>{setText(medianId,fmtMs(phases[key]?.medianMs));setText(p95Id,fmtMs(phases[key]?.p95Ms))};
  bind('queueDelay','phaseQueueMedian','phaseQueueP95');
  bind('preparation','phasePreparationMedian','phasePreparationP95');
  bind('firstQuote','phaseQuoteMedian','phaseQuoteP95');
  bind('sizingBarrierWait','phaseBarrierMedian','phaseBarrierP95');
  bind('sizingQueueWait','phaseSizingQueueMedian','phaseSizingQueueP95');
  bind('sizingExecution','phaseSizingMedian','phaseSizingP95');
  const dominant=pipeline?.dominantPhase;
  setText('dominantPhase',dominant?'dominant: '+(phaseLabels[dominant.key]??dominant.key)+' · '+fmtMs(dominant.medianMs):'dominant —');

  const simulation=pipeline?.simulation??{};
  const dominantSim=pipeline?.dominantSimulationStep;
  setText('dominantSimulation',dominantSim?'dominant: '+(simLabels[dominantSim.key]??dominantSim.key)+' · '+fmtMs(dominantSim.medianMs):'dominant —');
  const root=$('simulationBars');clear(root);
  const entries=Object.entries(simLabels).map(([key,label])=>({key,label,median:simulation[key]?.medianMs,p95:simulation[key]?.p95Ms})).filter(x=>typeof x.median==='number');
  const max=Math.max(1,...entries.map(x=>x.median));
  if(!entries.length){
    const empty=document.createElement('div');empty.className='empty';empty.style.display='block';empty.textContent='Yeni profilli quote örneği bekleniyor.';root.append(empty);return;
  }
  for(const item of entries){
    const row=document.createElement('div');row.className='sim-row';
    const label=document.createElement('span');label.textContent=item.label;
    const track=document.createElement('div');track.className='sim-track';
    const bar=document.createElement('div');bar.className='sim-bar';bar.style.width=Math.max(2,(item.median/max)*100)+'%';track.append(bar);
    const value=document.createElement('strong');value.textContent=fmtMs(item.median)+' / '+fmtMs(item.p95);
    row.append(label,track,value);root.append(row);
  }
}

function renderRunControls(data){
  const select=$('runSelect');
  if(select){
    const wanted=state.runId;
    clear(select);
    const current=document.createElement('option');current.value='current';current.textContent='Current run';select.append(current);
    for(const run of data.run?.recentRuns??[]){
      const option=document.createElement('option');
      option.value=run.runId;
      option.textContent=(run.runId===data.run.currentRunId?'Current · ':'')+run.engineVersion+' · '+short(run.runId);
      select.append(option);
    }
    const all=document.createElement('option');all.value='all';all.textContent='Tüm runlar';select.append(all);
    select.value=[...select.options].some(x=>x.value===wanted)?wanted:'current';
    state.runId=select.value;
  }
  const selected=data.run?.selectedRunId;
  setText('runSummary',selected
    ? ` Run: ${short(selected)} · ${data.run.engineVersion??'unknown engine'} · yalnız bu run gösteriliyor.`
    : ' Tüm runlar birlikte gösteriliyor.');
  const current=data.runComparison?.current;
  const previous=data.runComparison?.previous;
  setText('currentRunBenchmark',current?fmtMs(current.lastTickDurationMs):'Current —');
  setText('currentRunMeta',current?current.engineVersion+' · '+short(current.runId):'—');
  setText('previousRunBenchmark',previous?fmtMs(previous.lastTickDurationMs):'Previous —');
  setText('previousRunMeta',previous?previous.engineVersion+' · '+short(previous.runId):'—');
}

function renderSpotlight(item){
  if(!item){
    setText('spotlightRoute','Verified pozitif cycle bekleniyor');
    setText('spotlightMeta','Amount-sensitive quote oluştuğunda burada özetlenecek.');
    setText('spotlightNet','—');$('spotlight').classList.remove('has-positive');return;
  }
  $('spotlight').classList.add('has-positive');
  setText('spotlightRoute',(item.buyMarket??'?')+' → '+(item.sellMarket??'?')+' · '+short(item.token));
  setText('spotlightMeta','depth '+fmtPct(depthEdgePct(item))+' · '+fmtMoney(item.latestInputUsd)+' input · '+ago(item.timestampMs)+' · block '+short(item.blockNumber));
  setText('spotlightNet',fmtMoney(item.latestNetProfitUsd));
}
function render(data){
  state.data=data;ensureSelection();renderRunControls(data);
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
  setText('quoteLatencyMetric',fmtMs(data.radar.medianFirstQuoteMs)+' / '+fmtMs(data.radar.p95FirstQuoteMs));
  setText('rpcMetric',fmtMs(data.radar.medianRpcLatencyMs)+' / '+fmtMs(data.radar.p95RpcLatencyMs));
  setText('timingCount',data.timings.length+' aday');
  setText('firstMedian',fmtMs(data.radar.medianFirstQuoteMs));
  setText('firstP95',fmtMs(data.radar.p95FirstQuoteMs));
  setText('sizingMedian',fmtMs(data.radar.medianSizingMs));
  setText('sizingP95',fmtMs(data.radar.p95SizingMs));
  setText('missRate',fmtPct(data.radar.missedDeadlineRatePct));
  setText('missP95',fmtMs(data.radar.p95DeadlineMissMs));
  setText('rpcCount',data.rpcLatency.length+' örnek');
  setText('rpcLatest',data.rpcLatency[0]?data.rpcLatency[0].method+' · '+nf.format(data.rpcLatency[0].durationMs)+' ms':'—');

  const traces=data.pnlTraces??{firstProbe:[],bestObserved:[]};
  setText('pnlCount',traces.firstProbe.length+' aday');
  const firstLatest=traces.firstProbe.at(-1),bestLatest=traces.bestObserved.at(-1);
  setText('pnlLatest',firstLatest?'probe '+fmtMoney(firstLatest.netProfitUsd)+' · best '+fmtMoney(bestLatest?.netProfitUsd):'—');

  setText('countLaunches',nf.format(data.counts.launches));setText('countMarkets',nf.format(data.counts.marketSnapshots));
  setText('countScreens',nf.format(data.counts.routeScreens));setText('countQuotes',nf.format(data.counts.executableQuotes));
  setText('countLifecycle',nf.format(data.counts.lifecycleRows));setText('countRpc',nf.format(data.counts.rpcSamples));
  setText('uniqueTokens',nf.format(data.radar.uniqueTokens));setText('unavailableCount',nf.format(data.radar.unavailableQuotes));
  setText('analysisCap','analysis cap '+nf.format(data.window.analysisRowCap)+' / tablo');

  const runtime=data.runtime??{};
  setText('runtimeTick',runtime.lastTickAtMs?'son tick '+ago(runtime.lastTickAtMs):'tick bekleniyor');
  setText('runtimeQueued',nf.format(runtime.queued??0));setText('runtimeDropped',nf.format(runtime.droppedStale??0));
  setText('runtimeProbes',nf.format(runtime.probesCompleted??0)+' / '+nf.format(runtime.probesStarted??0));
  setText('runtimeSizing',nf.format(runtime.sizingCompleted??0)+' / '+nf.format(runtime.sizingStarted??0));
  setText('runtimeProbeConcurrency',runtime.probeConcurrency??'—');setText('runtimeSizingConcurrency',runtime.sizingConcurrency??'—');
  setText('runtimeSizingQuoteConcurrency',runtime.sizingQuoteConcurrency??'—');
  setText('runtimeDuration',fmtMs(runtime.tickDurationMs));setText('runtimeValuation',nf.format(runtime.valuationFetches??0));

  const truncated=Object.values(data.window.truncated).some(Boolean);
  setText('qualityNote',truncated?'Analiz satır sınırına ulaştı; bazı oranlar kısmi olabilir. Quote tamamlanması capture/inclusion değildir.':'Quote tamamlanması capture/inclusion değildir.');
  renderSpotlight(data.radar.latestPositiveOpportunity);
  renderOpportunities();renderSelectedCandidate();renderPipeline(data.pipeline);renderTimings(data.timings);
  renderSeriesChart('rpcChart',data.rpcLatency.slice(0,100).reverse().map(x=>({value:x.durationMs})),{empty:'RPC örneği bekleniyor.'});
  renderDualPnlChart(traces);
}
async function refresh(){
  if(state.paused)return;
  try{
    const r=await fetch(`/api/snapshot?limit=500&windowSeconds=${state.windowSeconds}&runId=${encodeURIComponent(state.runId)}`,{cache:'no-store'});
    if(!r.ok)throw Error('HTTP '+r.status);
    render(await r.json());
  }catch(e){
    setText('dbStatus','HATA');setText('lastSeen',String(e));$('pulse').classList.remove('live','delayed');
  }
}
$('windowSelect').addEventListener('change',event=>{state.windowSeconds=Number(event.target.value)||60;refresh()});
$('runSelect').addEventListener('change',event=>{state.runId=event.target.value||'current';state.selectedKey=null;refresh()});
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
refresh();setInterval(refresh,2000);
