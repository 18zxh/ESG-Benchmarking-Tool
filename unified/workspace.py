"""Explicit five-module workflow facade over the shared, validated engines."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import base64
import json
import re
import threading
import time
import uuid
from .core import LocalError, fingerprint, running
from .methods import Methods, METHOD, MODULES, ROOT, criteria, read

BUCKET = 'workspace-projects'
RUNS = 'workspace-runs'
INPUT_FIELDS = ('module','company','reportPeriod','targetPeriod','options','documents','selected','methodId','mappingOverrides')
def input_hash(project): return fingerprint({k:project.get(k) for k in INPUT_FIELDS})
def now(): return time.time()

class Workspace:
    def __init__(self, app):
        self.app, self.store = app, app.store
        self.methods = Methods(app)
        self.lock = threading.RLock()
        self.pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix='workspace')
        self.live = {}
        from .project_center import ProjectCenter
        self.center = ProjectCenter(self)

    def close(self):
        with self.lock:
            for run in self.live.values(): run['_stop']=True; run['_pause']=False
        self.pool.shutdown(wait=False, cancel_futures=True)

    def list_projects(self):
        return [{**p['value'],'revision':p['revision']} for p in self.store.list_projects('exchange',BUCKET)]

    def project(self, key):
        value = self.store.project('exchange',BUCKET,key)
        if value is None: raise LocalError('项目不存在。',404)
        rows=self.store.list_projects('exchange',BUCKET)
        revision=next(p['revision'] for p in rows if p['key']==key)
        drift=any(ref.get('meta')!=self.store.document('exchange','library',ref['id'])['meta'] for ref in value.get('documents',[]))
        return {**value,'revision':revision,'stale':bool(value.get('stale') or drift)}

    def save(self, data, key=None):
        if not isinstance(data, dict): raise LocalError('项目数据须为对象。')
        if data.get('module') not in MODULES: raise LocalError('请选择评估模块。')
        if not isinstance(data.get('name'), str) or not data['name'].strip() or len(data['name'].strip()) > 160:
            raise LocalError('项目名称须为1至160个字符。')
        for field, maximum in (('company',160),('reportPeriod',80),('targetPeriod',80)):
            if not isinstance(data.get(field,''),str) or len(data.get(field,'')) > maximum: raise LocalError('企业或期间字段格式无效。')
        with self.lock:
            old=self.project(key) if key else None
            if old and data['module']!=old['module']: raise LocalError('已有项目的模块不能改变，请新建项目。')
            if old and any(r.get('projectId')==key and r['status'] in {'running','queued','paused'} for r in self.live.values()) and input_hash(data)!=input_hash(old):
                raise LocalError('任务运行时不能改变评估输入，请先停止任务。',409)
            value=deepcopy(data); value['name']=data['name'].strip(); value['id']=key or uuid.uuid4().hex
            value.setdefault('company','');value.setdefault('reportPeriod','');value.setdefault('targetPeriod','')
            value.setdefault('options',{});value.setdefault('documents',[]);value.setdefault('selected',[]);value.setdefault('comments',{})
            if not isinstance(value['documents'],list) or not isinstance(value['selected'],list) or not isinstance(value['comments'],dict): raise LocalError('项目字段结构无效。')
            for document in value['documents']:
                original=self.store.document('exchange','library',document['id'])
                document.update(sha256=original['sha256'],meta=original['meta'])
            method=value.get('methodId')
            if method:
                bundle=self.methods.get(method)
                if bundle['module']!=value['module'] or bundle['status']!='published': raise LocalError('项目必须绑定本模块已发布的方法版本。')
                if any(i not in {r['id'] for r in criteria(bundle)} for i in value['selected']): raise LocalError('选题不属于当前方法版本。')
            value.pop('revision',None);value['updatedAt']=now();value.setdefault('createdAt',now())
            # Job links belong to server state. A stale browser cannot erase one.
            if old:
                for field in ('lastRunId','runIds','nativeBucket','nativeKey','lastSavedAt','hasNativeDraft','autoName'):
                    if field in old:value[field]=old[field]
            value['stale']=bool(value.get('lastRunId') and self.run(value['lastRunId'])['inputHash']!=input_hash(value))
            result=self.store.save_project('exchange',BUCKET,value['id'],value,value['id'],data.get('revision') if old else 0)
            return {**value,'revision':result['revision']}

    def documents(self):
        with self.store.connect() as db:
            rows=db.execute('SELECT d.id,d.sha,d.name,d.meta,b.pages,b.size FROM documents d JOIN blobs b ON b.sha=d.sha WHERE namespace=? AND scope=? ORDER BY d.rowid DESC',('exchange','library')).fetchall()
        return [{'id':r[0],'sha256':r[1],'name':r[2],'meta':json.loads(r[3]),'pageCount':r[4],'bytes':r[5]} for r in rows]

    def metadata(self, key, meta):
        allowed={'documentType','period','company','sourceUrl','public'}
        if not isinstance(meta,dict):raise LocalError('资料元数据无效。')
        doc=self.store.document('exchange','library',key)
        return self.store.put_document('exchange','library',doc['bytes'],doc['name'],ref_id=key,
                                       meta={k:v for k,v in meta.items() if k in allowed})

    def save_run(self, run):
        value={k:v for k,v in run.items() if not k.startswith('_')}
        value['updatedAt']=now();run['updatedAt']=value['updatedAt']
        self.store.save_project('exchange',RUNS,run['id'],value,run['projectId'])

    def run(self, key):
        with self.lock:
            if key in self.live:return deepcopy({k:v for k,v in self.live[key].items() if not k.startswith('_')})
        value=self.store.project('exchange',RUNS,key)
        if not value:raise LocalError('评估记录不存在。',404)
        if value.get('owner')!=self.store.session and value['status'] in {'queued','running','paused'}:
            value.update(status='interrupted',phase='服务已重启，请重新连接后继续初评。')
        return value

    def validate_project(self, p, bundle):
        if not p['company'].strip() and p['module']!='benchmark':raise LocalError('请填写企业名称。')
        if not p['reportPeriod'].strip():raise LocalError('请填写报告实际覆盖期间。')
        if not p.get('documents'):raise LocalError('请选择至少一份PDF。')
        if not p.get('selected'):raise LocalError('请选择检查范围。')
        if bundle['catalogKey']!=self.methods.key(p['module'],p['options']):raise LocalError('适用条件已经改变，请重新加载方法并确认选题。',409)
        m=p['module']; options=p['options']
        if m=='csa':
            if not options.get('industryBasis','').strip():raise LocalError('请填写CSA官方行业确认依据。')
            if len(p['documents'])>6:raise LocalError('CSA主报告和佐证合计最多6份。')
            if len(p['selected'])>160:raise LocalError('每次CSA最多选择160题。')
        elif m=='msci':
            if options.get('acknowledged') is not True:raise LocalError('请核对MSCI方法适用性。')
            if len(p['documents'])>2:raise LocalError('MSCI当前支持主报告和补充报告各一份。')
        elif m in {'mainland','hkex'}:
            if not re.fullmatch(r'\d{4}',p['reportPeriod']) or not re.fullmatch(r'\d{4}',p['targetPeriod']):raise LocalError('交易所项目请填写四位报告覆盖年度和目标披露年度。')
            boards=bundle['payload']['rules'].get('boardOptions',[])
            if m=='mainland' and boards and options.get('board') not in boards:raise LocalError('请选择当前交易所的板块。')
            if len(p['documents'])>2:raise LocalError('交易所当前支持主报告与年报各一份。')
        else:
            companies=[d.get('company','').strip() for d in p['documents']]
            if any(not c for c in companies) or len(set(companies))!=len(companies):raise LocalError('每份对标报告须填写不同公司名称。')
            if any(not re.fullmatch(r'\d{4}',str(d.get('period',''))) for d in p['documents']):raise LocalError('每份对标报告须填写四位覆盖年度。')
            if sum(bool(d.get('isOwn')) for d in p['documents'])>1:raise LocalError('只能指定一家本公司。')

    def start(self, project_id, retry=False):
        p=self.project(project_id)
        if not p.get('methodId'):raise LocalError('请先选择并绑定方法版本。')
        bundle=self.methods.get(p['methodId']);self.validate_project(p,bundle)
        self.app.gateway.get()
        with self.lock:
            if any(r['projectId']==project_id and r['status'] in {'queued','running','paused'} for r in self.live.values()):raise LocalError('本项目已有任务正在运行。',409)
            previous=self.run(p['lastRunId']) if retry and p.get('lastRunId') and not p.get('stale') else None
            if retry and not previous:raise LocalError('输入已改变，需创建新的完整初评。',409)
            success=[r for r in (previous or {}).get('results',[]) if r['status']!='failed']
            run={'id':uuid.uuid4().hex,'owner':self.store.session,'projectId':project_id,'module':p['module'],
                 'methodId':bundle['id'],'methodHash':bundle['hash'],'inputHash':input_hash(p),'status':'queued',
                 'phase':'等待开始','processedPages':0,'totalPages':0,'results':deepcopy(success),'errors':[],
                 'createdAt':now(),'projectSnapshot':deepcopy(p),'_stop':False,'_pause':False,'_project':deepcopy(p),'_method':bundle}
            p['lastRunId']=run['id'];p['runIds']=[*p.get('runIds',[]),run['id']];p['stale']=False
            self.store.save_project('exchange',BUCKET,project_id,{k:v for k,v in p.items() if k!='revision'},project_id,p['revision'])
            self.live[run['id']]=run;self.save_run(run)
            self.pool.submit(self._work,run)
            return self.run(run['id'])

    def control(self,key,action):
        if action not in {'pause','resume','stop'}:raise LocalError('任务操作无效。')
        with self.lock:
            run=self.live.get(key)
            if not run or run['status'] not in {'queued','running','paused'}:raise LocalError('任务已结束；可从成功缓存继续初评。',409)
            if action=='stop':run['_stop']=True;run['_pause']=False
            else:run['_pause']=action=='pause';run['status']='paused' if run['_pause'] else 'running'
            if run.get('_control'):run['_control'](action)
            self.save_run(run)
        return self.run(key)

    def checkpoint(self,run):
        while run['_pause'] and not run['_stop']:time.sleep(.1)
        if run['_stop']:raise LocalError('已停止后续调用；已完成结果与评论保留。')

    def update(self,run,**fields):
        with self.lock:run.update(fields);self.save_run(run)

    def merge(self,run,rows):
        found={r['id']:r for r in run['results']};found.update({r['id']:r for r in rows})
        run['results']=list(found.values())

    def _work(self,run):
        token=METHOD.set(run['_method'])
        try:
            with running('csa' if run['module']=='csa' else 'msci' if run['module']=='msci' else 'exchange',run['projectId'],run['id']):
                self.checkpoint(run);self.update(run,status='running',phase='准备原PDF')
                if run['module']=='csa':self._csa(run)
                elif run['module']=='msci':self._msci(run)
                else:self._exchange(run)
                self.checkpoint(run)
                failed=bool(run['errors']) or any(r['status']=='failed' for r in run['results'])
                self.update(run,status='failed' if failed else 'completed',phase='部分项目未完成，可重试' if failed else '初评完成')
        except Exception as exc:
            self.update(run,status='stopped' if run['_stop'] else 'failed',phase='已停止' if run['_stop'] else '处理未完成',
                        errors=[*run['errors'],self.store.secrets.clean(str(exc))[:1500]])
        finally:
            METHOD.reset(token)

    def _documents(self,run):
        return [(ref,self.store.document('exchange','library',ref['id'])) for ref in run['_project']['documents']]

    def _csa(self,run):
        p=run['_project'];options=p['options'];native=self.app.modules.get('csa','native_pdf')
        documents=[]
        for ref,doc in self._documents(run):
            meta=doc['meta']
            documents.append({'id':ref['id'],'name':doc['name'],'sha256':doc['sha256'],'pageCount':doc['pageCount'],
                'public':meta.get('public',False),'sourceUrl':meta.get('sourceUrl',''),'documentType':meta.get('documentType','unspecified'),
                'documentPeriod':meta.get('period',''),'fileData':'data:application/pdf;base64,'+base64.b64encode(doc['bytes']).decode()})
        successful={r['id'] for r in run['results']};selected=[i for i in p['selected'] if i not in successful]
        if not selected:return
        value={'_runId':run['id'],'project':{'name':p['company'],'industry':options['industry'],'industryBasis':options['industryBasis'],
                'methodYear':2026,'version':'Full','listed':options.get('listed','unknown'),'reportPeriod':p['reportPeriod'],'targetPeriod':p['targetPeriod']},
               'questionIds':selected,'documents':documents}
        def progress(state):
            fields={k:state[k] for k in ('phase','detail','completed','total','usage') if k in state}
            if isinstance(state.get('pipeline'),dict):fields.update(processedPages=state['pipeline'].get('pagesRead',0),totalPages=state['pipeline'].get('pageCount',0))
            self.update(run,**fields)
        result=native.evaluate(value,self.app.gateway.get(),progress=progress,before_request=lambda:self.checkpoint(run))
        titles={c['id']:c['title'] for c in criteria(run['_method'])}
        rows=[{'id':r['questionId'],'title':titles[r['questionId']],'status':r['draftStatus'],'disclosure':r['remark'],
               'gap':'\n'.join(r.get('issues',[])+r.get('warnings',[])),'suggestion':'','evidence':[
                   {'documentId':e['reportId'],'page':e['page'],'quote':e['text']} for e in r['evidence']], 'raw':r} for r in result['results']]
        self.merge(run,rows);self.update(run,processedPages=result['pipeline']['pagesRead'],totalPages=result['pipeline']['pageCount'],usage=result['usage'])

    def _wait_native(self,run,status,control):
        run['_control']=control
        try:
            while True:
                if run['_stop']:control('stop')
                value=status()
                state=value.get('status') if 'status' in value else value.get('phase')
                self.update(run,phase=str(value.get('phase','')),processedPages=value.get('processedPages',0),totalPages=value.get('totalPages',0),
                            nativeProgress=value.get('progress'),usage=value.get('usage',{}))
                self._collect(run,value)
                if state in {'completed','failed','stopped','interrupted'}:break
                time.sleep(.2)
            if value.get('error'):run['errors'].append(value['error'])
            run['errors'].extend(value.get('errors',[]))
            if state!='completed' and not run['errors']:run['errors'].append('原生任务未完成：'+str(state))
            return value
        finally:run.pop('_control',None)

    def _msci(self,run):
        native=self.app.modules.get('msci','pdf_assessment');p=run['_project'];documents=[];run['_nativeDocs']={};run['_sourceDocs']={}
        for index,(ref,doc) in enumerate(self._documents(run)):
            meta=native.prepare_pdf(doc['bytes'],doc['name'])['meta'];key=meta['nativeDocumentId']
            documents.append({'id':key,'source':'main' if index==0 else 'annual'});run['_nativeDocs'][key]=ref['id']
            run['_sourceDocs']['main' if index==0 else 'annual']=ref['id']
        successful={r['id'] for r in run['results']}
        chosen=[c for c in run['_method']['payload']['criteria'] if c['id'] in p['selected'] and c['id'] not in successful]
        if not chosen:return
        key=native.start_job({'providerIds':[self.app.gateway.get()['id']],'documents':documents,'criteria':chosen,
               'project':{'client_name':p['company'],'report_period':p['reportPeriod'],'target_period':p['targetPeriod'],
                          'assessment_scope':p['options'].get('assessmentScope','')+' 方法版本:'+run['methodHash']}})
        self._wait_native(run,lambda:native.job_status(key),lambda action:native.control_job(key,action))

    def _exchange(self,run):
        p=run['_project'];module=run['module'];server=self.app.modules.servers['exchange'];docs=server.DOCUMENTS
        provider=self.app.gateway.get();options=p['options'];rules=self.app.modules.get('exchange','rules').load_rules('hk' if module=='hkex' else options.get('exchange','sh') if module=='mainland' else 'sh',options)
        refs=self._documents(run);registered=[];run['_nativeDocs']={}
        for index,(ref,doc) in enumerate(refs):
            self.checkpoint(run)
            meta=docs.register(doc['bytes'],doc['name'],'main' if index==0 or module=='benchmark' else 'annual')
            docs.parse(meta['id'],asynchronous=False);registered.append(meta['id']);run['_nativeDocs'][meta['id']]=ref['id']
        targets=range(len(refs)) if module=='benchmark' else range(1)
        for index in targets:
            self.checkpoint(run)
            ref,_=refs[index];run['_company']=ref.get('company','') if module=='benchmark' else p['company'];run['_docPrefix']=ref['id'] if module=='benchmark' else ''
            if module=='benchmark' and len([r for r in run['results'] if r.get('companyDocumentId')==ref['id'] and r['status']!='failed'])==231:continue
            data={**options,'board':'GEM' if options.get('issuerCategory')=='gem' else '主板' if module=='hkex' else options.get('board',''),
                  'documentId':registered[index],'providerId':provider['id'],'exchange':rules['exchange'],'rulesetVersion':rules['version'],
                  'customerName':p['company'],'reportYear':p['reportPeriod'],'targetYear':p['targetPeriod']}
            self.update(run,phase='章节对齐')
            created=server.ALIGNMENTS.create(data);task=server.ALIGNMENTS.jobs.get(created['id'])
            run['_aligning']=True
            aligned=self._wait_native(run,task.snapshot,task.control);run['_aligning']=False
            if aligned['status']!='completed':raise LocalError('章节对齐未完成，初评未启动。')
            mappings=aligned.get('mappings',[])
            override=p.get('mappingOverrides',{}).get(ref['id'])
            if override is not None:
                mappings=self.app.modules.get('exchange','topic_align').validate_mappings({'mappings':override},aligned.get('candidates',[]),rules)
            alignment=deepcopy(run.get('alignments',{}));alignment[ref['id']]={'candidates':aligned.get('candidates',[]),'mappings':mappings}
            self.update(run,alignments=alignment)
            if module=='benchmark':
                framework=self.app.modules.get('exchange','benchmark').load_framework()
                created=server.BENCHMARKS.create({**data,'companyName':ref['company'],'reportYear':ref['period'],'frameworkVersion':framework['version'],
                                             'alignmentComplete':True,'mappings':mappings})
                task=server.BENCHMARKS.jobs.get(created['id'])
            else:
                success={r['id'] for r in run['results'] if r['status']!='failed'}
                chosen=[i for i in p['selected'] if i not in success]
                if not chosen:return
                created=server.REVIEWS.create({**data,'annualDocumentId':registered[1] if len(registered)>1 else None,
                                           'alignmentComplete':True,'mappings':mappings,'topicIds':chosen})
                task=server.REVIEWS.jobs.get(created['id'])
            self._wait_native(run,task.snapshot,task.control)
            if run['errors']:break

    def _collect(self,run,value):
        if run.get('_aligning'):return
        titles={c['id']:c['title'] for c in criteria(run['_method'])};rows=[]
        if run['module']=='msci':
            for row in value.get('results',[]):
                content=json.loads(row['content'])
                rows.append({'id':row['criterionId'],'title':titles.get(row['criterionId'],row['criterionId']),
                             'status':content.get('disclosure_status','needs_review'),'disclosure':content.get('current_disclosure',''),
                             'gap':content.get('gaps',''),'suggestion':content.get('recommendation',''),'evidence':row.get('evidence',[]),'raw':row})
        else:
            for key,row in value.get('results',{}).items():
                assessment=row.get('assessment',row)
                topic=row.get('topicId',key)
                title=titles.get(topic,topic)
                if run['module']=='benchmark':
                    checks=self.app.modules.get('exchange','benchmark').checks_for(run['_method']['payload']['framework'])
                    check=next((c for c in checks if c['id']==row.get('checkId')), {})
                    title+=' / '+check.get('name',str(row.get('checkId','')))
                rows.append({'id':(run.get('_docPrefix','')+'::' if run.get('_docPrefix') else '')+key,'title':title,
                             'companyDocumentId':run.get('_docPrefix',''),'company':run.get('_company',''),
                             'status':row.get('value') if row.get('status')=='completed' and row.get('value') else row.get('status','failed'),
                             'disclosure':assessment.get('disclosedContent',assessment.get('reason','')),'gap':assessment.get('gap',''),
                             'suggestion':assessment.get('suggestion',''),'evidence':assessment.get('evidence',[]),'raw':row})
        for row in rows:
            row['evidence']=[{**e,'documentId':run.get('_nativeDocs',{}).get(e.get('documentId'),e.get('documentId')),
                              'page':e.get('page',e.get('pdfPage')),'quote':e.get('quote') or e.get('text','')} for e in row['evidence']]
            for evidence in row['evidence']:
                if not evidence['documentId']:evidence['documentId']=run.get('_sourceDocs',{}).get(evidence.get('source'))
        self.merge(run,rows);self.save_run(run)

    def bootstrap(self):
        industries=read(ROOT/'csa/site/data/industries.json')
        return {'modules':[{'id':k,'name':v} for k,v in MODULES.items()],'projects':self.list_projects(),'trashProjects':self.center.trash(),
                'documents':self.documents(),'industries':[{'code':i['code'],'name':i['zh']} for i in industries],
                'providers':self.app.gateway.public()['providers']}

    def import_project(self,value):
        if not isinstance(value,dict):raise LocalError('项目JSON必须是对象。')
        source=value.get('project',value)
        if not isinstance(source,dict):raise LocalError('无法识别项目结构。')
        if source.get('module') in MODULES:
            result=deepcopy(source)
        elif source.get('methodYear') and source.get('industry'):
            result={'module':'csa','name':source.get('name','CSA导入项目'),'company':source.get('name',''),
                    'reportPeriod':source.get('reportPeriod',''),'targetPeriod':source.get('targetPeriod',''),
                    'options':{'industry':source['industry'],'industryBasis':source.get('industryBasis',''),'listed':source.get('listed','unknown')},
                    'comments':{r.get('questionId',''):r.get('review',{}).get('opinion','') for r in source.get('results',[])}}
        elif source.get('exchange') in {'sh','sz','bj','hk'}:
            result={'module':'hkex' if source['exchange']=='hk' else 'mainland','name':source.get('customerName','交易所导入项目'),
                    'company':source.get('customerName',''),'reportPeriod':source.get('reportYear',''),'targetPeriod':source.get('targetYear',''),
                    'options':{k:source.get(k,'') for k in ('exchange','board','industry','issuerCategory','fiscalYearStart')},
                    'comments':{r.get('topicId',''):r.get('comment','') for r in source.get('topics',[])}}
        elif 'client_name' in source or 'clientName' in source:
            result={'module':'msci','name':source.get('client_name') or source.get('clientName') or 'MSCI导入项目',
                    'company':source.get('client_name') or source.get('clientName',''),'reportPeriod':source.get('report_period',source.get('reportPeriod','')),
                    'targetPeriod':source.get('target_period',source.get('targetPeriod','')),'options':{'acknowledged':False},'comments':value.get('comments',{})}
        elif 'frameworkVersion' in source:
            result={'module':'benchmark','name':source.get('name','导入对标项目'),'company':'','reportPeriod':'','targetPeriod':'','options':{'industry':source.get('industry','')},'comments':{}}
        else:raise LocalError('此JSON不是已支持的项目格式；原文件未改变。')
        result.pop('id',None);result.pop('revision',None);result.pop('lastRunId',None);result.pop('runIds',None)
        # Never relabel unbound historical results as a verified new assessment.
        result['legacySnapshot']=value;result['importWarnings']=['原始项目完整保留为参考快照；请核对并重新关联原件、方法及适用范围。']
        found=[]
        for ref in result.get('documents',[]):
            try:self.store.document('exchange','library',ref['id']);found.append(ref)
            except (LocalError,KeyError):pass
        result['documents']=found;result['selected']=[]
        try:
            if result.get('methodId'):self.methods.get(result['methodId'])
        except LocalError:result.pop('methodId',None)
        return self.save(result)
