import {ALL_CRITERIA,buildEvaluationInput,appendAiRuns} from './workbench-core.js';
import {ensureRecord,normalizeRuns,taskContext} from './workbench-batch.js';
import {aiRequirementsForIssues} from './workbench-requirements.js';
export const usesNativePdf=(provider)=>['glm-5.3-flash','glm-5.3-flashx'].includes(String(provider?.model||'').toLowerCase());

export class PdfAssessmentQueue {
  constructor({workspace,providers,onChange}){this.workspace=workspace;this.providers=providers;this.onChange=onChange;this.running=false;this.paused=false;this.stopped=false;this.native=true;}
  async api(path,body){
    const response=await fetch(path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const data=await response.json();if(!response.ok)throw Object.assign(Error(data.error||'PDF全文任务请求失败。'),{status:response.status});return data;
  }
  async register(buffer,name){
    if(!buffer)throw Error('请重新上传原PDF后继续全文评估。');
    const response=await fetch('/api/native-documents',{method:'POST',headers:{'Content-Type':'application/pdf','X-File-Name':encodeURIComponent(name)},body:buffer});
    const data=await response.json();if(!response.ok)throw Error(data.error||'PDF载入失败。');return data.meta.nativeDocumentId;
  }
  control(action){if(this.workspace.nativeJobId)this.api('/api/pdf-review/'+this.workspace.nativeJobId,{action}).catch(()=>{});}
  pause(){this.paused=true;this.control('pause');this.onChange();}
  stop(){this.stopped=true;this.control('stop');this.onChange();}
  sync(data){
    const stamp=JSON.stringify([data.phase,data.processedPages,data.results?.length,data.errors?.length]);
    if(stamp===this.previousSnapshot)return;this.previousSnapshot=stamp;
    const workspace=this.workspace,batch=workspace.batch;
    workspace.fullReview={phase:data.phase,readingComplete:data.readingComplete,processedPages:data.processedPages,totalPages:data.totalPages,cachedPages:data.cachedPages||0,cachedCriteria:data.cachedCriteria||0,contextBudget:data.contextBudget,usage:data.usage,calls:data.calls,evidence:data.evidence,model:this.providers[0].model};
    for(const result of data.results||[]){
      if(this.received.has(result.criterionId))continue;
      this.received.add(result.criterionId);
      const c=ALL_CRITERIA.find(c=>c.id===result.criterionId);if(!c)continue;
      const record=ensureRecord(workspace,c),evaluation=buildEvaluationInput(c,result.evidence,workspace.project);
      if(record.aiRuns?.some(run=>run.nativeJobId===data.jobId&&run.createdAt===result.completedAt))continue;
      const runs=normalizeRuns({results:[result],completedAt:result.completedAt},this.providers,result.evidence,evaluation);
      for(const run of runs)run.nativeJobId=data.jobId;
      appendAiRuns(record,runs);record.taskStatus=runs.every(r=>r.draft.valid)?'completed':'failed';batch.states[c.id]={status:record.taskStatus,error:runs.filter(r=>!r.draft.valid).map(r=>r.draft.error).join(' ')};
    }
    for(const failure of data.errors||[]){const state=batch.states[failure.criterionId];if(state){state.status='failed';state.error=failure.error;ensureRecord(workspace,ALL_CRITERIA.find(c=>c.id===failure.criterionId)).taskStatus='failed';}}
    if(data.phase==='failed')for(const state of Object.values(batch.states))if(['pending','running'].includes(state.status)){state.status='failed';state.error=data.error||'全文读取失败。';}
    batch.phase=data.phase==='completed'?'finished':data.phase;
    this.onChange();
  }
  async run({retryIds=[]}={}){
    const w=this.workspace;if(this.running)return;
    this.received=new Set();this.running=true;this.paused=false;this.stopped=false;
    try{
      let resumed=false;
      if(w.nativeJobId&&w.nativeJobContext===taskContext(w)&&w.batch.phase==='paused'&&!retryIds.length){
        try{await this.api('/api/pdf-review/'+w.nativeJobId,{action:'resume'});resumed=true;}
        catch(error){if(error.status!==404)throw error;}
      }
      if(!resumed){
        const documents=[{id:await this.register(w.originalPdf,w.documentName),source:'main'}];
        if(w.annual?.name)documents.push({id:await this.register(w.annual.originalPdf,w.annual.name),source:'annual'});
        const criteria=aiRequirementsForIssues(w.selectedIssueIds);
        for(const id of retryIds)if(w.batch.states[id])w.batch.states[id]={status:'pending',error:''};
        const pendingIds=retryIds.length?retryIds:criteria.filter(c=>['pending','running'].includes(w.batch.states[c.id]?.status)).map(c=>c.id);
        const data=await this.api('/api/pdf-review',{providerIds:this.providers.map(p=>p.id),documents,criteria,project:w.project,retryIds:pendingIds});w.nativeJobId=data.jobId;w.nativeJobContext=taskContext(w);
      }
      w.batch.phase='running';this.onChange();
      while(true){
        const data=await this.api('/api/pdf-review/'+w.nativeJobId);this.sync(data);
        if(['completed','failed','stopped','paused'].includes(data.phase))break;
        await new Promise(resolve=>setTimeout(resolve,1000));
      }
    }finally{this.running=false;this.onChange();}
  }
}
