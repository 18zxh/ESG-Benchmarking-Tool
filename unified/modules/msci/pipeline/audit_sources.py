"""Independently re-open bundled PDFs and check fingerprints, text and coverage.
Requires pdfplumber. Usage: python3 pipeline/audit_sources.py [report.json]
"""
import hashlib,json,re,sys,unicodedata
from pathlib import Path
import pdfplumber

ROOT=Path(__file__).resolve().parents[1]
def read(name):return json.loads((ROOT/'extract'/name).read_text())
def norm(s):
    s=unicodedata.normalize('NFKC',s or '').replace('’',"'").replace('–','-').replace('—','-').replace('−','-')
    s=re.sub(r'(?<=[A-Za-z])-\s+(?=[a-z])','-',s)
    return re.sub(r'\s+',' ',s).strip().lower()
issues=read('key_issues.json');sources=read('sources.json');core=read('core_modules.json');structure=read('structure.json')
errors=[];counts=[];fresh={};checked_fields=0
def check(condition,code,detail):
    if not condition:errors.append(dict(code=code,detail=detail))
for sid,source in sources.items():
    path=ROOT/'site'/source['file']
    check(hashlib.sha256(path.read_bytes()).hexdigest()==source['sha256'],'PDF_FINGERPRINT',sid)
    with pdfplumber.open(path) as pdf:
        check(len(pdf.pages)==source['pages'],'PDF_PAGE_COUNT',sid)
        fresh[sid]=[(page.filter(lambda o:o.get('object_type')=='char' and o.get('top',0)>60 and o.get('bottom',9999)<page.height-44 and o.get('size',0)>=9).extract_text(x_tolerance=2,y_tolerance=4) or '') for page in pdf.pages]
    print('Opened',sid,source['pages'],'pages',flush=True)
for issue in issues:
    sid=issue['sourceId'];pages=fresh[sid];alltext=norm(' '.join(pages))
    all_ind=issue['indicators']+issue['keyMetrics']
    expected=len(re.findall(r'(?m)^\s*(?:[•▪\uf0a7]\s*)?Definition(?:\s*:|\s*$|\s+)', '\n'.join(pages)))
    check(expected==len(all_ind),'DEFINITION_COVERAGE',dict(issue=sid,sourceDefinitions=expected,siteItems=len(all_ind)))
    for field in ('intro',):
        check(norm(issue[field]) in alltext,'ISSUE_TEXT',dict(issue=sid,field=field))
    for risk in issue['risks']:check(norm(risk) in alltext,'RISK_TEXT',dict(issue=sid,text=risk))
    for item in all_ind:
        check(bool(item.get('nameCn')) and bool(item.get('definitionCn')),'CHINESE_MISSING',dict(issue=sid,name=item['name']))
        ps=item['sourcePages'];check(bool(ps) and all(isinstance(p,int) and 1<=p<=len(pages) for p in ps),'REFERENCE_RANGE',dict(issue=sid,name=item['name']))
        evidence=norm(' '.join(pages[p-1] for p in ps))
        title=item.get('fullName',item['name'])
        check(norm(title) in evidence,'TITLE_SOURCE',dict(issue=sid,name=item['name']))
        check(norm(item['definition']) in evidence,'DEFINITION_SOURCE',dict(issue=sid,name=item['name']))
        checked_fields+=2
        if item in issue['keyMetrics']:
            for field in ('scope','deduction','range'):
                if item[field]:
                    check(norm(item[field]) in evidence,'GOVERNANCE_RULE_SOURCE',dict(issue=sid,name=item['name'],field=field));checked_fields+=1
        if item in issue['indicators'] and item['level']>1:
            check(any(p['name']==item['parent'] for p in issue['indicators']),'PARENT_RELATIONSHIP',dict(issue=sid,name=item['name']))
        check('…' not in item['nameCn'] and '...' not in item['nameCn'],'TRUNCATED_TITLE',dict(issue=sid,name=item['name']))
    for rule in issue['rules']:check(all(1<=p<=len(pages) for p in rule['pages']),'RULE_REFERENCE',sid)
    counts.append(dict(issue=sid,indicators=len(issue['indicators']),governanceKeyMetrics=len(issue['keyMetrics']),sourceDefinitionCount=expected))
check(len(issues)==33 and len({i['id'] for i in issues})==33,'ISSUE_COUNT',len(issues))
check(len(structure['pillars'])==3 and len(structure['themes'])==10,'HIERARCHY_COUNT',structure)
check({m['id'] for m in core}=={'symbols','methodology','process','history'},'MODULES',[m['id'] for m in core])
required_core_pages={
    'symbols':set(range(4,20))|set(range(21,26)),
    'methodology':set(range(5,58)),
    'process':set(range(4,16)),
    'history':set(range(4,18)),
}
for m in core:
    s=sources[m['sourceId']]
    check(len({c['id'] for c in m['sections']})==len(m['sections']),'SECTION_UNIQUENESS',m['id'])
    mapped={p for c in m['sections'] for p in c['pages']}
    missing=sorted(required_core_pages[m['id']]-mapped)
    check(not missing,'CORE_CONTENT_PAGE_COVERAGE',dict(module=m['id'],missingPages=missing))
    for c in m['sections']:
        check(bool(c['pages']) and all(1<=p<=s['pages'] for p in c['pages']),'CORE_REFERENCE',dict(module=m['id'],section=c['id']))
        if c.get('table'):check(all(len(r)==len(c['table']['headers']) for r in c['table']['rows']),'CORE_TABLE_SHAPE',dict(module=m['id'],section=c['id']))
report=dict(status='passed' if not errors else 'failed',sourcePDFs=len(sources),keyIssues=len(issues),indicators=sum(len(i['indicators']) for i in issues),governanceKeyMetrics=sum(len(i['keyMetrics']) for i in issues),coreModules=len(core),coreSections=sum(len(m['sections']) for m in core),englishFieldsChecked=checked_fields,counts=counts,errors=errors,limits='Checks exact normalized English text, completeness of explicitly labeled Definition blocks, references and fingerprints. Chinese interpretation, tables and full proprietary scoring are not automatically certified by these checks.')
target=Path(sys.argv[1]) if len(sys.argv)>1 else ROOT/'extract/audit-result.json'
target.write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps({k:v for k,v in report.items() if k not in ('counts','limits')},ensure_ascii=False,indent=2))
raise SystemExit(bool(errors))
