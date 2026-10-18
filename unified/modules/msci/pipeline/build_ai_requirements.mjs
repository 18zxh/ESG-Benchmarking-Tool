// Generated inspection artifact. Do not maintain a second copy of criteria.
import fs from 'node:fs';
import { buildRequirementCatalog } from '../site/workbench-requirements.js';
const target = new URL('../site/data/ai-requirements.json', import.meta.url);
const catalog = buildRequirementCatalog();
fs.writeFileSync(target, JSON.stringify(catalog, null, 2) + '\n');
console.log(`Generated site/data/ai-requirements.json (${catalog.issueCount} issues / ${catalog.criterionCount} criteria).`);
