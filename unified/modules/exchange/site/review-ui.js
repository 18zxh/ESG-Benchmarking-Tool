import {OBLIGATIONS,hkObligation} from './hk.js';
import {STATUS_LABELS,MODES,saveComment,manualVerdict} from './workbench-core.js';
import {element} from './topic-align.js';

export function mountReview(app){
  const {doc,guarded}=app,$=id=>doc.getElementById(id);let selected=null,userChosen=false,lastVisible=null;const commentDrafts=new Map();
  function revealSelected(){
    const list=$('result-list'),active=list.querySelector('[aria-current="true"]');if(!active||!list.clientHeight)return;
    const bounds=list.getBoundingClientRect(),row=active.getBoundingClientRect();
    if(row.top<bounds.top)list.scrollTop-=bounds.top-row.top;
    else if(row.bottom>bounds.bottom)list.scrollTop+=row.bottom-bounds.bottom;
    lastVisible=app.project.id+':'+selected;
  }
  function paint(){
    const project=app.project,rules=app.rules,list=$('result-list'),scrollTop=list.scrollTop;list.replaceChildren();
    if(!rules){$('review-detail').replaceChildren(element(doc,'p','选择一个议题查看原文与复核记录。','empty-state'));return;}
    if(!selected||!project.topics.some(t=>t.topicId===selected)||(!userChosen&&project.topics.some(t=>t.assessment)))selected=project.topics.find(t=>t.assessment||t.status==='failed')?.topicId||project.topics[0]?.topicId;
    for(const topic of rules.topics){const state=project.topics.find(t=>t.topicId===topic.id),button=element(doc,'button',topic.name);button.type='button';button.dataset.topicId=topic.id;button.className=selected===topic.id?'active':'';
      if(selected===topic.id)button.setAttribute('aria-current','true');button.append(element(doc,'small',`${STATUS_LABELS[state.status]||state.status}${state.assessment?.manualReviewed?' · 已人工改判':''}${state.commentSavedAt?' · 有复核评论':''}`));
      button.addEventListener('click',()=>{selected=topic.id;userChosen=true;paint();});list.append(button);}
    detail();list.scrollTop=scrollTop;if(lastVisible!==project.id+':'+selected)revealSelected();
  }
  function textSection(parent,title,text){parent.append(element(doc,'h3',title),element(doc,'p',text||'—'));}
  function detail(){
    const project=app.project,state=project.topics.find(t=>t.topicId===selected),topic=app.rules.topics.find(t=>t.id===selected),region=$('review-detail');region.replaceChildren();if(!state||!topic)return;
    region.append(element(doc,'h2',topic.name),element(doc,'p',`${topic.clause} · ${STATUS_LABELS[state.status]}`,'muted'));
    if(project.exchange==='hk')region.append(element(doc,'p',OBLIGATIONS[hkObligation(topic,project)]+' · '+(topic.part==='D'?'按财政年度及类别适用，具体条款注释与宽免须逐项核定。':'按附录C2要求核对披露或具体解释。'),'context-note'));
    const requirement=element(doc,'details'),summary=element(doc,'summary','查看本所披露要求与原始条文');requirement.append(summary,element(doc,'p',topic.requirement),element(doc,'p',topic.sourceText||''));region.append(requirement);
    if(state.assessment){const a=state.assessment;textSection(region,'建议判断',a.judgment+(a.manualReviewed?' · 人工核对后改判':''));region.append(element(doc,'p',MODES[a.readingMode]||'','muted'));
      textSection(region,'已有披露',a.disclosedContent);textSection(region,'披露不足',a.gap);textSection(region,'改进建议',a.suggestion);textSection(region,'报告章节来源',a.reportSectionSource);region.append(element(doc,'h3','报告出处与原文证据'));
      if(!(a.evidence||[]).length)region.append(element(doc,'p',a.judgment==='未披露'?'此判断无披露引用。':'尚无可核验的原文证据。','muted'));
      for(const e of a.evidence||[]){const block=element(doc,'div',null,'evidence-item'),button=element(doc,'button',`${e.source==='annual'?'公司年报':'主报告'} · ${e.name} · PDF 第 ${e.page} 页`);button.type='button';button.addEventListener('click',guarded(()=>app.preview(e.source,e.page)));block.append(button,element(doc,'blockquote',e.quote));
        if(e.verification==='model_pdf')block.append(element(doc,'small','模型从 PDF 提取；请打开原页逐项核验。','muted'));region.append(block);}
    }else region.append(element(doc,'p',state.error?.message||'此议题尚无初评结果。','muted'));
    if(state.status==='failed'){const retry=element(doc,'button','单独重试此议题');retry.type='button';retry.disabled=app.busy;retry.addEventListener('click',guarded(()=>app.retry(state.topicId)));region.append(retry);}
    if(state.status==='need_verify')renderVerdict(region,state);
    const label=element(doc,'label','独立复核评论','field'),textarea=element(doc,'textarea'),key=project.id+':'+state.topicId;textarea.id='review-comment';textarea.maxLength=100000;textarea.value=commentDrafts.has(key)?commentDrafts.get(key):state.comment||'';
    textarea.placeholder='记录人工核对、补充材料与后续建议';textarea.addEventListener('input',()=>commentDrafts.set(key,textarea.value));label.append(textarea);region.append(label);
    const help=element(doc,'p','保存评论只记录人工意见。需要刷新后继续时，请再点击页面顶部“保存草稿”。','muted');region.append(help);const actions=element(doc,'div',null,'actions'),save=element(doc,'button','保存评论');save.type='button';save.addEventListener('click',guarded(()=>{saveComment(project,state.topicId,textarea.value);commentDrafts.delete(key);app.refresh();app.message('评论已记录，项目状态为已复核；请保存草稿以保留到下次。');}));actions.append(save);region.append(actions);
    if(state.history?.length){const history=element(doc,'details',null,'history');history.append(element(doc,'summary',`历史初评与改判记录（${state.history.length}）`));
      for(const item of [...state.history].reverse()){const block=element(doc,'div');block.append(element(doc,'h3',`${item.reason||'历史结果'} · ${item.at.slice(0,19).replace('T',' ')}`));textSection(block,'当时判断',item.assessment?.judgment);textSection(block,'当时披露与不足',[item.assessment?.disclosedContent,item.assessment?.gap].filter(Boolean).join('\n'));textSection(block,'当时出处',item.assessment?.reportSource);history.append(block);}region.append(history);}
  }
  function renderVerdict(region,state){
    const form=element(doc,'form',null,'verdict-form');form.append(element(doc,'h3','完成全文核对后改判'),element(doc,'p','可保留待全文核验状态。改判为已披露时必须填写报告出处和原文。','muted'));
    const field=(title,node)=>{const label=element(doc,'label',title,'field');label.append(node);form.append(label);return node;};
    const judgment=field('人工核对结果',element(doc,'select'));judgment.id='manual-judgment';for(const text of ['已披露','未披露']){const option=element(doc,'option',text);option.value=text;judgment.append(option);}
    const reference=element(doc,'div'),source=element(doc,'select');source.id='manual-source';for(const name of ['main','annual'])if(app.project.reports[name]){const option=element(doc,'option',name==='main'?'主报告':'公司年报');option.value=name;source.append(option);}
    const sourceLabel=element(doc,'label','报告来源','field');sourceLabel.append(source);reference.append(sourceLabel);const page=element(doc,'input');page.id='manual-page';page.type='number';page.min='1';page.value='1';const pageLabel=element(doc,'label','PDF 物理页','field');pageLabel.append(page);reference.append(pageLabel);
    const quote=element(doc,'textarea');quote.id='manual-quote';quote.maxLength=3500;const quoteLabel=element(doc,'label','原文摘录','field');quoteLabel.append(quote);reference.append(quoteLabel);form.append(reference);
    judgment.addEventListener('change',()=>{reference.hidden=judgment.value==='未披露';});const submit=element(doc,'button','保存人工改判');submit.type='submit';submit.disabled=app.busy;form.append(submit);
    form.addEventListener('submit',event=>{event.preventDefault();guarded(()=>{manualVerdict(app.project,state.topicId,judgment.value,{source:source.value,page:page.value,quote:quote.value});app.refresh();app.message('已保存人工改判，原始初评保留在历史记录中；请保存草稿。');})()});region.append(form);
  }
  const oldRefresh=app.onRefresh,oldRestore=app.onRestore;app.onRefresh=()=>{oldRefresh?.();paint();};app.onRestore=()=>{oldRestore?.();selected=null;userChosen=false;lastVisible=null;commentDrafts.clear();paint();};app.onReviewVisible=()=>{lastVisible=null;paint();};(app.hostWindow||doc.defaultView)?.addEventListener('resize',revealSelected);paint();return {paint};
}
