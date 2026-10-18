import { assessmentMethodSheet } from './assessment-method.js';

export function buildQuestionSheets(industry, questions, translations, library, schema) {
  return [assessmentMethodSheet(industry, questions, translations, library, schema, 'AI方法依据')];
}
