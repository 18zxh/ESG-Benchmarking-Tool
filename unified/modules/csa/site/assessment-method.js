// One method record feeds both the industry workbook and the GLM assessment request.
export function assessmentMethodRecord(question, industry, translationData, schema) {
  const translations = translationData?.translations || translationData || {};
  if (schema?.schema !== 1 || !Array.isArray(schema.fields))
    throw new Error('方法字段清单缺失或版本不支持，不能生成。');
  const source = { ...question, industryCode: industry.code, industryEn: industry.name, industryZh: industry.zh };
  return Object.fromEntries(schema.fields.map((field) => {
    if (!field?.key || !field?.source) throw new Error('方法字段清单格式错误，不能生成。');
    const value = source[field.source];
    const result = field.translation ? translations[field.translation]?.[value] || '' : value;
    return [field.key, result ?? ''];
  }));
}

// Mirrors pipeline.native_pdf.read_questions: only method-backed, positive-weight
// Full items can be sent to GLM. Keep this predicate aligned with the server.
export function isAssessmentMethodEligible(question, library) {
  return Boolean(
    question &&
      question.enabled &&
      Number(question.weight) > 0 &&
      Number(question.year) === 2026 &&
      question.guidanceExtracted &&
      question.methodologyTextComplete &&
      !question.excerptTruncated &&
      question.dimension !== 'Company Information' &&
      question.criterion !== '公司基本信息' &&
      question.layout &&
      question.guidance &&
      library?.overrides?.[question.id]?.status !== 'exclude',
  );
}

export function assessmentMethodSheet(industry, questions, translationData, library, schema, name = 'AI方法依据') {
  const fields = schema?.fields;
  const keys = Array.isArray(fields) ? fields.map((field) => field?.key) : [];
  if (!Array.isArray(fields) || !fields.length || schema.schema !== 1 ||
      fields.some((field) => !field || typeof field.key !== 'string' || !field.key || typeof field.source !== 'string' || !field.source) ||
      keys.length !== new Set(keys).size)
    throw new Error('方法字段清单缺失或版本不支持，不能导出。');
  const headers = fields.map((field) => field.label);
  const rows = [headers];
  for (const question of questions) {
    if (!isAssessmentMethodEligible(question, library)) continue;
    const record = assessmentMethodRecord(question, industry, translationData, schema);
    rows.push(fields.map(({ key }) => record[key] ?? ''));
  }
  return {
    name: name.slice(0, 31),
    rows,
    freezeRows: 1,
    freezeColumns: 2,
    autoFilter: true,
    wrap: true,
    fitRowHeight: true,
    minRowHeight: 42,
    maxRowHeight: 409,
    sharedStrings: true,
    columnWidths: [23, 14, 30, 24, 30, 23, 34, 25, 40, 32, 22, 17, 14, 18, 72, 72, 72, 72, 72, 72, 48, 15, 15],
  };
}
