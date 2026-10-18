"""Build a portable offline HTML containing data, JS, CSS and all source PDFs."""
import base64,json,re
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
SITE=ROOT/'site'
sources=json.loads((ROOT/'extract/sources.json').read_text())
pdfs={sid:base64.b64encode((SITE/s['file']).read_bytes()).decode() for sid,s in sources.items()}
parts=[]
for name in ('data/core.js','data/key-issues.js','xlsx.js','disclosure-search.js','semantic-retrieval.js','workbench-core.js','workbench-batch.js','workbench-export.js','workbench-requirements.js','workbench-native.js','workbench.js','app.js'):
    code=(SITE/name).read_text()
    code=re.sub(r'^import\s+.*?;\s*','',code,flags=re.M|re.S)
    code=re.sub(r'^export\s+\*\s+from\s+.*?;\s*','',code,flags=re.M)
    code=re.sub(r'^export\s+','',code,flags=re.M)
    parts.append(code)
code='const EMBEDDED_PDFS = '+json.dumps(pdfs,separators=(',',':'))+';\n'+'\n'.join(parts)
code=code.replace('</script','<\\/script')
html=(SITE/'index.html').read_text().replace('<link rel="stylesheet" href="styles.css" />','<style>\n'+(SITE/'styles.css').read_text()+'\n</style>')
html=html.replace('<script type="module" src="app.js"></script>','<script>\n'+code+'\n</script>')
(SITE/'msci-esg-ratings.html').write_text(html)
print('Offline HTML:',SITE/'msci-esg-ratings.html',f'({len(html.encode())/1024/1024:.1f} MiB; {len(pdfs)} original PDFs embedded)')
