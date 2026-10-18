import {DIMENSIONS} from './workbench-core.js';
import {element} from './topic-align.js';
import {buildXlsx,downloadXlsx} from './xlsx.js';
import {assessmentBasisSheet} from './assessment-export.js';
const ORDER=['sh','sz','bj'];
const GUIDE_LABELS={sh:'上交所 14号',sz:'深交所 17号',bj:'北交所 11号'};
// Display summaries only. Assessment and the expanded view always use the full ruleset text.
const BRIEFS={
  pollutants:'披露主体或其重要控股子公司被列入环境信息依法披露企业名单的，披露污染物及受控物质排放、处理措施、减排目标和重大处罚等。',
  waste:'生产经营产生的废弃物对环境有重大影响的，披露有害、无害废弃物总量和密度、处理情况及减排目标措施。',
  biodiversity:'生产经营对生态系统和生物多样性有重大影响的，披露生态保护、修复、监测和风险管理措施及成效。',
  environment_compliance:'披露环境事件风险评估、预防管理措施及应急预案；发生突发重大环境事件，或因环境事件受到重大行政处罚、被追究刑事责任的，披露相关情况、影响及整改。',
  energy:'披露按类型划分的直接、间接能源总能耗量、结构及强度，清洁能源种类、总量和占比，节能目标、措施及能源使用困难（如有）。',
  water:'披露耗水总量与强度、节水目标和措施、水回收利用及用水困难（如有）。',
  circular_economy:'披露循环经济目标和计划、资源节约与利用率提升、可再生资源使用、废弃物预防减少及回收利用措施，以及进展成效、相关用量和比例。',
  rural_revitalization:'披露支持乡村振兴的措施、成果、投入金额、受益群体范围及数量和对品牌业务的影响；在乡村和脱贫地区业务占比较高的，说明乡村振兴及巩固拓展脱贫攻坚成果与公司战略的衔接。',
  social_contribution:'披露公益慈善、志愿活动的资金、人员和时间投入、取得效果及对品牌和业务的影响。',
  innovation:'在不涉及国家安全、国家秘密并兼顾商业秘密保护的前提下，鼓励自愿披露创新战略、研发管理、投入和人员、专利、研发成果与应用影响；披露创新目标涉及投入金额的，同时说明资金筹措安排及保障措施。',
  technology_ethics:'从事生命科学、人工智能等科技伦理敏感领域科研或技术开发的，披露伦理规范、制度落实、审查机制、违规整改（如有）及培训宣传。',
  supply_chain:'披露供应链风险管理目标、应对机制和措施成效，及保障供应链安全的举措；鼓励披露可持续供应链行动。',
  product_quality:'披露产品和服务安全质量体系、制度执行、措施及认证，重大安全质量责任事故的性质、影响、损害金额和应对进展（如有），售后召回制度及投诉渠道、流程和处理情况；鼓励金融、医疗、电力、通讯、公用事业等行业披露产品服务可获得性。',
  data_privacy:'披露数据安全及客户隐私保护制度、运行和措施；发生数据安全事件或客户隐私泄露事件的，披露具体情况、影响、涉及金额、应对措施及进展。',
  employees:'披露员工权益和构成、聘用待遇、职业健康与安全，以及职业发展、培训投入和覆盖情况。',
  due_diligence:'鼓励披露识别和应对可持续发展负面影响或风险的尽职调查，包括责任主体、范围、程序和应对情况。',
  stakeholder_communication:'披露利益相关方沟通制度、意见反馈渠道和执行，以及沟通方式、频率与内容。',
  anti_bribery:'披露反贿赂及反贪污制度、举报者保护、风险评估和培训覆盖；发生相关事件的，披露处理、合同及诉讼情况。',
  anti_unfair_competition:'披露防范虚假宣传、垄断、侵犯商业秘密等行为的制度及措施；涉及诉讼或重大处罚的，披露金额、处理和整改。'
};
export function topicComparison(rulesets){return rulesets.sh.topics.map(topic=>({topicId:topic.id,topicName:topic.name,...Object.fromEntries(ORDER.map(id=>[id,rulesets[id].topics.find(t=>t.id===topic.id)]))}));}
function chineseNumber(text){if(/^\d+$/.test(text))return text;const units={'十':10,'百':100,'千':1000},digits={'〇':0,'零':0,'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9};let total=0,n=0;for(const c of text){if(c in digits)n=digits[c];else if(c in units){total+=(n||1)*units[c];n=0;}else return text;}return String(total+n);}
export function formatClause(text){return String(text).replace(/第([〇零一二三四五六七八九十百千\d]+)条/g,(_,n)=>`第${chineseNumber(n)}条`);}
export function briefRequirement(topic){if(topic.id==='sme_fair')return topic.requirement;if(topic.id==='climate')return '按第二章及本节披露气候相关治理、战略、影响、风险和机遇管理、指标与目标，以及气候适应性、转型计划、温室气体排放总量和范围1、范围2排放、核算口径与减排措施成效；涉及碳信用和交易的，按条款披露。鼓励有条件披露范围3、情景分析及第三方核查；披露低碳新技术、新产品、新服务及相关研发进展时，须客观审慎披露相关情况。';return BRIEFS[topic.id]||topic.requirement;}
function cleanCopy(text){return formatClause(text).replaceAll('本地第','第').replace('全部上市公司（产品不细分板块）','全部上市公司').replace('6章62条；本地原件未包含第59条所述附表','6章62条；第59条引用议题附表，附表原文暂缺。');}
function dateLabel(iso){const [year,month,day]=iso.split('-');return `${year}年${Number(month)}月${Number(day)}日`;}
const differenceCache=new WeakMap();
function comparable(text){const chars=[],positions=[];for(let i=0;i<text.length;i++){if(/[\s，、；。（）()／\/]/u.test(text[i]))continue;chars.push(text[i]);positions.push(i);}return {chars,positions};}
function markPair(a,b,left,right){
  let prefix=0;while(prefix<a.chars.length&&prefix<b.chars.length&&a.chars[prefix]===b.chars[prefix])prefix++;
  let endA=a.chars.length,endB=b.chars.length;while(endA>prefix&&endB>prefix&&a.chars[endA-1]===b.chars[endB-1]){endA--;endB--;}
  const m=endA-prefix,n=endB-prefix,cols=n+1,dp=new Uint16Array((m+1)*cols);
  for(let i=m-1;i>=0;i--)for(let j=n-1;j>=0;j--)dp[i*cols+j]=a.chars[prefix+i]===b.chars[prefix+j]?dp[(i+1)*cols+j+1]+1:Math.max(dp[(i+1)*cols+j],dp[i*cols+j+1]);
  if(m+n&&2*dp[0]/(m+n)<0.55){for(let i=prefix;i<endA;i++)left[a.positions[i]]=true;for(let j=prefix;j<endB;j++)right[b.positions[j]]=true;return;}
  let i=0,j=0;while(i<m&&j<n){if(a.chars[prefix+i]===b.chars[prefix+j]){i++;j++;}else if(dp[(i+1)*cols+j]>=dp[i*cols+j+1]){left[a.positions[prefix+i]]=true;i++;}else{right[b.positions[prefix+j]]=true;j++;}}
  while(i<m){left[a.positions[prefix+i]]=true;i++;}while(j<n){right[b.positions[prefix+j]]=true;j++;}
}
export function differencePieces(text,values){
  let masks=differenceCache.get(values);if(!masks){masks=values.map(v=>Array(v.length).fill(false));const peers=values.map(comparable);for(let i=0;i<values.length;i++)for(let j=i+1;j<values.length;j++)markPair(peers[i],peers[j],masks[i],masks[j]);differenceCache.set(values,masks);}
  const index=values.indexOf(text),mask=masks[index]||Array(text.length).fill(false),pieces=[];
  for(let i=0;i<text.length;i++){const different=mask[i],last=pieces.at(-1);if(last&&last.different===different)last.text+=text[i];else pieces.push({text:text[i],different});}return pieces;
}
function highlighted(doc,parent,text,values){for(const part of differencePieces(text,values))parent.append(element(doc,part.different?'strong':'span',part.text));}
function researchWording(topic){return topic.requirement.match(/(?:已取得的|是否取得必要的)审批或认证、(?:已具备的|是否已具备)规模化生产能力/u)?.[0]||'';}
export function knowledgeRows(rulesets,data){
  const topics=topicComparison(rulesets).map(t=>({kind:'topic',id:t.topicId,title:t.topicName,dimension:t.sh.dimension,topics:ORDER.map(ex=>t[ex])}));
  const transition=data.transition.rows.map(row=>({kind:'transition',id:row.id,title:row.title,values:ORDER.map(ex=>cleanCopy(row[ex]))}));
  const structural=title=>data.exchange_diff.structuralDiff.find(row=>row.dimension===title);
  const attributes=[{kind:'disclosure',id:'boards',title:'适用板块',values:ORDER.map(ex=>cleanCopy(structural('适用板块')[ex]))},
    {kind:'disclosure',id:'scope',title:'披露属性',values:ORDER.map(ex=>data.disclosure.rows.find(row=>row.exchange===ex).content)},
    {kind:'disclosure',id:'structure',title:'条文结构',values:ORDER.map(ex=>cleanCopy(structural('条文结构')[ex]))}];
  return [...attributes,...transition,...topics];
}
export function rowCategory(row){return row.kind==='topic'?DIMENSIONS[row.dimension]:row.kind==='transition'?'过渡指引':'披露属性';}
export function rowOverview(row){if(row.kind!=='topic')return row.values;return row.topics.map((topic,i)=>{let text=briefRequirement(topic);if(row.id==='climate'){const phrases=row.topics.map(researchWording);if(new Set(phrases).size>1&&phrases[i])text+='\n第28条研发口径：'+phrases[i];}return text;});}
export function knowledgeWorkbook(rulesets,data,references){
  const rows=knowledgeRows(rulesets,data),arrangements=[['类别','事项',...ORDER.map(ex=>GUIDE_LABELS[ex])]],comparison=[['类别','议题','对应条款',...ORDER.map(ex=>GUIDE_LABELS[ex])]],originals=[['类别','议题','交易所','对应条款','条文原文','来源','版本','施行日期']],sources=[['交易所','指引名称','文号','发布日期','施行日期','版本说明']];
  for(const row of rows){if(row.kind!=='topic'){arrangements.push([rowCategory(row),row.title,...row.values]);continue;}
    const clauses=row.topics.map(t=>t.clause),clause=new Set(clauses).size===1?clauses[0]:clauses.map((v,i)=>GUIDE_LABELS[ORDER[i]]+'：'+v).join('；');comparison.push([rowCategory(row),row.title,clause,...row.topics.map(t=>t.requirement)]);
    row.topics.forEach((t,i)=>{const g=rulesets[ORDER[i]].guideline;for(const article of t.sourceText.split('\n\n')){const clause=article.match(/^第[〇零一二三四五六七八九十百千\d]+条/u)?.[0]||t.clause;originals.push([rowCategory(row),row.title,GUIDE_LABELS[ORDER[i]],formatClause(clause),article,g.name,g.version,g.effectiveDate]);}});}
  for(const ex of ORDER){const g=rulesets[ex].guideline;sources.push([GUIDE_LABELS[ex],g.name,g.number,g.publicationDate,g.effectiveDate,'2024年试行版'+(ex==='bj'?'；第59条引用议题附表，附表原文暂缺。':'')]);}
  const sheets=[{name:'披露属性与过渡指引',rows:arrangements,columnWidths:[14,30,70,70,70]},{name:'议题清单与条款映射',rows:comparison,columnWidths:[12,30,24,70,70,70]},{name:'议题条文原文',rows:originals,columnWidths:[12,30,20,35,100,60,25,20]},{name:'来源与版本',rows:sources,columnWidths:[20,70,26,20,20,65]}].map(sheet=>({...sheet,wrap:true,freezeRows:1,autoFilter:false,rowHeights:sheet.rows.map((row,r)=>r===0?32:Math.min(409,Math.max(26,...row.map((value,c)=>String(value).split('\n').reduce((lines,line)=>lines+Math.max(1,Math.ceil([...line].reduce((width,char)=>width+(char.charCodeAt(0)>255?2:1),0)/(sheet.columnWidths[c]-2))),0)*15+12))))}));
  if(references)sheets.push(assessmentBasisSheet(ORDER.map(ex=>references[ex])));return sheets;
}
export async function mountKnowledge(app,{download=downloadXlsx}={}){
  const {doc,rulesets,api}=app,$=id=>doc.getElementById(id);
  const names=['transition','exchange_diff','disclosure'];
  const data=Object.fromEntries(await Promise.all(names.map(async name=>[name,await api(`/data/knowledge/${name}.json`)])));
  const content=$('knowledge-content'),allRows=knowledgeRows(rulesets,data);content.replaceChildren();
  function renderTable(title,id,groups,withSources){
    const section=element(doc,'section',null,'knowledge-section'),heading=element(doc,'h2',title);heading.id=id+'-heading';section.setAttribute('aria-labelledby',heading.id);section.append(heading);
    const wrap=element(doc,'div',null,'table-scroll knowledge-scroll');wrap.tabIndex=0;wrap.setAttribute('role','region');wrap.setAttribute('aria-label',title+'，可滚动查看');
    const table=element(doc,'table',null,'knowledge-table');table.id=id;table.setAttribute('aria-label',title+' · 沪深北指引对照');
    const cols=element(doc,'colgroup');for(let i=0;i<5;i++)cols.append(element(doc,'col'));table.append(cols);
    const head=element(doc,'thead'),headRow=element(doc,'tr');for(const label of ['类别',withSources?'事项':'议题']){const th=element(doc,'th',label);th.scope='col';headRow.append(th);}
    for(const ex of ORDER){const th=element(doc,'th');th.scope='col';if(withSources){const details=element(doc,'details',null,'guide-source'),g=rulesets[ex].guideline;details.append(element(doc,'summary',GUIDE_LABELS[ex]),element(doc,'p',g.name,'guide-name'),element(doc,'p',`文号：${g.number}`),element(doc,'p',`版本：${g.effectiveDate.slice(0,4)}年试行版`),element(doc,'p',`施行日期：${dateLabel(g.effectiveDate)}`));th.append(details);}else th.textContent=GUIDE_LABELS[ex];headRow.append(th);}
    head.append(headRow);table.append(head);
    for(const [kind,dimension] of groups){const group=allRows.filter(r=>r.kind===kind&&(!dimension||r.dimension===dimension)),body=element(doc,'tbody');body.dataset.section=dimension||kind;
      for(const [index,row] of group.entries()){
        const tr=element(doc,'tr');tr.dataset.rowId=row.id;tr.dataset.kind=kind;if(index===0)tr.className='group-start';
        if(index===0){const category=element(doc,'th',null,'category-cell');category.scope='rowgroup';category.rowSpan=group.length;category.append(element(doc,'span',rowCategory(row),'category-name '+(dimension||kind)));tr.append(category);}
        const th=element(doc,'th',null,'topic-heading');th.scope='row';th.append(element(doc,'span',row.title,'topic-name'));tr.append(th);let expanded=false;
        if(kind==='topic'){const clauses=row.topics.map(t=>formatClause(t.clause).replace(/（[^）]*）/g,'')),reference=new Set(clauses).size===1?clauses[0]:clauses.map((v,i)=>`${GUIDE_LABELS[ORDER[i]]}：${v}`).join('；');th.append(element(doc,'span',reference,'topic-clause'));}
        const cells=ORDER.map((_,i)=>{const cell=element(doc,'td',null,'knowledge-cell');cell.id=`knowledge-${kind}-${row.id}-${ORDER[i]}`;tr.append(cell);return cell;});
        function paint(){const values=kind==='topic'&&expanded?row.topics.map(t=>t.sourceText):rowOverview(row);cells.forEach((cell,i)=>{cell.replaceChildren();cell.classList.toggle('show-source',expanded);const p=element(doc,'p');highlighted(doc,p,values[i],values);cell.append(p);});}
        paint();
        if(kind==='topic'){const button=element(doc,'button','条文原文','row-expand');button.type='button';button.setAttribute('aria-expanded','false');button.setAttribute('aria-controls',cells.map(c=>c.id).join(' '));button.setAttribute('aria-label',`展开${row.title}的完整披露要求`);button.addEventListener('click',()=>{expanded=!expanded;button.textContent=expanded?'收起原文':'条文原文';button.setAttribute('aria-label',`${expanded?'收起':'展开'}${row.title}的完整披露要求`);button.setAttribute('aria-expanded',String(expanded));paint();});th.append(button);}
        body.append(tr);
      }table.append(body);
    }wrap.append(table);section.append(wrap);content.append(section);
  }
  renderTable('披露属性与过渡指引','disclosure-comparison',[['disclosure',null],['transition',null]],true);
  renderTable('议题清单与条款映射','topic-comparison',[['topic','environment'],['topic','social'],['topic','governance']],false);
  const exportButton=$('export-knowledge');if(exportButton){exportButton.disabled=false;exportButton.addEventListener('click',async()=>{const status=$('knowledge-export-status');exportButton.disabled=true;try{const references=Object.fromEntries(await Promise.all(ORDER.map(async exchange=>[exchange,await api(`/api/assessment-reference?exchange=${exchange}`)])));download('沪深北可持续发展指引对照-2024试行版.xlsx',buildXlsx(knowledgeWorkbook(rulesets,data,references)));if(status){status.textContent='已导出披露对照、63组条文原文及与AI请求共用的评级依据。';status.hidden=false;}}catch(error){if(status){status.textContent='导出未完成：'+error.message;status.hidden=false;}}finally{exportButton.disabled=false;}});}
  return {data,rows:allRows};
}
