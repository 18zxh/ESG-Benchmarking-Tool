import { ALL_CRITERIA, buildEvaluationInput } from './workbench-core.js';
import { META, SOURCES } from './data/core.js';
import { KEY_ISSUES } from './data/key-issues.js';

// The native PDF queue and generated maintenance snapshot use this builder.
// Maintenance lives in extract/ and the generated site/data/ modules.
export function aiRequirementsForIssues(issueIds) {
  const selected = new Set(issueIds);
  return ALL_CRITERIA.filter(c => selected.has(c.issueId)).map(c => ({
    id: c.id, issueId: c.issueId, criterion: buildEvaluationInput(c, [], {}).criterion,
  }));
}

export function buildRequirementCatalog() {
  const requests = new Map(aiRequirementsForIssues(KEY_ISSUES.map(i => i.id)).map(c => [c.id, c]));
  return {
    schema: 'msci-ai-requirements-v1', checkedOn: META.checkedOn,
    issueCount: KEY_ISSUES.length, criterionCount: ALL_CRITERIA.length,
    sources: Object.values(SOURCES).map(({ id, title, version, pages, file, sha256 }) => ({ id, title, version, pages, file, sha256 })),
    criteria: ALL_CRITERIA.map(c => ({
      ...requests.get(c.id), sourceId: c.sourceId, kind: c.kind,
      component: c.item.componentCn || c.item.component || '', level: c.item.level || 1,
    })),
  };
}
