import { disclosureNames } from './core.js';

export const isCompanyInformation = (question) =>
  question.dimension === 'Company Information' || question.criterion === '公司基本信息';

export const isLibraryQuestion = (question, library) =>
  !isCompanyInformation(question) && library?.overrides?.[question.id]?.status !== 'exclude';

// These 2026 headers omit a disclosure category. Their actual requirements were
// checked against each industry's PDF; this reading aid does not assign a type.
const guidanceRules = [
  {
    ids: new Set(['AIR-084', 'TRA-077']),
    title: 'Fleet Exposure',
    phrases: ['Quantitative figures provided in the response do not need supporting evidence'],
    summary: '定量数据无需佐证；可通过参考引用补充计算或汇总口径；材料不必公开。',
  },
  {
    ids: new Set([
      'ALU-065', 'BVG-065', 'CHM-065', 'COL-067', 'COM-065', 'CTR-062', 'ELC-062',
      'FOA-067', 'FRP-063', 'MNX-068', 'MUW-063', 'OGR-065', 'OGX-065', 'STL-068',
    ]),
    title: 'Exposure to Water Stressed Areas',
    phrases: [
      'verify the qualitative part of your response',
      'Quantitative figures provided in the response do not need supporting evidence',
      'If a question text field is available',
    ],
    summary: '定性回答须可核实；若有对应问卷文本框，完整说明可替代附件；定量数据无需佐证；材料不必公开。',
  },
  {
    ids: new Set(['BNK-046', 'FBN-046']),
    title: 'Sector Activities',
    phrases: ['will be used to verify your response', 'If a question text field is available'],
    summary: '回答须可核实；若有对应问卷文本框，完整说明可替代附件；材料不必公开。',
  },
];

export function questionEvidence(question) {
  if (question.disclosure !== '未注明') {
    const label = disclosureNames[question.disclosure] || '类别尚未取得';
    return { key: question.disclosure, label, summary: label, fromGuidance: false };
  }
  const rule = guidanceRules.find((entry) => entry.ids.has(question.id));
  const guidance = String(question.guidance || '').replace(/\s+/g, ' ').trim();
  if (
    rule && question.year === 2026 && question.title === rule.title &&
    guidance.includes('The supporting documents do not need to be available in the public domain') &&
    rule.phrases.every((phrase) => guidance.includes(phrase))
  ) {
    return { key: 'Guidance', label: '材料可非公开', summary: rule.summary, fromGuidance: true };
  }
  return {
    key: '未注明', label: '题头未标注类别',
    summary: '题头未标注证据类别，具体要求请核对本题 PDF。', fromGuidance: false,
  };
}
