import {HK_CATEGORIES,OBLIGATIONS,hkObligation} from './hk.js';
import {buildXlsx,downloadXlsx} from './xlsx.js';
import {DIMENSIONS,EXCHANGES,STATUS_LABELS,MODES,sectionSource,validateProject} from './workbench-core.js';
import {assessmentBasisSheet} from './assessment-export.js';

export const ES_COLUMNS=['序号','维度','议题','对应条款','披露要求','处理状态','建议判断','披露现状','披露不足','改进建议','报告出处','报告章节来源','评论'];
export const GOVERNANCE_COLUMNS=ES_COLUMNS.filter(x=>x!=='维度');
const MAX_CELL=32767;
export function splitCell(value){
  if(typeof value!=='string'||value.length<=MAX_CELL)return [value];const parts=[];let current='';
  for(const char of value){if(current.length+char.length>MAX_CELL){parts.push(current);current='';}current+=char;}parts.push(current);return parts;
}
export function continuationRows(rows,identityColumns=[0]){
  const out=[];for(const row of rows){const parts=row.map(splitCell),count=Math.max(...parts.map(p=>p.length));
    for(let n=0;n<count;n++){const next=parts.map((p,c)=>p[n]??(n&&identityColumns.includes(c)?p[0]:''));if(n)next[0]=`${row[0]}（续行 ${n+1}/${count}）`;out.push(next);}}
  return out;
}
export function workbookSheets(project,rules,reference){
  validateProject(project,rules);const states=new Map(project.topics.map(t=>[t.topicId,t]));
  const usedModes=[...new Set(project.topics.map(t=>t.assessment?.readingMode).filter(Boolean))];if(!usedModes.length&&project.readingMode)usedModes.push(project.readingMode);
  const overview=[['项目','内容'],['客户名称',project.customerName],['报告覆盖年度',project.reportYear],['目标披露年度',project.targetYear],['报告名称',project.reports.main?.name||''],['公司年报',project.reports.annual?.name||'未上传'],['交易所',EXCHANGES[project.exchange]],['板块',project.board||'不细分'],['所属行业',project.industry||''],['指引编号',rules.guideline.number],['指引名称',rules.guideline.name],['规则集版本',project.rulesetVersion],[project.exchange==='hk'?'气候新规适用起始日':'指引施行日期',project.exchange==='hk'?rules.guideline.climateEffectiveDate:rules.guideline.effectiveDate],['对齐完成时间',project.alignedAt||''],['映射最近修正时间',project.mappingChangedAt||'无人工修正'],['所用读取模式',usedModes.map(m=>MODES[m]||m).join('；')||'尚未评估'],['对齐版本',project.alignmentVersion||'历史项目未记录'],['读取版本',project.readingVersion||'尚未读取或历史项目未记录'],['评估版本',project.assessmentVersion||[...new Set(project.topics.map(t=>t.assessment?.assessmentVersion).filter(Boolean))].join('；')||'尚未评估或历史项目未记录'],['主报告指纹',project.reports.main?.sha256||''],['公司年报指纹',project.reports.annual?.sha256||''],['本次模型服务',project.modelService?.name||''],['本次模型',project.modelService?.model||''],['对齐用量（仅已报告）',`${project.alignmentUsage?.totalTokens||0} tokens；${project.alignmentUsage?.responses||0}次响应`],['初评用量（仅已报告）',`${project.reviewUsage?.totalTokens||0} tokens；${project.reviewUsage?.unreportedResponses||0}次响应未报告用量`],['状态说明','通用兼容模式仅覆盖检索命中片段；待全文核验不等于未披露。未处理及失败项仍列出。'],['评估范围说明','议题选择只表示本次检查范围，不作官方适用性或评级判定。']];
  if(project.exchange==='hk')overview.push(['发行人类别',HK_CATEGORIES[project.issuerCategory]],['财政年度开始日期',project.fiscalYearStart],['规则适用说明','范围1/2强制；其余Part D按类别/财政年度及具体注释适用，第36段仍为鼓励。合理解释及宽免需结合原文核定。'],['规则来源（主板）','https://en-rules.hkex.com.hk/entiresection/3742'],['规则来源（GEM）','https://en-rules.hkex.com.hk/entiresection/1801']);
  const framework=[['序号','维度','议题','对应条款','披露要求概述']];const es=[[...ES_COLUMNS]],governance=[[...GOVERNANCE_COLUMNS]],evidence=[['议题','对应条款','报告出处','PDF 页数','原文摘录']];
  for(const [index,topic] of rules.topics.entries()){
    const state=states.get(topic.id)||{status:'pending'},a=state.assessment||{};
    framework.push([index+1,DIMENSIONS[topic.dimension],topic.name,topic.clause,topic.requirement]);
    const status=(STATUS_LABELS[state.status]||state.status)+(a.manualReviewed?'（人工改判）':'');
    const common=[topic.name,topic.clause,topic.requirement,status,a.judgment||'',a.disclosedContent||'',a.gap||state.error?.message||'',a.suggestion||'',a.reportSource||'',sectionSource(project,topic.id),state.comment||''];
    if(topic.dimension==='governance')governance.push([index+1,...common]);else es.push([index+1,DIMENSIONS[topic.dimension],...common]);
    for(const ref of a.evidence||[])evidence.push([topic.name,topic.clause,`${ref.source==='annual'?'公司年报':'主报告'} · ${ref.name} · PDF 第 ${ref.page} 页`,ref.page,ref.quote]);
  }
  if(project.exchange==='hk'){
    framework[0].push('披露属性');es[0]=[...es[0],'披露属性'];governance[0]=[...governance[0],'披露属性'];
    rules.topics.forEach((topic,i)=>framework[i+1].push(OBLIGATIONS[hkObligation(topic,project)]));
    for(const sheet of [es,governance])for(const row of sheet.slice(1)){const topic=rules.topics.find(t=>t.name===row[sheet===es?2:1]);row.push(OBLIGATIONS[hkObligation(topic,project)]);}
  }
  const items=[['项目概况',overview,[0],[25,90]],['框架结构',framework,[0,1,2,3],[8,12,30,42,90]],['评分指标',es,[0,1,2,3],[8,12,30,40,70,20,18,65,65,65,40,36,65]],['治理关键指标',governance,[0,1,2],[8,30,40,70,20,18,65,65,65,40,36,65]],['原文证据',evidence,[0,1,2,3],[30,40,48,12,100]]];
  const sheets=items.map(([name,rows,identityColumns,columnWidths])=>({name,rows:continuationRows(rows,identityColumns),columnWidths:project.exchange==='hk'&&['框架结构','评分指标','治理关键指标'].includes(name)?[...columnWidths,22]:columnWidths,wrap:true,freezeRows:1,autoFilter:name!=='项目概况'}));
  if(reference)sheets.push(assessmentBasisSheet(reference));return sheets;
}
export function exportWorkbook(project,rules,reference){return buildXlsx(workbookSheets(project,rules,reference));}
export function mountExport(app,{download=downloadXlsx}={}){
  const button=app.doc.getElementById('export-project');button.addEventListener('click',app.guarded(async()=>{if(app.busy)throw new Error('请等待任务结束或停止后，再导出当前结果。');
    const p=app.project,query=new URLSearchParams({exchange:p.exchange});if(p.exchange==='hk'){query.set('issuerCategory',p.issuerCategory);query.set('fiscalYearStart',p.fiscalYearStart);}
    const reference=await app.api(`/api/assessment-reference?${query.toString()}`),bytes=exportWorkbook(p,app.rules,reference),safe=p.customerName.replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').slice(0,80);download(`${safe}-${p.reportYear}-${p.targetYear}-可持续发展评估.xlsx`,bytes);p.status='已导出';app.refresh();app.message('已生成含AI评级依据的六表 Excel。静态评估方法和指标内容取自实际请求共用的数据；项目证据仅在模型请求中按需提供。请保存草稿。');}));
}
