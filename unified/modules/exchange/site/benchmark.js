import {element,renderMappings} from './topic-align.js';
import {buildXlsx,downloadXlsx} from './xlsx.js';
import {BenchmarkStore,benchmarkRows,newBenchmark,coverage,validateBenchmark,benchmarkSheets} from './benchmark-core.js';

export async function mountBenchmark(app,{store=new BenchmarkStore(app.hostWindow.indexedDB)}={}){
 const {doc,hostWindow,api,fetcher,guarded,message,poll}=app,$=id=>doc.getElementById(id);
 if(!$('benchmark-view'))return;
 const framework=await api('/data/benchmark/framework.json'),rules=app.rulesets.sh;
 let project=newBenchmark(rules,framework),running=false,uploading=false,stopRequested=false,activePath=null;
 const matrixScroll=$('benchmark-matrix').parentElement;
 const headerObserver=typeof hostWindow.ResizeObserver==='function'?new hostWindow.ResizeObserver(entries=>{const height=entries[0]?.contentRect.height;if(height)matrixScroll.style.setProperty('--benchmark-header-height',Math.ceil(height)+'px');}):null;
 function groupHeading(text,className,span){const th=element(doc,'th',null,className);th.rowSpan=span;th.scope='rowgroup';th.append(element(doc,'span',text,'benchmark-merge-label'));return th;}
 const settings=$('model-settings'),settingsHome=doc.createComment('shared model settings');
 settings.before(settingsHome);
 function routeSettings(){const peer=hostWindow.location.hash.startsWith('#/benchmark');if(peer)$('benchmark-model-slot').append(settings);else settingsHome.after(settings);}
 hostWindow.addEventListener('hashchange',routeSettings);routeSettings();
 const busy=()=>running||uploading;
 function sync(){project.name=$('benchmark-name').value.trim();project.industry=$('benchmark-industry').value.trim();}
 function fields(){ $('benchmark-name').value=project.name;$('benchmark-industry').value=project.industry; }
 function controls(){
  for(const id of ['benchmark-files','benchmark-name','benchmark-industry','benchmark-new','benchmark-restore','benchmark-import'])$(id).disabled=busy();
  $('benchmark-start').disabled=busy()||!project.reports.length||!app.provider||app.busy;
  $('benchmark-stop').disabled=!running;$('benchmark-pause').disabled=!running||!activePath?.startsWith('/api/benchmark/');
  $('benchmark-resume').disabled=true;
  $('benchmark-export').disabled=busy()||!project.reports.length;
  const mixedYears=new Set(project.reports.map(r=>r.reportYear).filter(Boolean)).size>1;
  $('benchmark-summary').textContent=project.reports.length?project.reports.length+'份报告 · '+project.reports.filter(r=>r.status==='completed').length+'份完成 · 21个议题 · 231个检查项'+(mixedYears?' · 报告年度不同，请按列查看期间':''):'上传公司报告并填写覆盖年度，开始横向对照。';
 }
 const previousRefresh=app.onRefresh;app.onRefresh=()=>{previousRefresh?.();controls();};
 function renderReports(){
  const body=$('benchmark-reports');body.replaceChildren();
  if(!project.reports.length){const tr=element(doc,'tr'),td=element(doc,'td','尚未上传报告。可一次选择多份 PDF，或复用大陆工作台中已保存的报告与映射。','empty-state');td.colSpan=6;tr.append(td);body.append(tr);}
  for(const r of project.reports){
   const tr=element(doc,'tr');tr.dataset.reportId=r.id;
   const target=element(doc,'td'),radio=doc.createElement('input');radio.type='radio';radio.name='benchmark-target';radio.checked=project.targetReportId===r.id;radio.disabled=busy();radio.setAttribute('aria-label',r.companyName+'设为本公司');radio.addEventListener('change',()=>{project.targetReportId=r.id;renderMatrix();});target.append(radio);tr.append(target);
   for(const [key,label] of [['companyName','公司名称'],['reportYear','报告覆盖年度']]){
    const td=element(doc,'td'),input=doc.createElement('input');input.value=r[key];input.maxLength=key==='reportYear'?4:160;if(key==='reportYear')input.inputMode='numeric';input.placeholder=key==='reportYear'?'如2025':'填写公司名称';input.setAttribute('aria-label',r.meta.name+' '+label);input.disabled=busy();
    input.addEventListener('input',()=>{r[key]=input.value.trim();if(Object.keys(r.results||{}).length){r.results={};r.status='pending';r.error='';message('公司或年度更改后，原对标判断已清除，请重新核对。');}});input.addEventListener('change',renderMatrix);td.append(input);tr.append(td);
   }
   const file=element(doc,'td');file.append(element(doc,'span',r.meta.name),element(doc,'small',r.meta.pageCount+'页'));tr.append(file);
   const status=element(doc,'td');status.append(element(doc,'span',r.statusText||({pending:'待处理',completed:'已完成',failed:'未完成',stopped:'已停止'}[r.status]||'待处理')));if(r.error)status.append(element(doc,'small',r.error,'benchmark-error'));tr.append(status);
   const actions=element(doc,'td');const map=element(doc,'button','查看映射');map.type='button';map.disabled=busy()||!r.alignmentComplete;map.addEventListener('click',()=>showMappings(r));actions.append(map);
   const remove=element(doc,'button','移除');remove.type='button';remove.disabled=busy();remove.addEventListener('click',()=>{project.reports=project.reports.filter(x=>x.id!==r.id);if(project.targetReportId===r.id)project.targetReportId='';$('benchmark-detail').hidden=true;render();});actions.append(remove);tr.append(actions);body.append(tr);
  }
  controls();
 }
 function showMappings(r){
  const region=$('benchmark-detail');region.hidden=false;region.replaceChildren(element(doc,'h2',r.companyName+' · 议题映射'),element(doc,'p','报告原章节归入统一21议题。映射用于定位，不直接代表二级检查项已披露。','muted'));
  const scroll=element(doc,'div',null,'table-scroll'),table=element(doc,'table'),head=element(doc,'thead'),tr=element(doc,'tr');for(const h of ['报告章节与出处','统一议题与条款','置信度','映射状态','操作'])tr.append(element(doc,'th',h));head.append(tr);const body=element(doc,'tbody');table.append(head,body);scroll.append(table);region.append(scroll);
  renderMappings(body,r.mappings,project.rules,{alignmentComplete:true,locked:busy(),onPreview:page=>guarded(()=>preview(r,page))(),onChange:(id,row)=>{r.mappings=r.mappings.map(m=>m.id===id?row:m);r.results={};r.status='pending';showMappings(r);renderMatrix();message('映射已修正，需重新核对该报告；其他公司结果保留。');}});
  region.scrollIntoView?.({block:'nearest'});
 }
 async function preview(r,page){const data=await api('/api/pdf-page',{documentId:r.meta.id,page});const region=$('benchmark-detail');const img=doc.createElement('img');img.src=data.dataUrl;img.alt=r.meta.name+' PDF物理第'+page+'页';region.append(img);}
 function showEvidence(r,row){
  const result=r.results?.[row.key],region=$('benchmark-detail');region.hidden=false;region.replaceChildren(element(doc,'h2',r.companyName+' · '+row.topicName+' · '+row.name));
  region.append(element(doc,'p',result.value+' · '+(result.reason||'')));
  for(const e of result.evidence||[]){const button=element(doc,'button',e.name+' · PDF第'+e.page+'页');button.type='button';button.disabled=!r.meta.runtimeReady;button.addEventListener('click',guarded(()=>preview(r,e.page)));region.append(button,element(doc,'blockquote',e.quote));}
  if(!result.evidence?.length)region.append(element(doc,'p','全文读取完成后未发现该检查项对应披露。','muted'));
  region.scrollIntoView?.({block:'nearest'});
 }
 function renderMatrix(){
  const table=$('benchmark-matrix');headerObserver?.disconnect();table.replaceChildren();table.style.minWidth=Math.max(820,744+project.reports.length*144)+'px';
  const columns=element(doc,'colgroup');for(const width of [60,176,160,180,...project.reports.map(()=>null),null]){const col=element(doc,'col');if(width)col.style.width=width+'px';columns.append(col);}table.append(columns);
  const head=element(doc,'thead'),header=element(doc,'tr');
  for(const h of ['类别','议题','一级','二级',...project.reports.map(r=>r.companyName||'待填公司'),'同业覆盖率']){const th=element(doc,'th',h);th.scope='col';header.append(th);}head.append(header);table.append(head);
  project.reports.forEach((r,i)=>{const th=header.children[4+i];th.append(element(doc,'small',(r.reportYear||'待填年度')+(r.id===project.targetReportId?' · 本公司':'')));if(r.id===project.targetReportId)th.classList.add('is-target');});
  const body=element(doc,'tbody');let previousTopic=null,previousDimension=null;
  for(const row of benchmarkRows(project.rules,project.framework)){
   const tr=element(doc,'tr');tr.dataset.key=row.key;
   if(row.dimension!==previousDimension){const th=groupHeading(row.dimensionName,'benchmark-dimension',project.rules.topics.filter(t=>t.dimension===row.dimension).length*11);tr.append(th);previousDimension=row.dimension;}
   if(row.topicId!==previousTopic){tr.classList.add('benchmark-topic-start');const th=groupHeading(row.topicName,'benchmark-topic',11);tr.append(th);previousTopic=row.topicId;}
   const level=project.framework.levels.find(l=>l.id===row.levelId);if(level.checks[0].id===row.id){tr.append(groupHeading(row.levelName,'benchmark-level',level.checks.length));}
   const label=element(doc,'th',row.name);label.scope='row';tr.append(label);
   for(const r of project.reports){const td=element(doc,'td'),result=r.results?.[row.key];if(r.id===project.targetReportId)td.classList.add('is-target');
    if(result?.status==='completed'&&['Yes','N'].includes(result.value)){const b=element(doc,'button',result.value,'benchmark-value '+(result.value==='Yes'?'is-yes':''));b.type='button';b.setAttribute('aria-label',(r.companyName||'公司')+' '+row.topicName+' '+row.name+' '+result.value+'，查看依据');b.addEventListener('click',()=>showEvidence(r,row));td.append(b);}
    else td.append(element(doc,'span',result?.status==='failed'?'未完成':'—','muted'));tr.append(td);
   }
   const c=coverage(project,row.key),td=element(doc,'td',null,'numeric');td.append(element(doc,'strong',c.rate===null?'—':(100*c.rate).toFixed(1)+'%'));if(c.total)td.append(element(doc,'small',c.completed?c.yes+'/'+c.completed+' 家披露':'尚无核对结果'),element(doc,'small','已核对 '+c.completed+'/'+c.total+' 家同业'));tr.append(td);body.append(tr);
  }
  table.append(body);headerObserver?.observe(head);controls();
 }
 function render(){renderReports();renderMatrix();}
 async function register(file,filename=file.name||'报告.pdf'){
  if(file.size>30*1024*1024)throw new Error('每份PDF不得超过30 MB。');
  const response=await fetcher('/api/native-documents?source=main',{method:'POST',headers:{'Content-Type':'application/pdf','X-Filename':encodeURIComponent(filename)},body:file});
  const meta=await response.json();if(!response.ok)throw new Error(meta.error?.message||'报告登记失败。');
  const job=await api('/api/parse-pdf',{documentId:meta.id}),result=await poll('/api/pdf-jobs/'+job.id);
  if(result.status!=='success')throw new Error(result.error?.message||'报告检查未完成。');
  return {...meta,originalFile:file,runtimeReady:true};
 }
 async function addFiles(files){
  if(busy()||app.busy)throw new Error('请等待当前任务结束。');uploading=true;app.setBusy(true);controls();
  try{for(const file of files){try{const meta=await register(file);if(project.reports.some(r=>r.meta.sha256===meta.sha256)){message(file.name+' 已存在，已跳过重复文件。');continue;}project.reports.push({id:crypto.randomUUID(),companyName:'',reportYear:'',meta,mappings:[],alignmentComplete:false,results:{},status:'pending'});render();}catch(e){message(file.name+'：'+e.message,true);}}}
  finally{uploading=false;app.setBusy(false);$('benchmark-files').value='';render();}
 }
 async function run(){
  sync();validateBenchmark(project);if(!app.provider)throw new Error('请先连接GLM。');if(app.busy||busy())throw new Error('请等待当前任务结束。');
  if(project.framework.version!==framework.version||project.rules.version!==rules.version)throw new Error('历史框架可查看与导出，重新核对请新建当前版本项目。');
  running=true;stopRequested=false;app.setBusy(true);renderReports();
  try{
   for(const r of project.reports){
    if(stopRequested)break;if(r.status==='completed')continue;
    try{
     if(!r.alignmentComplete){
      r.statusText='正在映射报告章节';renderReports();const job=await api('/api/topic-align',{documentId:r.meta.id,exchange:'sh',providerId:app.provider.id});activePath='/api/topic-align/'+job.id;
      const aligned=await poll(activePath);if(stopRequested||aligned.status==='stopped'){r.status='stopped';break;}if(aligned.status!=='completed')throw new Error(aligned.error?.message||'章节映射失败。');r.mappings=aligned.mappings;r.alignmentComplete=true;r.alignmentUsage=aligned.usage;
     }
     const job=await api('/api/benchmark',{documentId:r.meta.id,providerId:app.provider.id,companyName:r.companyName,reportYear:r.reportYear,industry:project.industry,mappings:r.mappings,alignmentComplete:true,frameworkVersion:project.framework.version,rulesetVersion:project.rules.version});activePath='/api/benchmark/'+job.id;
     const result=await poll(activePath,value=>{r.results=value.results||{};r.usage=value.usage;r.statusText=(value.phase==='checking'?'逐项核对':'读取报告')+' · '+value.processedPages+'/'+value.totalPages+'页 · '+Object.values(value.results||{}).filter(x=>x.status==='completed').length+'/231项';renderReports();$('benchmark-pause').disabled=value.status==='paused';$('benchmark-resume').disabled=value.status!=='paused';});
     r.results=result.results||{};r.usage=result.usage;r.status=result.status;r.statusText='';r.error=result.error?.message||'';render();
     if(result.status!=='completed'){if(!stopRequested)message(r.companyName+'未完成，后续公司已停止；成功结果已保留。'+r.error,true);break;}
    }catch(error){r.status='failed';r.statusText='';r.error=error.message;render();message(r.companyName+'：'+error.message+' 后续公司已停止，可重新连接后重试。',true);break;}
    finally{activePath=null;}
   }
  }finally{running=false;activePath=null;app.setBusy(false);render();if(!project.reports.some(r=>r.status!=='completed'))message('横向对标完成，可逐格查看依据或导出Excel。');}
 }
 async function restore(saved){
  if(busy()||app.busy)throw new Error('请等待当前任务结束。');
  if(!saved.framework?.levels||saved.rules?.topics?.length!==21||!Array.isArray(saved.reports))throw new Error('对标草稿结构不完整，当前项目保留。');
  project=structuredClone(saved);fields();uploading=true;app.setBusy(true);
  try{for(const r of project.reports){r.meta.runtimeReady=false;if(!r.meta.originalFile){r.error='缺少原PDF，请移除后重新上传';continue;}try{const old=r.meta;const fresh=await register(old.originalFile,old.name);if(fresh.sha256!==old.sha256)throw new Error('原报告指纹不一致');r.meta=fresh;for(const result of Object.values(r.results||{}))for(const e of result.evidence||[])e.documentId=fresh.id;}catch(e){r.error=e.message;}}}
  finally{uploading=false;app.setBusy(false);render();}
  message('横向对标草稿已恢复；现有判断保留，原报告按文件指纹重新登记。');
 }
 async function drafts(){
  const panel=$('benchmark-drafts');panel.hidden=false;panel.replaceChildren(element(doc,'h2','恢复横向对标草稿'));const saved=await store.list();if(!saved.length)panel.append(element(doc,'p','当前浏览器尚无已保存对标草稿。','muted'));
  for(const p of saved){const b=element(doc,'button',p.name+' · '+p.reports.length+'份报告 · '+p.savedAt.slice(0,16).replace('T',' '));b.type='button';b.addEventListener('click',guarded(async()=>{await restore(p);panel.hidden=true;}));panel.append(b);}
 }
 async function importProjects(){
  if(busy()||app.busy)throw new Error('请等待当前任务结束。');
  const candidates=[app.project,...await app.store.list()].filter(p=>p.exchange&&p.exchange!=='hk'&&p.reports?.main?.originalFile);
  const unique=[...new Map(candidates.map(p=>[p.reports.main.sha256,p])).values()],panel=$('benchmark-drafts');panel.hidden=false;panel.replaceChildren(element(doc,'h2','复用大陆报告与映射'));
  if(!unique.length)panel.append(element(doc,'p','尚无带原PDF的大陆项目，请先上传报告。','muted'));
  for(const p of unique){const button=element(doc,'button',p.customerName+' · '+p.reportYear+' · '+p.topicMappings.length+'条映射');button.type='button';button.addEventListener('click',guarded(async()=>{if(project.reports.some(r=>r.meta.sha256===p.reports.main.sha256))throw new Error('该报告已加入。');uploading=true;app.setBusy(true);controls();try{const meta=await register(p.reports.main.originalFile);project.reports.push({id:crypto.randomUUID(),companyName:p.customerName,reportYear:p.reportYear,meta,mappings:structuredClone(p.topicMappings),alignmentComplete:p.alignmentComplete,results:{},status:'pending'});panel.hidden=true;}finally{uploading=false;app.setBusy(false);render();}}));panel.append(button);}
 }
 $('benchmark-files').addEventListener('change',guarded(()=>addFiles([...$('benchmark-files').files])));
 $('benchmark-start').addEventListener('click',guarded(run));
 for(const [id,action] of [['benchmark-stop','stop'],['benchmark-pause','pause'],['benchmark-resume','resume']])$(id).addEventListener('click',guarded(async()=>{if(action==='stop')stopRequested=true;if(activePath)await api(activePath,{action});}));
 $('benchmark-save').addEventListener('click',guarded(async()=>{sync();await store.save(project);message('横向对标草稿已保存到当前浏览器，包含原报告、映射和已完成结果。');}));
 $('benchmark-restore').addEventListener('click',guarded(drafts));$('benchmark-import').addEventListener('click',guarded(importProjects));
 $('benchmark-new').addEventListener('click',()=>{if(busy()||app.busy)return;if(project.reports.length&&!hostWindow.confirm('新建对标将清空当前未保存内容，已保存草稿保留。'))return;project=newBenchmark(rules,framework);fields();$('benchmark-detail').hidden=true;$('benchmark-drafts').hidden=true;render();});
 $('benchmark-export').addEventListener('click',guarded(()=>{sync();downloadXlsx((project.name||'横向对标')+'.xlsx',buildXlsx(benchmarkSheets(project)));}));
 $('benchmark-clear-target').addEventListener('click',()=>{project.targetReportId='';renderReports();renderMatrix();});
 $('benchmark-industry').addEventListener('input',()=>{const value=$('benchmark-industry').value.trim();if(value!==project.industry){project.industry=value;const hadResults=project.reports.some(r=>Object.keys(r.results||{}).length);for(const r of project.reports){r.results={};r.status='pending';}if(hadResults){render();message('行业已更新，请重新核对。');}else controls();}});
 fields();render();
 return {get project(){return project;},addFiles,run,restore,store,render};
}
