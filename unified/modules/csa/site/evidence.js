import { normalize, qName, effectiveDisclosure } from './core.js';
import { questionQueries, keywordScores, rankCandidates } from './retrieval-ranking.js';
import { reportPeriodIssues } from './reports.js';

export const keywords = {
  'Transparency & Reporting': ['报告边界', '报告范围', '鉴证', 'assurance', 'reporting boundaries'],
  'Corporate Governance': ['董事', '薪酬', '持股', 'board', 'remuneration', 'governance'],
  Materiality: ['重要性', '实质性', 'materiality', '利益相关方'],
  'Risk & Crisis Management': ['风险', '危机', 'risk', 'crisis'],
  'Business Ethics': ['廉洁', '贿赂', '举报', '反腐', '道德', 'ethics', 'conduct'],
  'Policy Influence': ['游说', '捐赠', '协会', 'lobby', 'contribution'],
  'Supply Chain Management': ['供应商', '供应链', 'supplier', 'supply chain'],
  'Information Security': ['信息安全', '网络安全', '数据安全', 'cyber', 'security'],
  'Responsible Artificial Intelligence': ['人工智能', 'AI', 'artificial intelligence'],
  'Tax Strategy': ['税务', '纳税', 'tax'],
  'Environmental Policy & Management': [
    '环境管理',
    '环境政策',
    'ISO 14001',
    'environmental management',
  ],
  Energy: ['能源', '能耗', '电力', 'energy', 'electricity'],
  Packaging: ['包装', '塑料', 'packaging'],
  'Waste & Pollutants': ['废弃物', '废水', '污染物', '废物', 'waste', 'pollutant'],
  Water: ['水资源', '耗水', '取水', '用水', 'water'],
  'Climate Strategy': ['气候', '碳', '温室气体', 'climate', 'emission', 'GHG'],
  'Decarbonization Strategy': ['脱碳', '绿色金融', '融资排放', 'financed emissions', 'carbon'],
  Biodiversity: ['生物多样性', '生态', 'biodiversity'],
  'Product Stewardship': ['生命周期', '回收', '循环', '产品责任', 'life cycle', 'recycling'],
  'Sustainable Raw Materials': ['原材料', '毁林', 'raw material', 'deforestation'],
  'Labor Practices': ['劳工', '员工', '薪酬', '劳动', 'labor', 'employee', 'pay'],
  'Human Rights': ['人权', '歧视', 'human rights', 'discrimination'],
  'Human Capital Management': ['培训', '员工', '招聘', '人才', 'training', 'employee', 'hiring'],
  'Occupational Health & Safety': ['职业健康', '工伤', '安全', '伤害', 'injury', 'safety', 'OHS'],
  'Transportation Safety': ['运输安全', '事故', 'accident', 'transport'],
  'Customer Relations': ['客户', '满意度', 'customer'],
  'Privacy Protection': ['隐私', '个人信息', 'privacy'],
  'Financial Inclusion': ['普惠', '金融包容', 'financial inclusion'],
  'Sustainable Finance': ['绿色金融', '可持续金融', '绿色贷款', 'sustainable financ'],
  'Community Relations': ['社区', 'community'],
  'Product Quality & Recall Management': ['产品质量', '召回', '质量管理', 'recall', 'quality'],
  'Health & Nutrition': ['营养', '健康', 'nutrition'],
  'Contribution to Societal Healthcare': ['医疗可及性', '药品', 'healthcare'],
};
export const retrievalTerms = {
  'Sustainability Reporting Boundaries': ['报告范围', '报告边界', '关于本报告', '报告涵盖'],
  'Sustainability Reporting Assurance': ['鉴证', '鉴证声明', '第三方验证', 'assurance'],
  'Board Independence': ['独立董事', '董事独立性'],
  'Board Type': ['董事会组成', '董事会结构', '执行董事', '非执行董事'],
  'Non-Executive Chairperson/ Lead Director': ['独立董事', '非执行', '董事长'],
  'Board Diversity Policy': ['董事会多元', '董事多元', '董事会多样'],
  'Board Gender Diversity': ['女性董事', '女董事', '董事性别'],
  'Board Accountability': ['董事会考核', '董事会评估', '董事出席'],
  'Board Average Tenure': ['董事任期', '平均任期'],
  'Board Industry Experience': ['董事履历', '行业经验'],
  'CEO Compensation – Success Metrics': ['高管薪酬', '薪酬绩效', '绩效薪酬'],
  'CEO Compensation - Long-Term Performance Alignment': ['长期激励', '股权激励', '高管薪酬'],
  'CEO-to-Employee Pay Ratio': ['薪酬比', '薪酬差距'],
  'Management Ownership': ['管理层持股', '高管持股'],
  'Management Ownership Requirements': ['持股要求', '高管持股'],
  'Government Ownership': ['国有', '国资', '政府持股'],
  'Family Ownership': ['家族', '实际控制人'],
  'ESG Governance Oversight': [
    '可持续发展治理',
    'ESG治理',
    'ESG 治理',
    'ESG委员会',
    '可持续发展委员会',
  ],
  'Materiality Analysis': ['重要性议题', '实质性议题', '双重重要性', '重要性分析'],
  'Material Issues for Enterprise Value Creation': ['重要性议题', '实质性议题', '价值创造'],
  'Material Issues for External Stakeholders': ['利益相关方', '重要性议题', '实质性议题'],
  'Risk Governance': ['风险管理', '风险委员会'],
  'Risk Management Processes': ['风险识别', '风险评估', '风险管理流程'],
  'Emerging Risks': ['新兴风险', '新型风险'],
  'Codes of Conduct': ['行为准则', '员工守则', '商业道德'],
  'Anti-Bribery & Anti-Corruption Policy': ['反腐败', '反贿赂', '廉洁', '反商业贿赂'],
  'Whistleblowing Mechanism': ['举报', '投诉渠道'],
  'Reporting on Breaches': ['腐败事件', '违规事件', '违规案件'],
  'Supplier Code of Conduct': ['供应商行为', '供应商准则'],
  'Supplier ESG Programs': ['供应商ESG', '供应商 ESG', '供应商社会责任'],
  'Supplier Screening': ['供应商筛选', '供应商筛查', '供应商准入'],
  'Supplier Assessment and Development': ['供应商评估', '供应商审核', '供应商培训'],
  'KPIs for Supplier Assessment and Development': ['供应商评估', '供应商培训', '供应商审核'],
  'Information Security Policy': ['信息安全', '网络安全', '数据安全'],
  'Information Security Governance': ['信息安全委员会', '数据安全', '信息安全'],
  'Information Security Management Programs': ['信息安全培训', '网络安全演练', '信息安全'],
  'Environmental Policy': ['环境政策', '环境保护方针', '环境管理'],
  'Environmental Management Systems Verification': ['ISO14001', 'ISO 14001', '环境管理体系'],
  'Environmental Violations': ['环境处罚', '环保处罚', '环境违法', '环境违规'],
  'Energy Consumption': ['能源消耗', '能源消费', '综合能耗', '耗电'],
  'Energy Management Programs': ['节能', '能源管理', '能效'],
  'Energy Intensity': ['能源强度', '能耗强度', '单位产值能耗'],
  'Waste Disposal': ['废弃物', '废物处置', '一般固废', '危险废物'],
  'Waste Management Programs': ['废弃物管理', '废物管理', '固废管理'],
  'Hazardous Waste': ['危险废物', '危险废弃物', '危废'],
  'Water Consumption': ['用水量', '取水量', '耗水量', '水资源消耗'],
  'Water Consumption in Water-Stressed Areas': ['水压力', '缺水地区'],
  'Water Risk Management Programs': ['水风险', '水资源风险'],
  'Water Efficiency Management Programs': ['节水', '循环用水', '用水效率'],
  'Climate Governance': ['气候治理', '气候管理', '气候变化委员会'],
  'TCFD Disclosure': ['TCFD', '气候相关财务'],
  'Climate-Related Management Incentives': ['气候激励', '绩效考核', '气候绩效'],
  'Climate Risk Management': ['气候风险', '转型风险', '物理风险'],
  'Climate-Related Scenario Analysis': ['情景分析', '气候情景'],
  'Physical Climate Risk Adaptation': ['物理风险', '物理气候', '适应气候'],
  'Financial Risks of Climate Change': ['气候财务', '气候风险', '财务影响'],
  'Direct Greenhouse Gas Emissions (Scope 1)': ['范围一', '范围1', '范围 1', '直接温室气体'],
  'Indirect Greenhouse Gas Emissions (Scope 2)': ['范围二', '范围2', '范围 2', '间接温室气体'],
  'Indirect Greenhouse Gas Emissions (Scope 3)': ['范围三', '范围3', '范围 3', '价值链排放'],
  'Emissions Reduction Targets': ['减排目标', '碳目标', '碳减排目标'],
  'Internal Carbon Pricing': ['内部碳定价', '碳价格'],
  'Net-Zero Commitment': ['净零', '碳中和'],
  'Net-Zero Transition Plan': ['转型计划', '净零', '碳中和'],
  'Biodiversity Commitment': ['生物多样性', '生态保护'],
  'Biodiversity Risk Assessment': ['生物多样性风险', '生态风险'],
  'Biodiversity Exposure & Assessment': ['生物多样性', '生态评估'],
  'Biodiversity Mitigating Actions': ['生态修复', '生物多样性', '生态保护'],
  'Life Cycle Assessment': ['生命周期', 'LCA'],
  'Product Design Criteria': ['生态设计', '绿色设计', '产品设计'],
  'Product Quality Programs': ['质量管理', '质量控制', '品质管理'],
  'Product Recalls': ['召回'],
  'Labor Practices Commitment': ['劳工', '劳动权益', '雇佣政策'],
  'Labor Practices Programs': ['员工权益', '劳动权益', '劳工'],
  'Discrimination & Harassment': ['歧视', '骚扰'],
  'Workforce Breakdown: Gender': ['女性员工', '员工性别', '男性员工', '性别结构'],
  'Workforce Breakdown: Race/ Ethnicity & Nationality': ['员工国籍', '员工民族', '少数民族'],
  'Gender Pay Indicators': ['性别薪酬', '男女薪酬', '女性薪酬'],
  'Workforce Trade Union and Collective Bargaining Coverage': ['工会', '集体协商', '集体合同'],
  'Human Rights Commitment': ['人权政策', '人权承诺', '尊重人权'],
  'Human Rights Due Diligence Process': ['人权尽职调查', '人权风险', '人权评估'],
  'Human Rights Assessment': ['人权评估', '人权风险'],
  'Human Rights Mitigation & Remediation': ['人权补救', '人权风险', '人权问题'],
  Hiring: ['招聘', '新雇佣', '新入职'],
  'Employee Turnover Rate': ['流失率', '离职率'],
  'Training & Development Inputs': ['培训时数', '培训小时', '培训投入', '培训费用'],
  'Employee Development Programs': ['员工发展', '人才培养', '员工培训'],
  'Employee Support Programs': ['员工关怀', '员工支持', '心理健康'],
  'Long-Term Incentives for Employees': ['长期激励', '股权激励'],
  'Trend of Employee Wellbeing': ['员工满意度', '员工幸福', '员工福祉'],
  'OHS Policy': ['职业健康', '安全生产', '职业安全'],
  'OHS Programs': ['职业健康', '安全培训', '安全生产'],
  Fatalities: ['因工死亡', '死亡人数', '工亡'],
  'Lost-Time Injury Frequency Rate (LTIFR) - Employees': ['损工', '损失工时', '工伤'],
  'Lost-Time Injury Frequency Rate (LTIFR) - Contractors': ['承包商', '损工', '工伤'],
  'Total Recordable Injury Frequency Rate (TRIFR) – Employees': ['可记录', '可录', '工伤率'],
  'Total Recordable Injury Frequency Rate (TRIFR) - Contractors': ['承包商', '可记录'],
  'Customer Relations Management': ['客户关系', '客户管理', '客户投诉'],
  'Customer Satisfaction Measurement': ['客户满意度', '消费者满意度'],
  'Privacy Policy: Systems/ Procedures': ['隐私', '个人信息保护'],
  'Customer Privacy Information': ['客户隐私', '个人信息'],
  'Use of Customer Data': ['客户数据', '用户数据', '个人信息'],
  'Responsible Artificial Intelligence Policy': ['人工智能政策', '负责任人工智能', 'AI伦理'],
  'Responsible Artificial Intelligence Program': ['人工智能治理', 'AI治理', '人工智能'],
  'Tax Strategy and Governance': ['税务治理', '依法纳税', '税务管理'],
  'Tax Reporting': ['纳税', '税费', '所得税'],
  'Effective Tax Rate': ['有效税率', '所得税率'],
};
export function searchEvidence(question, chunks, custom = '') {
  const name = qName(question),
    specific = name === question.title ? [] : [name, ...(name.match(/[\u4e00-\u9fff]{2,}/g) || [])];
  const english = question.title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(
      (w) =>
        w.length > 3 &&
        ![
          'with',
          'from',
          'total',
          'rate',
          'programs',
          'policy',
          'management',
          'products',
          'indicators',
        ].includes(w),
    );
  const terms = [
    ...new Set([
      ...specific,
      ...english,
      ...(retrievalTerms[question.title] || []),
      ...(custom ? custom.split(/[，,;；\s]+/) : []),
    ]),
  ].filter(Boolean);
  const broad = keywords[question.criterion] || [];
  const queries = questionQueries(question, name, custom);
  const bm25 = keywordScores(chunks, queries);
  const rows = chunks
    .map((e, position) => {
      const t = normalize(e.text);
      let score = 0;
      for (const w of terms) if (t.includes(normalize(w))) score += w.length > 6 ? 4 : 2;
      for (const w of broad) if (t.includes(normalize(w))) score += 0.3;
      const index = /报告索引|报告索引表|披露索引|gri content index/i.test(e.text);
      return {
        ...e,
        matchScore: index ? score * 0.4 : score,
        keywordScore: bm25[position] * (index ? 0.4 : 1),
        quality_note: [
          e.quality_note,
          index ? '此片段可能为报告索引，需继续查看实际披露正文。' : '',
        ]
          .filter(Boolean)
          .join('；'),
      };
    });
  const seen = new Map();
  const ranked = rankCandidates(rows).filter((x) => {
    const key = `${x.reportId}:${x.page}`, text = normalize(x.text);
    const previous = seen.get(key) || [];
    if (previous.some((value) => value.includes(text))) return false;
    previous.push(text);
    seen.set(key, previous);
    return true;
  });
  // Represent every matching document before filling the remaining positions.
  // A long annual report must not crowd out all ESG report evidence, or vice versa.
  const picked = [],
    represented = new Set();
  for (const e of ranked) {
    if (!represented.has(e.reportId)) {
      picked.push(e);
      represented.add(e.reportId);
    }
  }
  const ids = new Set(picked.map((e) => e.id));
  for (const e of ranked) {
    if (picked.length >= 8) break;
    if (!ids.has(e.id)) {
      picked.push(e);
      ids.add(e.id);
    }
  }
  return picked.slice(0, 8).sort((a, b) => b.retrievalRank - a.retrievalRank || a.page - b.page);
}
export function initialResult(q, chunks, project, found = null) {
  const evidence = found || searchEvidence(q, chunks);
  const need = effectiveDisclosure(q, project.listed);
  const publicFound = evidence.some((x) => x.public);
  const privateNeed = need === 'Private' || need === 'Partially Public';
  const status = evidence.length ? 'candidate' : privateNeed ? 'internal' : 'not_found';
  const requests = privateNeed
    ? ['核对原问题可接受的内部或公开佐证；仅在已有材料未覆盖时补充制度、台账或指标底稿。']
    : [];
  if (need === 'Public' && !publicFound)
    requests.push('需要公开且可追溯的报告／网站资料；内部材料不能代替公开证据。');
  if (need === 'Partially Public' && !publicFound)
    requests.push('核实问题中公开披露可获额外分数的具体部分，并补充公开来源。');
  if (need === 'Flexible')
    requests.push(
      '非上市公司的公开／内部要求还取决于本题公司类型；例如部分国有企业仍需公开证据。对照原文及门户确认，不自动归为 Private。',
    );
  if (need === '待核实') requests.push('确认上市身份及官方问卷中的证据要求。');
  return {
    questionId: q.id,
    status,
    evidence,
    selectedEvidenceIds: evidence.filter((x) => x.autoSelect ?? x.matchScore >= 4).map((x) => x.id),
    mode: 'local-retrieval',
    current: evidence.length
      ? '检索到相关候选原文，尚未判断是否覆盖问题布局的全部要求。'
      : '本次检索未找到相关候选原文，仍需对照全文核验。',
    gaps: [
      '逐项核对官方问题布局、期间、集团边界与数据口径。',
      '关键词检索可能漏检，未命中不等于企业未披露。',
      ...reportPeriodIssues(project),
    ],
    requests,
    recommendation: '在人工复核中确认已有证据，补充问题要求的材料并记录未覆盖项。',
    uncertainties: [
      '适用性、统计边界及证据充分性尚待人工核验。',
      ...(q.excerptTruncated ? ['方法说明为截短节选，完整条件须对照原 PDF。'] : []),
    ],
    review: { status: 'pending', opinion: '', reviewer: '', updated: null },
    created: new Date().toISOString(),
  };
}
export function selectedEvidenceForResult(result) {
  return Array.isArray(result?.selectedEvidenceIds)
    ? [...new Set(result.selectedEvidenceIds)]
    : result.evidence.filter((e) => Number(e.matchScore) >= 4).map((e) => e.id);
}
