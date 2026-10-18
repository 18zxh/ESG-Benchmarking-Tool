"""Immutable methodology snapshots consumed by knowledge, jobs and exports."""
from contextvars import ContextVar
from copy import deepcopy
import json
from pathlib import Path
import re
import time
import uuid
from .core import LocalError, fingerprint

METHOD = ContextVar('workspace_methodology', default=None)
MODULES = {'csa': 'CSA', 'msci': 'MSCI', 'mainland': '大陆交易所', 'hkex': '港交所', 'benchmark': '横向对标'}
ROOT = Path(__file__).parent / 'modules'

def read(path):
    return json.loads(path.read_text())

def criteria(bundle):
    module = bundle['module']; payload = bundle['payload']
    if module == 'csa':
        return [{'id': q['id'], 'title': q.get('titleZh') or q['title'], 'group': q.get('criterionZh', ''),
                 'requirement': q.get('layoutZh') or q['layout'], 'detail': q.get('guidanceZh') or q['guidance'],
                 'source': q['sourceFile'], 'page': q['page']} for q in payload['questions']]
    if module == 'msci':
        return [{'id': q['id'], 'title': q['criterion']['title'], 'group': q['criterion']['issue'],
                 'requirement': q['criterion'].get('definition', ''), 'detail': q['criterion'].get('scoring_rule', ''),
                 'source': q.get('sourceId', ''), 'page': (q['criterion'].get('source_pages') or [None])[0]} for q in payload['criteria']]
    return [{'id': q['id'], 'title': q['name'], 'group': q.get('part') or q.get('dimension', ''),
             'requirement': q['requirement'], 'detail': q.get('sourceText', ''), 'source': q['clause'],
             'page': q.get('sourcePage'), 'default': q.get('governanceDefault', False)} for q in payload['rules']['topics']]

