import {hkHierarchyRows,renderHkHierarchy} from './hk-hierarchy.js';
import {element} from './topic-align.js';
import {buildXlsx,downloadXlsx} from './xlsx.js';
import {assessmentBasisSheet} from './assessment-export.js';
export const HK_CATEGORIES={largecap:'恒生综合大型股指数成分股',mainboard:'其他主板发行人',gem:'GEM发行人'};
export const OBLIGATIONS={mandatory:'强制披露',comply_explain:'不遵守就解释',voluntary:'自愿披露'};
export function hkObligation(topic,project){
  if(topic.part==='B'||topic.id==='hk_ghg12')return 'mandatory';
  if(topic.part==='C')return 'comply_explain';
  if(project.issuerCategory==='gem'||topic.id==='hk_d36')return 'voluntary';
  return project.issuerCategory==='largecap'&&project.fiscalYearStart>='2026-01-01'?'mandatory':'comply_explain';
}
export function projectRules(base,p){if(base?.exchange!=='hk')return base;const rules=structuredClone(base);rules.topics=rules.topics.filter(t=>!t.boards||t.boards.includes(p.issuerCategory==='gem'?'GEM':'主板'));for(const t of rules.topics){t.sourceText=p.issuerCategory==='gem'?t.sourceTextGem:t.sourceText;t.obligation=hkObligation(t,p);}return rules;}
const chunks=text=>Array.from({length:Math.max(1,Math.ceil(text.length/900))},(_,i)=>text.slice(i*900,(i+1)*900));
export function hkKnowledgeSheets(rules,references){const hierarchy=new Map(hkHierarchyRows(rules).map(row=>[row.id,row])),sheets=[
 {name:'分阶段披露安排',rows:[['发行人类别','范围1及范围2排放','其他Part D气候披露'],...Object.keys(HK_CATEGORIES).map(k=>[HK_CATEGORIES[k],'FY2025起强制',k==='largecap'?'FY2025不遵守就解释；FY2026起强制（第36段行业指标仍为鼓励披露）':k==='gem'?'自愿披露':'不遵守就解释，暂无升级时间表']),['年度口径','FY指2025年1月1日或以后开始的财政年度，而非报告发布年份。','大型股须上一财政年度全年为HSCLI成分股；一旦进入强制披露，此后退出指数仍持续适用。'],['适用范围','Part B对所有发行人强制；Part C按不遵守就解释。','Part D具体注释、宽免和条件仍须逐项核定；当前规则支持FY2025及以后。']],columnWidths:[35,70,100]},
 {name:'指标与条文',rows:[['部分','议题','指标','条款','主板中文条文','GEM中文条文','恒生综合大型股指数成分股','其他主板发行人','GEM发行人','适用板块'],...rules.topics.flatMap(t=>{const h=hierarchy.get(t.id),a=chunks(t.boards?'主板已废止':t.sourceText),b=chunks(t.sourceTextGem);return Array.from({length:Math.max(a.length,b.length)},(_,i)=>[t.part+'部分',h.topic,h.metric,t.clause,a[i]||'',b[i]||'',h.applicability.largecap,h.applicability.mainboard,h.applicability.gem,t.boards?'仅GEM':'主板及GEM']);})],columnWidths:[12,24,36,38,100,100,40,28,24,20]},
 {name:'来源与版本',rows:[['来源','链接','规则版本','文字处理'],...['主板','GEM'].map((board,i)=>[board+'上市规则附录C2',rules.guideline.sourceUrls?.[i]||'',rules.guideline.sourceEdition||'',rules.guideline.sourceLanguageNote||''])],columnWidths:[35,100,24,70]}
].map(s=>({...s,wrap:true,freezeRows:1,rowHeights:s.rows.map((row,i)=>i===0?32:Math.min(409,Math.max(30,...row.map((v,c)=>String(v).split('\n').reduce((n,line)=>n+Math.max(1,Math.ceil([...line].reduce((w,ch)=>w+(ch.charCodeAt(0)>255?2:1),0)/(s.columnWidths[c]-2))),0)*15+12))))}));if(references)sheets.push(assessmentBasisSheet(references));return sheets;}
export async function mountHkKnowledge(app){
 const {doc}=app,root=doc.getElementById('hk-knowledge-content'),rules=app.rulesets.hk;if(!root)return;
 root.replaceChildren();const table=element(doc,'table'),head=element(doc,'thead'),tr=element(doc,'tr');for(const text of ['发行人类别','范围1及范围2排放','其他气候披露要求'])tr.append(element(doc,'th',text));head.append(tr);table.append(head);const body=element(doc,'tbody');
 for(const row of hkKnowledgeSheets(rules)[0].rows.slice(1,4)){const tr=element(doc,'tr');row.forEach((v,i)=>tr.append(element(doc,i?'td':'th',v)));body.append(tr);}table.append(body);const scroll=element(doc,'div',null,'table-scroll');scroll.tabIndex=0;scroll.setAttribute('aria-label','港交所分阶段披露安排');scroll.append(table);root.append(scroll);
 root.append(element(doc,'p','FY按财政年度开始日期判断。大型股须符合上一财政年度全年为HSCLI成分股的条件；一旦适用D部分强制披露，其后退出指数仍持续适用。第36段行业指标仍属鼓励披露。','context-note'));
 root.append(element(doc,'h2','披露要求与主体对照'),renderHkHierarchy(doc,rules));
 const sources=element(doc,'p',null,'sources');for(const [i,label] of ['主板附录C2','GEM附录C2'].entries()){const a=element(doc,'a',label);a.href=rules.guideline.sourceUrls?.[i]||'https://en-rules.hkex.com.hk/entiresection/'+(i?'1801':'3742');a.target='_blank';a.rel='noopener';sources.append(a,doc.createTextNode('　'));}root.append(sources);
 const contexts=[['largecap','2025-01-01'],['largecap','2026-01-01'],['mainboard','2025-01-01'],['gem','2025-01-01']];
 const button=doc.getElementById('export-hk-knowledge');button.disabled=false;button.addEventListener('click',app.guarded(async()=>{button.disabled=true;try{const references=await Promise.all(contexts.map(([issuerCategory,fiscalYearStart])=>app.api(`/api/assessment-reference?exchange=hk&issuerCategory=${issuerCategory}&fiscalYearStart=${fiscalYearStart}`)));downloadXlsx('港交所ESG守则与披露安排.xlsx',buildXlsx(hkKnowledgeSheets(rules,references)));app.message('已导出港交所披露安排、指标原文及四种类别/年度组合的AI评级依据。');}finally{button.disabled=false;}}));
}
