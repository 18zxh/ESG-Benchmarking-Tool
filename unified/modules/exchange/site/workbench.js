import {HK_CATEGORIES,OBLIGATIONS,hkObligation,projectRules,mountHkKnowledge} from './hk.js';
import {EXCHANGES,DIMENSIONS,MODES,STATUS_LABELS,newProject,applyRules,validateProject,canAssess,mergeResults,assessmentContext,rebindDocument,ProjectStore} from './workbench-core.js';
import {element,renderMappings} from './topic-align.js';
import {mountReview} from './review-ui.js';
import {mountExport} from './workbench-export.js';
import {mountKnowledge} from './knowledge.js';
import {hkHierarchyRows} from './hk-hierarchy.js';
import {mountBenchmark} from './benchmark.js';

export function routeName(hash){return String(hash).startsWith('#/benchmark')?'benchmark':String(hash).includes('/knowledge')?'knowledge':String(hash).includes('/workbench')?'workbench':'markets';}
export function routeMarket(hash){return String(hash).startsWith('#/hk/')?'hk':['markets','benchmark'].includes(routeName(hash))?null:'mainland';}
export function mountShell(doc,hostWindow){
  const sidebar=doc.getElementById('app-sidebar'),toggle=doc.getElementById('nav-toggle'),scrim=doc.getElementById('nav-scrim'),main=doc.getElementById('main-content');
  const narrow=hostWindow.matchMedia?.('(max-width: 1024px)');let navOpen=false;
  function navigation(open,returnFocus=false){navOpen=Boolean(open&&narrow?.matches);if(!sidebar)return;
    sidebar.classList.toggle('open',navOpen);sidebar.inert=Boolean(narrow?.matches&&!navOpen);main.inert=navOpen;
    toggle.setAttribute('aria-expanded',String(navOpen));toggle.setAttribute('aria-label',navOpen?'关闭导航':'打开导航');scrim.hidden=!navOpen;doc.body.classList.toggle('nav-open',navOpen);
    if(navOpen)sidebar.querySelector('a')?.focus();else if(returnFocus)toggle.focus();}
  toggle?.addEventListener('click',()=>navigation(!navOpen,true));scrim?.addEventListener('click',()=>navigation(false,true));
  narrow?.addEventListener('change',()=>navigation(false));
  doc.addEventListener('keydown',event=>{if(!navOpen)return;if(event.key==='Escape'){event.preventDefault();navigation(false,true);}
    if(event.key==='Tab'){const links=[toggle,...sidebar.querySelectorAll('a')],first=links[0],last=links.at(-1);if(event.shiftKey&&doc.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&doc.activeElement===last){event.preventDefault();first.focus();}else if(event.shiftKey&&doc.activeElement===links[1]){event.preventDefault();first.focus();}else if(!event.shiftKey&&doc.activeElement===first){event.preventDefault();links[1].focus();}}});
  for(const link of doc.querySelectorAll('[data-route]'))link.addEventListener('click',()=>{if(navOpen){navigation(false);main.focus({preventScroll:true});}});
  const apply=()=>{const name=routeName(hostWindow.location.hash),market=routeMarket(hostWindow.location.hash),entry=name==='markets';
    doc.body.classList.toggle('market-entry',entry);if(doc.getElementById('market-view'))doc.getElementById('market-view').hidden=!entry;
    doc.getElementById('workbench-view').hidden=name!=='workbench';doc.getElementById('knowledge-view').hidden=name!=='knowledge'||market==='hk';
    if(doc.getElementById('benchmark-view'))doc.getElementById('benchmark-view').hidden=name!=='benchmark';
    if(doc.getElementById('hk-knowledge-view'))doc.getElementById('hk-knowledge-view').hidden=name!=='knowledge'||market!=='hk';
    if(doc.getElementById('market-label'))doc.getElementById('market-label').textContent=name==='benchmark'?'横向对标':market==='hk'?'香港交易所':'大陆交易所';
    for(const link of doc.querySelectorAll('[data-route]')){link.hidden=name==='benchmark'?link.dataset.route!=='benchmark':link.dataset.route==='benchmark';link.href=link.dataset.route==='benchmark'?'#/benchmark':`#/${market||'mainland'}/${link.dataset.route}`;if(link.dataset.route===name)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');}};
  hostWindow.addEventListener('hashchange',apply);if(!hostWindow.location.hash)hostWindow.location.hash='#/markets';apply();navigation(false);return apply;
}
export async function request(path,data,fetcher=fetch){
  const response=await fetcher(path,data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  let value;try{value=await response.json();}catch{throw new Error('本机服务响应不完整，请检查服务是否仍在运行。');}
  if(!response.ok)throw new Error(value.error?.message||'请求未完成，请重试。');return value;
}
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function mountWorkbench(doc,hostWindow,{fetcher=hostWindow.fetch.bind(hostWindow),store=new ProjectStore(hostWindow.indexedDB),pollDelay=450}={}){
  const Option=(text,value)=>{const node=element(doc,'option',text);node.value=value;return node;};
  const $=id=>doc.getElementById(id),api=(path,data)=>request(path,data,fetcher);let project=newProject(),rules=null,providers=[],activeId=null,busy=false,previewSource='main',previewPage=1;
  const rulesets=Object.fromEntries(await Promise.all(['sh','sz','bj','hk'].map(async id=>[id,await api(`/data/ruleset/${id}.json`)])));
  const message=(text,error=false)=>{const node=$('app-message');node.textContent=text;node.className='message'+(error?' error':'');node.hidden=!text;};
  const guarded=handler=>(...args)=>Promise.resolve().then(()=>handler(...args)).catch(error=>message(error.message,true));
  const fields={'customer-name':'customerName','report-year':'reportYear','target-year':'targetYear',industry:'industry',board:'board','issuer-category':'issuerCategory','fiscal-year-start':'fiscalYearStart'};
  function sync(){for(const [id,key] of Object.entries(fields))project[key]=$(id).value.trim();if(project.exchange==='hk'&&rules){rules=projectRules(project.rulesetVersion===rulesets.hk.version?rulesets.hk:project.ruleSnapshot,project);}}
  function fill(){for(const [id,key] of Object.entries(fields))$(id).value=project[key]||'';$('exchange').value=project.exchange;}
  function switchStage(name){if(name==='assessment'&&!project.reports.main)return;if(name==='review'&&!project.topics.some(t=>t.assessment||t.status==='failed'))return;
    for(const stage of ['input','assessment','review'])$(stage+'-stage').hidden=stage!==name;
    for(const button of doc.querySelectorAll('[data-step]')){if(button.dataset.step===name)button.setAttribute('aria-current','step');else button.removeAttribute('aria-current');}if(name==='review')controller.onReviewVisible?.();}
  function renderBoards(){const board=$('board');board.replaceChildren();
    if(!rules){board.append(Option('请先选择交易所',''));board.disabled=true;return;}
    if(!rules.boardOptions.length){board.append(Option('不细分板块',''));board.disabled=true;project.board='';return;}
    board.append(Option('请选择板块',''));for(const option of rules.boardOptions)board.append(Option(option,option));board.disabled=busy;board.value=project.board;}
  function hkScopeStatus(row,topic,category){
    if(row.applicability[category]==='已废止')return '已废止（仅GEM保留）';
    if(topic.part==='B')return '强制披露';
    if(topic.part==='C')return '不遵守就解释';
    if(topic.id==='hk_ghg12')return 'FY2025起强制披露';
    if(topic.id==='hk_d36')return '鼓励披露';
    if(category==='largecap')return project.issuerCategory===category&&project.fiscalYearStart?OBLIGATIONS[hkObligation(topic,project)]:'FY2025不遵守就解释；FY2026起强制披露';
    return row.applicability[category]||'—';
  }
  function renderHkTopics(region){
    const rows=hkHierarchyRows(rulesets.hk),topics=new Map(rulesets.hk.topics.map(topic=>[topic.id,topic]));
    const scroll=element(doc,'div',null,'table-scroll hk-scope-scroll');scroll.tabIndex=0;scroll.setAttribute('role','region');scroll.setAttribute('aria-label','港交所议题范围与发行人适用属性，可横向滚动');
    const table=element(doc,'table',null,'hk-scope-table');table.setAttribute('aria-label','港交所议题检查范围');
    const caption=element(doc,'caption','按部分、议题、指标及条款查看三类发行人披露属性；当前发行人列可勾选检查范围。');table.append(caption);
    const colgroup=doc.createElement('colgroup');for(let i=0;i<5;i++)colgroup.append(doc.createElement('col'));table.append(colgroup);
    const head=element(doc,'thead'),header=element(doc,'tr');
    for(const label of ['部分','议题',...Object.values(HK_CATEGORIES)]){
      const th=element(doc,'th',null);th.scope='col';
      if(HK_CATEGORIES[project.issuerCategory]===label){th.classList.add('is-current');th.setAttribute('aria-current','true');th.append(element(doc,'span',label),element(doc,'small','当前发行人'));}
      else th.textContent=label;
      header.append(th);
    }
    head.append(header);table.append(head);const body=element(doc,'tbody');
    for(const row of rows){
      const topic=topics.get(row.id),tr=element(doc,'tr');tr.dataset.topicId=row.id;tr.dataset.part=row.part;
      if(row.rowSpan.part){tr.classList.add('hk-scope-part-start');const part=element(doc,'th',`${row.part}部分`,'hk-scope-part');part.scope='rowgroup';part.rowSpan=row.rowSpan.part;tr.append(part);}
      const detail=element(doc,'th',null,'hk-scope-topic');detail.scope='row';
      detail.append(element(doc,'span',row.topic,'hk-scope-topic-name'));
      if(row.metric&&row.metric!=='—')detail.append(element(doc,'span',row.metric,'hk-scope-metric'));
      if(row.clause)detail.append(element(doc,'small',row.clause,'hk-scope-clause'));
      tr.append(detail);
      for(const category of Object.keys(HK_CATEGORIES)){
        const cell=element(doc,'td',null,'hk-scope-status-cell');if(project.issuerCategory===category)cell.classList.add('is-current');const status=hkScopeStatus(row,topic,category);
        const state=project.issuerCategory===category?project.topics.find(item=>item.topicId===row.id):null;
        if(state&&status!=='已废止（仅GEM保留）'){
          const label=element(doc,'label',null,'hk-scope-select'),input=doc.createElement('input');input.type='checkbox';input.checked=Boolean(state.selected);input.disabled=busy;input.dataset.topicId=row.id;input.setAttribute('aria-label',`将${row.topic} ${row.metric==='—'?'':row.metric} ${row.clause}纳入检查范围`);
          input.addEventListener('change',()=>{state.selected=input.checked;refresh();});
          label.append(input,element(doc,'span','纳入检查'));cell.append(label);
        }
        cell.append(element(doc,'span',status,'hk-scope-status'+(status.startsWith('已废止')?' is-repealed':'')));
        tr.append(cell);
      }
      body.append(tr);
    }
    table.append(body);scroll.append(table);region.className='hk-scope-region';region.append(scroll);
  }
  function renderTopics(){const region=$('topics');region.replaceChildren();if(!rules){region.append(element(doc,'p','选择交易所后，加载对应指标及条款。','empty-state'));return;}
    if(project.exchange==='hk'){renderHkTopics(region);return;}
    for(const [dimension,label] of Object.entries(DIMENSIONS)){const group=element(doc,'div',null,'topic-group');group.append(element(doc,'h3',label));
      for(const topic of rules.topics.filter(t=>t.dimension===dimension)){const state=project.topics.find(t=>t.topicId===topic.id),line=element(doc,'label',null,'topic-option'),input=doc.createElement('input');input.type='checkbox';input.checked=state.selected;input.disabled=busy;input.dataset.topicId=topic.id;
        input.addEventListener('change',()=>{state.selected=input.checked;refresh();});const text=element(doc,'span',topic.name);text.append(element(doc,'small',topic.clause));if(project.exchange==='hk')text.append(element(doc,'small',OBLIGATIONS[hkObligation(topic,project)],'topic-obligation'));line.append(input,text);group.append(line);}region.append(group);}}
  function renderReports(){for(const source of ['main','annual']){const meta=project.reports[source],region=$(source+'-meta');region.replaceChildren();if(!meta){region.textContent='未上传文件';continue;}
    region.append(element(doc,'span',`${meta.name} · ${meta.pageCount} 页 · ${meta.parseMessage||'已登记'}`));if(meta.runtimeReady){const button=element(doc,'button','查看原页');button.type='button';button.addEventListener('click',guarded(()=>preview(source,1)));region.append(button);}}}
  function renderMapping(){renderMappings($('mapping-body'),project.topicMappings,rules||{topics:[]},{locked:busy,alignmentComplete:project.alignmentComplete,onPreview:page=>guarded(()=>preview('main',page))(),onChange:(id,row)=>{
      project.topicMappings=project.topicMappings.map(m=>m.id===id?row:m);project.mappingChangedAt=new Date().toISOString();renderMapping();refresh();}});}
  function refresh(){sync();const provider=providers.find(p=>p.id===activeId);project.providerId=activeId;if(!project.topics.some(t=>t.assessment))project.readingMode=provider?.mode||project.readingMode;
    project.contextMismatch=Boolean(project.assessmentContext&&project.assessmentContext!==assessmentContext(project));
    $('start-alignment').disabled=busy||!rules||!project.reports.main?.runtimeReady||!activeId;
    $('start-assessment').disabled=busy||!canAssess(project)||!project.reports.main?.runtimeReady||!activeId;
    $('select-all-topics').disabled=busy||!rules||(project.exchange==='hk'&&!project.issuerCategory);$('clear-optional-topics').disabled=busy||!rules||(project.exchange==='hk'&&!project.issuerCategory);
    let applicationValid=true;if(project.exchange==='hk'){try{validateProject(project,rules);}catch{applicationValid=false;}}
    $('export-project').disabled=!applicationValid||busy||project.contextMismatch||!rules||!project.customerName||!project.reports.main||!project.alignmentComplete;
    doc.querySelector('[data-step="assessment"]').disabled=!project.reports.main;doc.querySelector('[data-step="review"]').disabled=!project.topics.some(t=>t.assessment||t.status==='failed');
    $('go-review').disabled=doc.querySelector('[data-step="review"]').disabled;
    $('ruleset-label').textContent=rules?.exchange==='hk'?`${rules.guideline.name} · ${rules.topics.length}项指标 · FY2025及以后`:rules?`${rules.guideline.name.replace('上海证券交易所上市公司自律监管','上交所').replace('深圳证券交易所上市公司自律监管','深交所').replace('北京证券交易所上市公司持续监管','北交所')} · 2024年试行版`:'尚未选择交易所';
    $('reading-mode-label').textContent=project.readingMode?MODES[project.readingMode]:'';
    $('alignment-hint').textContent=busy?'正在处理，请等待当前操作完成。':project.alignmentComplete?`已完成自动对齐，共 ${project.topicMappings.length} 条映射；可进入自动初评。`:'配置项目、上传主报告并连接模型后，将自动对齐。';
    $('project-status').textContent=project.status;
    for(const id of ['main-file','annual-file','exchange','customer-name','report-year','target-year','industry','issuer-category','fiscal-year-start'])$(id).disabled=busy;
    for(const node of $('provider-form').querySelectorAll('input,select,button'))node.disabled=busy;
    $('board').disabled=busy||project.exchange==='hk'||!rules?.boardOptions.length;controller.onRefresh?.();
  }
  function renderProviders(status){providers=status.providers||[];activeId=status.currentProviderId||null;
    const provider=providers.find(p=>p.id===activeId);$('provider-summary').textContent=provider?`GLM · ${provider.model} · 配置已登记`:'尚未连接 GLM';refresh();}
  async function poll(path,onUpdate=()=>{}){for(;;){const value=await api(path);onUpdate(value);if(['completed','success','failed','stopped'].includes(value.status))return value;await wait(pollDelay);}}
  async function registerFile(file,source){
    if(file.size>30*1024*1024)throw new Error('文件超过30 MB，请选择较小的 PDF。');
    const response=await fetcher(`/api/native-documents?source=${source}`,{method:'POST',headers:{'Content-Type':'application/pdf','X-Filename':encodeURIComponent(file.name||'报告.pdf')},body:file});
    const meta=await response.json();if(!response.ok)throw new Error(meta.error?.message||'PDF登记失败。');meta.originalFile=file;meta.runtimeReady=false;meta.parseMessage='检查 PDF 中';
    const previous=project.reports[source];project.reports[source]=meta;renderReports();try{const job=await api('/api/parse-pdf',{documentId:meta.id});
    const result=await poll('/api/pdf-jobs/'+job.id,value=>{meta.parseMessage=`检查 ${value.processedPages}/${value.pageCount} 页`;renderReports();});
    if(result.status==='failed')throw new Error(result.error?.message||'解析未完成，请重新上传。');
    meta.runtimeReady=true;meta.parseMessage=result.hasUnreadablePages?'已就绪 · 无文字层页面由 GLM 读取':'PDF 已就绪';meta.parseIssues=result.issues;renderReports();return meta;
    }catch(error){if(previous)project.reports[source]=previous;else delete project.reports[source];renderReports();throw error;}
  }
  async function align(){sync();validateProject(project,rules);if(!activeId)throw new Error('请先登记并选择模型服务。');if(!project.reports.main?.runtimeReady)throw new Error('请先上传并完成主报告解析。');
    busy=true;refresh();switchStage('assessment');$('task-status').textContent='正在自动对齐主报告章节';
    try{const job=await api('/api/topic-align',{documentId:project.reports.main.id,exchange:project.exchange,providerId:activeId,issuerCategory:project.issuerCategory,fiscalYearStart:project.fiscalYearStart,board:project.board});
      const result=await poll('/api/topic-align/'+job.id);project.alignmentUsage=result.usage;if(result.status!=='completed')throw new Error(result.error?.message||'章节对齐失败，可重试。');
      const manual=project.exchange==='hk'?project.topicMappings.filter(m=>m.autoGenerated===false&&rules.topics.some(t=>t.id===m.topicId)):[];const manualIds=new Set(manual.map(m=>m.id));project.topicMappings=[...result.mappings.filter(m=>!manualIds.has(m.id)),...manual];project.alignmentComplete=true;project.alignedAt=new Date().toISOString();project.alignmentUsage=result.usage;project.alignmentVersion=result.alignmentVersion;
      $('task-status').textContent=`对齐完成：${result.mappings.length} 条映射${result.cached?' · 复用缓存':''}`;renderMapping();message('自动对齐完成。可直接初评，也可先修正映射。');
    }catch(error){$('task-status').textContent=`本次章节对齐失败：${error.message}`;throw error;}finally{busy=false;renderMapping();refresh();}}
  async function maybeAlign(){if(routeName(hostWindow.location.hash)==='benchmark')return;sync();if(!project.alignmentComplete&&!busy&&rules&&activeId&&project.reports.main?.runtimeReady){try{validateProject(project,rules);}catch{return;}await align();}}
  async function preview(source,page){const meta=project.reports[source];if(!meta?.runtimeReady)throw new Error('原 PDF 不在本机服务内存中，请恢复草稿或重新上传。');
    const number=Number(page);if(!Number.isInteger(number)||number<1||number>meta.pageCount)throw new Error('请输入原 PDF 范围内的物理页号。');
    previewSource=source;previewPage=number;$('pdf-title').textContent=`${source==='main'?'主报告':'公司年报'} · ${meta.name}`;$('pdf-page-number').max=meta.pageCount;$('pdf-page-number').value=number;
    const dialog=$('pdf-dialog');if(!dialog.open)dialog.showModal();$('pdf-message').textContent='正在本机渲染原页';let image=$('pdf-image');if(image)image.hidden=true;
    const result=await api('/api/pdf-page',{documentId:meta.id,page:number});if(previewSource!==source||previewPage!==number)return;
    if(!image){image=doc.createElement('img');image.id='pdf-image';$('pdf-page-content').append(image);}image.src=result.dataUrl;image.alt=`${meta.name} 的原始 PDF 第 ${number} 页`;image.hidden=false;$('pdf-message').textContent=`PDF 物理页 ${number}/${meta.pageCount} · 原件保持不变`;
    const link=$('download-pdf');if(link.dataset.objectUrl)hostWindow.URL.revokeObjectURL(link.dataset.objectUrl);const url=hostWindow.URL.createObjectURL(meta.originalFile);link.href=url;link.dataset.objectUrl=url;link.download=meta.name;
  }
  async function save(){sync();validateProject(project,rules);if(busy)message('任务仍在进行，当前已完成的结果会作为此刻快照保存。');await store.save(project);message('草稿已保存到当前浏览器。换浏览器、端口或清理站点数据后需使用原地址查找。');}
  async function restore(saved){if(busy)throw new Error('请先停止当前任务后再恢复。');
    const candidate=structuredClone(saved),candidateRules=candidate.ruleSnapshot||rulesets[candidate.exchange];
    if(!candidateRules||!Array.isArray(candidate.topics)||candidate.topics.length!==candidateRules.topics.length||!Array.isArray(candidate.topicMappings)||!candidate.reports)throw new Error('草稿结构不完整，当前项目保留。');
    validateProject(candidate,candidateRules);if((candidate.exchange==='hk'?'hk':'mainland')!==currentMarket)throw new Error('请先切换到草稿对应的交易所市场。');project=candidate;rules=projectRules(candidateRules,candidate);for(const meta of Object.values(project.reports))meta.runtimeReady=false;renderBoards();fill();busy=true;refresh();
    let missing=false;try{for(const source of ['main','annual']){const old=project.reports[source];if(!old)continue;if(!old.originalFile){old.runtimeReady=false;missing=true;continue;}
        const fresh=await registerFile(old.originalFile,source);fresh.publicationDate=old.publicationDate;rebindDocument(project,source,fresh);
      }
    }finally{busy=false;renderTopics();renderReports();renderMapping();refresh();controller.onRestore?.();}
    if(project.rulesetVersion!==rulesets[project.exchange].version)message('草稿使用历史规则版本，可继续查看和导出；重新评估请新建当前版本项目。',true);
    else message(missing?'草稿已恢复，但缺原 PDF。请在第一步重新上传后再查看原页。':'草稿已恢复，原 PDF 已重新登记；模型密钥需按服务状态重新连接。',missing);
  }
  async function showDrafts(){const drafts=(await store.list()).filter(p=>(p.exchange==='hk'?'hk':'mainland')===currentMarket);let panel=$('draft-panel');if(!panel){panel=element(doc,'section',null,'draft-panel');panel.id='draft-panel';doc.querySelector('#workbench-view .page-heading').after(panel);}panel.replaceChildren(element(doc,'h2','恢复本机草稿'));
    if(!drafts.length)panel.append(element(doc,'p','当前浏览器地址下尚无已保存草稿。','muted'));
    for(const draft of drafts){const button=element(doc,'button',`${draft.customerName} · ${draft.reportYear} → ${draft.targetYear} · ${EXCHANGES[draft.exchange]} ${draft.board} · ${draft.savedAt.slice(0,19).replace('T',' ')}`);button.type='button';button.addEventListener('click',guarded(async()=>{await restore(draft);panel.hidden=true;}));panel.append(button);}
    const close=element(doc,'button','收起草稿列表');close.addEventListener('click',()=>{panel.hidden=true;});panel.append(close);panel.hidden=false;
  }
  let currentMarket=routeMarket(hostWindow.location.hash)||'mainland';const marketProjects=new Map();
  function configureMarket(){const hk=currentMarket==='hk';$('exchange').replaceChildren(Option(hk?'香港交易所':'请选择交易所',hk?'hk':''));for(const ex of hk?[]:['sh','sz','bj'])$('exchange').append(Option(EXCHANGES[ex],ex));$('exchange').closest('label').hidden=hk;$('board').closest('label').hidden=hk;
    for(const id of ['hk-category-field','hk-fiscal-field','hk-application-hint'])$(id).hidden=!hk;
    $('clear-optional-topics').textContent=hk?'仅选基础强制项目':'仅选治理议题';$('topic-selection-note').textContent=hk?'先选择发行人类别和财政年度；当前类别列用于勾选本次检查范围，其他列显示知识库中的披露属性。':'治理议题默认勾选。检查范围表示本次要核对的内容，不等同官方适用性认定。';
    if(hk&&!project.exchange){applyRules(project,projectRules(rulesets.hk,project));project.topics.forEach(t=>t.selected=rulesets.hk.topics.find(r=>r.id===t.topicId).part==='B'||t.topicId==='hk_ghg12');rules=projectRules(project.rulesetVersion===rulesets.hk.version?rulesets.hk:project.ruleSnapshot,project);}
  }
  function setMarket(next){if(!next||next===currentMarket)return; if(busy)throw new Error('当前任务仍在进行，请先暂停并停止任务，再切换市场。');
    sync();marketProjects.set(currentMarket,{project,rules});currentMarket=next;const stored=marketProjects.get(next);project=stored?.project||newProject();rules=stored?.rules||null;
    configureMarket();renderBoards();fill();renderTopics();renderReports();renderMapping();refresh();switchStage('input');controller.onRestore?.(true);if($('draft-panel'))$('draft-panel').hidden=true;message('已切换市场；另一市场的当前项目仍保留在本页。');
  }
  const controller={get market(){return currentMarket;},setMarket,get project(){return project;},get rules(){return rules;},rulesets,get provider(){return providers.find(p=>p.id===activeId);},get busy(){return busy;},setBusy:value=>{busy=value;renderMapping();renderTopics();refresh();},api,doc,hostWindow,fetcher,store,message,guarded,poll,refresh,switchStage,preview,renderMapping,restore,save,align};
  for(const button of doc.querySelectorAll('[data-step]'))button.addEventListener('click',()=>switchStage(button.dataset.step));
  for(const id of Object.keys(fields))$(id).addEventListener('input',()=>{refresh();if(project.contextMismatch)message('项目信息已更改，与已有初评条件不一致。请恢复原字段，或重新初评所选议题；导出将在条件一致后恢复。',true);});
  $('board').addEventListener('change',guarded(maybeAlign));
  $('issuer-category').addEventListener('change',guarded(async()=>{project.issuerCategory=$('issuer-category').value;project.board=project.issuerCategory==='gem'?'GEM':project.issuerCategory?'主板':'';renderBoards();fill();rules=projectRules(rulesets.hk,project);const previous=new Map([...Object.entries(project.topicArchive||{}),...project.topics.map(t=>[t.topicId,t])]),known=new Set(rules.topics.map(t=>t.id));project.topicArchive=Object.fromEntries([...previous].filter(([id])=>!known.has(id)));project.topics=rules.topics.map(t=>previous.get(t.id)||{topicId:t.id,selected:false,status:'pending',comment:'',history:[]});project.ruleSnapshot=structuredClone(rules);const mappings=[...project.topicMappings,...(project.mappingArchive||[])];project.mappingArchive=mappings.filter(m=>!known.has(m.topicId));project.topicMappings=mappings.filter(m=>known.has(m.topicId));project.alignmentComplete=false;renderTopics();renderMapping();refresh();await maybeAlign();}));
  $('fiscal-year-start').addEventListener('change',guarded(async()=>{sync();renderTopics();refresh();await maybeAlign();}));
  let acceptedHash=hostWindow.location.hash;hostWindow.addEventListener('hashchange',()=>{try{const next=routeMarket(hostWindow.location.hash);if(busy&&next!==currentMarket)throw new Error('任务进行中，请先停止任务后再切换市场。');setMarket(next);acceptedHash=hostWindow.location.hash;}catch(error){hostWindow.location.hash=acceptedHash;message(error.message,true);}});
  $('exchange').addEventListener('change',guarded(async()=>{const next=$('exchange').value;if(next==='hk'&&currentMarket!=='hk'||next!=='hk'&&currentMarket==='hk')throw new Error('请选择当前市场的交易所。');
    if(project.exchange&&next!==project.exchange&&(project.alignmentComplete||project.topics.some(t=>t.selected))&&!hostWindow.confirm('切换交易所将重置映射、议题选择及当前评估。已上传原文件保留；需要保留当前项目时请先保存草稿。')){$('exchange').value=project.exchange;return;}
    if(next){rules=rulesets[next];applyRules(project,rules);project.board='';}else{rules=null;project.exchange='';project.topics=[];project.topicMappings=[];project.alignmentComplete=false;}
    renderBoards();renderTopics();renderMapping();refresh();await maybeAlign();}));
  for(const source of ['main','annual'])$(source+'-file').addEventListener('change',guarded(async()=>{const file=$(source+'-file').files?.[0];if(!file)return;
    if(project.reports[source]&&project.topics.some(t=>t.assessment)&&!hostWindow.confirm('若选择不同的文件，将重置当前评估与评论；重新上传同一原件会保留结果。请先保存要保留的草稿。')){$(source+'-file').value='';return;}
    const previous=project.reports[source];busy=true;refresh();try{const fresh=await registerFile(file,source);
      if(previous?.sha256===fresh.sha256){rebindDocument(project,source,fresh);}else{if(source==='main'){project.topicMappings=[];project.alignmentComplete=false;}
      for(const t of project.topics)Object.assign(t,{status:'pending',assessment:undefined,comment:'',history:[]});delete project.assessmentContext;project.status='已上传';}
    }finally{busy=false;$(source+'-file').value='';refresh();}await maybeAlign();}));
  $('provider-form').addEventListener('submit',event=>{event.preventDefault();guarded(async()=>{const key=$('provider-key').value;$('provider-key').value='';
    const status=await api('/api/providers',{name:'GLM',baseUrl:$('provider-url').value,model:$('provider-model').value,mode:'native',apiKey:key});renderProviders(status);message('模型服务已登记；实际可用性将在首次请求时验证。');await maybeAlign();})()});
  $('start-alignment').addEventListener('click',guarded(align));$('save-project').addEventListener('click',guarded(save));$('restore-project').addEventListener('click',guarded(showDrafts));
  $('new-project').addEventListener('click',()=>{if(busy){message('请先停止当前任务。',true);return;}if((project.reports.main||project.customerName)&&!hostWindow.confirm('新建项目会清空当前未保存内容，已保存草稿保留。'))return;project=newProject();rules=null;configureMarket();renderBoards();fill();renderReports();renderTopics();renderMapping();refresh();switchStage('input');controller.onRestore?.();message('已新建空项目。');});
  $('select-all-topics').addEventListener('click',()=>{for(const t of project.topics)t.selected=true;renderTopics();refresh();});
  $('clear-optional-topics').addEventListener('click',()=>{for(const t of project.topics)t.selected=project.exchange==='hk'?(rules.topics.find(r=>r.id===t.topicId).part==='B'||t.topicId==='hk_ghg12'):rules.topics.find(r=>r.id===t.topicId).governanceDefault;renderTopics();refresh();});
  $('close-pdf').addEventListener('click',()=>{$('pdf-dialog').close();});$('pdf-prev').addEventListener('click',guarded(()=>preview(previewSource,previewPage-1)));$('pdf-next').addEventListener('click',guarded(()=>preview(previewSource,previewPage+1)));$('pdf-page-number').addEventListener('change',guarded(()=>preview(previewSource,$('pdf-page-number').value)));
  $('go-review').addEventListener('click',()=>switchStage('review'));
  mountAssessment(controller);
  mountReview(controller);
  mountExport(controller);
  const status=await api('/api/status');configureMarket();renderBoards();fill();renderProviders(status);renderTopics();refresh();
  await mountKnowledge(controller);await mountHkKnowledge(controller);
  controller.benchmark=await mountBenchmark(controller);
  return controller;
}
export function mountAssessment(app){
  const {doc,api,guarded}=app,$=id=>doc.getElementById(id);let lastJob=null;const marketJobs=new Map();
  function paint(job){lastJob=job;marketJobs.set(app.project.id,job);mergeResults(app.project,job);const states={pending:'准备中',in_progress:'进行中',paused:'已暂停，当前请求完成后停留在边界',stopped:'已停止',completed:'已完成',failed:'任务失败'};
    const done=Object.values(job.results||{}).filter(r=>r.status!=='failed').length;
    $('task-status').textContent=`${states[job.status]||job.status} · ${job.phase==='reading'?'读取报告':job.phase==='reading_failed'?'读取未完成':job.phase==='assessing'?'逐议题初评':''} · ${done}/${job.topicIds?.length||0} 议题 · ${job.processedPages}/${job.totalPages} 页${job.mode==='compatible'?'（检索命中页）':''}`;
    $('task-progress').value=job.progress;const u=job.usage||{};$('task-usage').textContent=`收到 ${u.responses||0} 次上游响应 · 已报告 ${u.totalTokens||0} tokens${u.unreportedResponses?` · ${u.unreportedResponses} 次未报告用量`:''} · 费用以服务商账单为准`;
    $('task-errors').textContent=[...(job.errors||[]).map(e=>`${e.topicIds?.map(id=>app.rules.topics.find(t=>t.id===id)?.name||id).join('、')||'读取'}：${e.message}`),job.error?.message].filter(Boolean).join('\n');
    const running=['pending','in_progress','paused'].includes(job.status);$('pause-task').disabled=!['pending','in_progress'].includes(job.status);$('resume-task').disabled=job.status!=='paused';$('stop-task').disabled=!running;
    $('retry-task').disabled=running||!Object.values(job.results||{}).some(r=>r.status==='failed');app.refresh();app.onTaskUpdate?.(job);
  }
  async function follow(job){paint(job);const result=await app.poll('/api/pdf-review/'+job.id,paint);app.setBusy(false);paint(result);if(result.status==='completed')app.message('本次初评已结束。请进入人工复核，失败项可定向重试。');else if(result.status==='failed')app.message(result.error?.message||'任务未完成，已成功结果保留。',true);return result;}
  async function start(){app.refresh();validateProject(app.project,app.rules);if(!canAssess(app.project))throw new Error('请先完成自动章节对齐，并选择要核对的议题。');
    if(app.project.rulesetVersion!==app.rulesets[app.project.exchange].version)throw new Error('历史规则项目可查看和导出；重新初评请新建当前版本项目。');
    app.setBusy(true);app.switchStage('assessment');try{const p=app.project;
      if(p.contextMismatch){for(const t of p.topics)if(t.assessment){t.history??=[];t.history.push({assessment:structuredClone(t.assessment),status:t.status,at:new Date().toISOString(),reason:'项目信息更改前的初评'});t.assessment=undefined;t.status='pending';}p.contextMismatch=false;}
      p.assessmentContext=assessmentContext(p);p.modelService=app.provider?{name:app.provider.name,model:app.provider.model}:undefined;
      const job=await api('/api/pdf-review',{documentId:p.reports.main.id,annualDocumentId:p.reports.annual?.id,exchange:p.exchange,rulesetVersion:p.rulesetVersion,alignmentComplete:p.alignmentComplete,topicIds:p.topics.filter(t=>t.selected).map(t=>t.topicId),mappings:p.topicMappings,providerId:p.providerId,
        customerName:p.customerName,reportYear:p.reportYear,targetYear:p.targetYear,board:p.board,industry:p.industry,issuerCategory:p.issuerCategory,fiscalYearStart:p.fiscalYearStart});await follow(job);
    }finally{app.setBusy(false);}}
  async function retry(topicId){if(!lastJob)throw new Error('恢复后的项目请重新初评；原任务已不在当前页面。');app.setBusy(true);try{await follow(await api('/api/pdf-review/'+lastJob.id,{action:'retry',topicIds:topicId?[topicId]:undefined}));}finally{app.setBusy(false);}}
  for(const [id,action] of [['pause-task','pause'],['resume-task','resume'],['stop-task','stop']])$(id).addEventListener('click',guarded(async()=>{if(lastJob)paint(await api('/api/pdf-review/'+lastJob.id,{action}));}));
  $('start-assessment').addEventListener('click',guarded(start));$('retry-task').addEventListener('click',guarded(()=>retry()));app.retry=retry;
  app.onRestore=(marketSwitch=false)=>{lastJob=marketSwitch?marketJobs.get(app.project.id)||null:null;$('task-status').textContent='已恢复本机项目；需要新结果时重新初评。';for(const id of ['pause-task','resume-task','stop-task','retry-task'])$(id).disabled=true;};
  return {start,retry,get lastJob(){return lastJob;}};
}
if(typeof window!=='undefined'&&typeof document!=='undefined'){
  mountShell(document,window);mountWorkbench(document,window).then(controller=>{window.workbenchApp=controller;}).catch(error=>{const node=document.getElementById('app-message');node.textContent=error.message;node.className='message error';node.hidden=false;});
}
