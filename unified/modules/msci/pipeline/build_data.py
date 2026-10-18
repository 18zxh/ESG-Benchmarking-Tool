"""Build JS data from the reviewed canonical JSON. No machine-specific paths."""
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
def read(name):return json.loads((ROOT/'extract'/name).read_text())
def value(name,data):return f'export const {name} = '+json.dumps(data,ensure_ascii=False,indent=2)+';\n'
issues=read('key_issues.json');structure=read('structure.json');meta=read('metadata.json')
stats=dict(issues=len(issues),indicators=sum(len(i['indicators']) for i in issues),governanceKeyMetrics=sum(len(i['keyMetrics']) for i in issues))
target=ROOT/'site/data';target.mkdir(parents=True,exist_ok=True)
(target/'key-issues.js').write_text('// Reviewed source-backed data. See extract/ and 核验报告.md.\n'+value('PILLARS',structure['pillars'])+value('THEMES',structure['themes'])+value('KEY_ISSUES',issues)+value('KEY_ISSUE_STATS',stats))
(target/'core.js').write_text(value('META',meta['meta'])+value('CORE_MODULES',read('core_modules.json'))+value('SOURCES',read('sources.json')))
print('Built data:',stats)