class Methods:
    def __init__(self, app):
        self.app, self.store = app, app.store
        self.original_rules = app.modules.get('exchange', 'rules').load_rules
        native = app.modules.get('csa', 'native_pdf')
        self.original_questions = native.read_questions
        def questions(ids, project):
            bundle = METHOD.get()
            if not bundle or bundle['module'] != 'csa': return self.original_questions(ids, project)
            known = {q['id']: q for q in bundle['payload']['questions']}
            if not isinstance(ids, list) or not 1 <= len(ids) <= 160 or len(set(ids)) != len(ids) or any(i not in known for i in ids):
                raise LocalError('CSA选题不属于当前方法版本。')
            return [deepcopy(known[i]) for i in ids]
        native.read_questions = questions
        def rules(exchange, context=None):
            bundle = METHOD.get()
            if bundle and bundle['module'] in {'mainland', 'hkex', 'benchmark'}:
                value = deepcopy(bundle['payload']['rules'])
                value['version'] += '@' + bundle['hash'][:12]
                value['assessmentGuide']['fingerprint'] = bundle['hash']
                if value['exchange'] != exchange: raise LocalError('方法包与交易所不符。')
                return value
            return self.original_rules(exchange, context)
        for name in ('rules', 'pdf_assessment', 'topic_align', 'benchmark'):
            app.modules.get('exchange', name).load_rules = rules
        benchmark = app.modules.get('exchange', 'benchmark')
        original_framework = benchmark.load_framework
        def framework():
            bundle = METHOD.get()
            if not bundle or bundle['module'] != 'benchmark': return original_framework()
            value = deepcopy(bundle['payload']['framework']); value['version'] += '@' + bundle['hash'][:12]
            return value
        benchmark.load_framework = framework

    def key(self, module, options):
        if module not in MODULES: raise LocalError('未知评估模块。')
        variants = {'csa': ['industry'], 'mainland': ['exchange'], 'hkex': ['issuerCategory', 'fiscalYearStart']}
        return module + ':' + ':'.join(str(options.get(k, '')) for k in variants.get(module, []))

    def baseline(self, module, options):
        if module == 'csa':
            industry = options.get('industry', 'CON')
            if not re.fullmatch('[A-Z]{3}', industry): raise LocalError('CSA行业无效。')
            source = read(ROOT / f'csa/site/data/questions-{industry}.json')
            primary = read(ROOT / 'csa/site/data/question-primary.json').get('overrides', {})
            ids = [q['id'] for q in source if q.get('enabled') and q.get('weight', 0) > 0 and q.get('year') == 2026
                   and q.get('guidanceExtracted') and q.get('methodologyTextComplete') and not q.get('excerptTruncated')
                   and q.get('dimension') != 'Company Information' and q.get('criterion') != '公司基本信息'
                   and primary.get(q['id'], {}).get('status') != 'exclude' and q.get('layout') and q.get('guidance')]
            qs = []
            for start in range(0, len(ids), 160):
                qs.extend(self.original_questions(ids[start:start+160], {'industry':industry, 'version':'Full', 'methodYear':2026}))
            payload = {'questions': qs}; version = '2026-Full-' + industry
        elif module == 'msci':
            catalog = read(ROOT / 'msci/site/data/ai-requirements.json')
            payload = {'criteria': catalog['criteria'], 'sources':catalog['sources']}; version = catalog['schema'] + '-' + catalog['checkedOn']
        else:
            exchange = 'hk' if module == 'hkex' else options.get('exchange', 'sh') if module == 'mainland' else 'sh'
            context = {**options, 'board': 'GEM' if options.get('issuerCategory') == 'gem' else '主板'}
            rules = self.original_rules(exchange, context if exchange == 'hk' else None)
            payload = {'rules': rules}; version = rules['version']
            if module == 'benchmark':
                payload['framework'] = read(ROOT / 'exchange/data/benchmark/framework.json')
                version += '-' + payload['framework']['version']
        return {'module': module, 'catalogKey': self.key(module, options), 'label': MODULES[module], 'version': version,
                'options': options, 'payload': payload, 'sourceNote': '固定公开原版；详细来源保留在完整方法字段中。'}

    def resolve(self, module, options):
        options = {'industry': 'CON', **options} if module == 'csa' else {'exchange':'sh', **options} if module == 'mainland' else options
        key = self.key(module, options)
        current = self.store.project('exchange', 'method-defaults', key)
        if current: return self.get(current['id'])
        value = self.baseline(module, options)
        value.update(id='baseline-' + fingerprint(value)[:32], status='published', createdAt=time.time())
        value['hash'] = fingerprint(value['payload'])
        if not self.store.project('exchange', 'method-packages', value['id']):
            self.store.save_project('exchange', 'method-packages', value['id'], value)
        self.set_default(value['id'])
        return value

    def get(self, key):
        value = self.store.project('exchange', 'method-packages', key)
        if not value: raise LocalError('方法版本不存在。', 404)
        if value.get('hash') != fingerprint(value['payload']): raise LocalError('方法版本指纹不符。', 409)
        return value

    def list(self):
        defaults = {x['key']: x['value']['id'] for x in self.store.list_projects('exchange', 'method-defaults')}
        return [{**x['value'], 'isDefault': defaults.get(x['value']['catalogKey']) == x['key']} for x in self.store.list_projects('exchange', 'method-packages')]

    def draft(self, parent):
        value = deepcopy(self.get(parent)); value.update(id=uuid.uuid4().hex, parentId=parent, status='draft', createdAt=time.time(), version=value['version'] + '-修订')
        self.store.save_project('exchange', 'method-packages', value['id'], value)
        return value

    def validate(self, value):
        errors = []
        try:
            rows = criteria(value)
            if not rows or len({r['id'] for r in rows}) != len(rows): errors.append('题目身份为空或重复。')
            if any(not r['id'] or not r['title'] or not r['requirement'].strip() for r in rows): errors.append('题目标题或完整要求缺失。')
            if not value.get('version', '').strip() or not value.get('sourceNote', '').strip(): errors.append('版本及来源说明必填。')
            module, payload = value['module'], value['payload']
            for source in payload.get('sourceDocuments',[]):
                doc=self.store.document('exchange','library',source['id'])
                if source.get('sha256')!=doc['sha256']:errors.append('方法来源PDF指纹不符。')
            if module == 'csa':
                for q in payload['questions']:
                    if not all(q.get(k) for k in ('layout','guidance','sourceFile','page','industryCode','_methodFields')): errors.append('CSA完整问题/指南/来源页或方法字段缺失。');break
            elif module == 'msci':
                for q in payload['criteria']:
                    self.app.modules.get('msci','model_proxy').validate_evaluation({'criterion':q['criterion'], 'evidence':[], 'project':{}})
                    if not q['criterion'].get('source_pages'): errors.append('MSCI来源页缺失。');break
            else:
                rules = payload['rules']
                if not rules.get('assessmentGuide', {}).get('methodology'): errors.append('完整评估方法缺失。')
                if any(not q.get('sourceText') for q in rules['topics']): errors.append('条文原文缺失。')
                if module == 'hkex' and any(not q.get('assessmentQuestion',{}).get('question') for q in rules['topics']): errors.append('香港检查问题缺失。')
                if module == 'benchmark':
                    checks=self.app.modules.get('exchange','benchmark').checks_for(payload['framework'])
                    if len(checks)!=11 or len(rows)!=21: errors.append('当前对标适配器要求21议题与11个检查项；结构改变需同步更新适配器。')
        except Exception:
            errors.append('方法结构不符合当前适配器契约，请检查完整JSON。')
        return {'valid': not errors, 'errors': list(dict.fromkeys(errors)), 'hash': fingerprint(value.get('payload',{}))}

    def save(self, key, changes):
        old = self.get(key)
        if old['status'] != 'draft': raise LocalError('已发布方法不可修改，请先复制为草稿。', 409)
        value = {**old, **{k:changes[k] for k in ('version','sourceNote','payload') if k in changes}}
        value['hash'] = fingerprint(value['payload'])
        self.store.save_project('exchange','method-packages',key,value)
        return value

    def publish(self, key, acknowledged):
        value = self.get(key); validation = self.validate(value)
        if value['status'] != 'draft' or not validation['valid'] or acknowledged is not True:
            raise LocalError('请先校验方法，并确认已核对官方来源、适用条件和变更内容。', 409)
        value.update(status='published',publishedAt=time.time())
        self.store.save_project('exchange','method-packages',key,value)
        self.set_default(key)
        return value

    def set_default(self, key):
        value=self.get(key)
        if value['status']!='published': raise LocalError('默认版本必须已经发布。')
        self.store.save_project('exchange','method-defaults',value['catalogKey'],{'id':key})
        return value

    def diff(self, key):
        value=self.get(key)
        if not value.get('parentId'): return []
        def split(bundle):
            payload=deepcopy(bundle['payload'])
            collection=payload.pop('questions') if bundle['module']=='csa' else payload.pop('criteria') if bundle['module']=='msci' else payload['rules'].pop('topics')
            return {r['id']:r for r in collection},payload
        before,old_global=split(self.get(value['parentId']));after,new_global=split(value)
        changes=[{'id':i,'change':'新增' if i not in before else '删除' if i not in after else '修改','before':before.get(i),'after':after.get(i)}
                 for i in dict.fromkeys([*before,*after]) if before.get(i)!=after.get(i)]
        if old_global!=new_global:changes.append({'id':'完整方法／适用条件／来源','change':'修改','before':old_global,'after':new_global})
        return changes
