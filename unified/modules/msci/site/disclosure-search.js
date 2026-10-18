// Search vocabulary for simplified Chinese reports. These are retrieval hints,
// never additional MSCI requirements or evidence of a company's disclosures.
export const DISCLOSURE_TERM_GROUPS = [
  ['温室气体排放','碳排放','greenhouse gas','GHG'],
  ['清洁能源','更清洁的能源','清洁电力','可再生能源','可再生电力','绿色电力','绿电','renewable energy','renewable electricity','cleaner sources'],
  ['范围一','范围1','Scope 1','直接温室气体排放'],
  ['范围二','范围2','Scope 2','能源间接温室气体排放'],
  ['范围三','范围3','Scope 3','其他间接温室气体排放'],
  ['气候目标','减排目标','碳中和目标','净零目标','排放目标','climate targets','emissions targets'],
  ['气候风险','气候适应','物理风险','转型风险','climate change vulnerability'],
  ['产品碳足迹','生命周期评价','生命周期碳排放','product carbon footprint','LCA'],
  ['节水','水资源管理','水资源压力','中水回用','循环用水','回用水','water stress','water conservation'],
  ['生物多样性','生态保护','生态修复','土地利用','biodiversity','land use'],
  ['原材料采购','原材料追溯','负责任采购','森林砍伐','raw material sourcing'],
  ['有毒排放','污染物排放','危险废物','危废','废气','废水','toxic emissions','waste management'],
  ['包装材料','包装废弃物','绿色包装','可回收包装','packaging material'],
  ['电子废弃物','废旧电子产品','电子垃圾','电子废物','electronic waste'],
  ['融资环境影响','投融资环境风险','环境和社会风险管理','信贷环境风险','绿色信贷','绿色贷款','financing environmental impact'],
  ['清洁技术机遇','低碳技术','绿色技术','clean technology'],
  ['绿色建筑机遇','绿色建筑','建筑节能','green building'],
  ['可再生能源机遇','新能源业务','renewable energy opportunities'],
  ['劳工管理','劳动权益','员工权益','集体协商','劳动合同','labor management'],
  ['人力资本发展','人才培养','员工培训','职业发展','human capital development'],
  ['职业健康','职业健康与安全','安全生产','职业病','工伤','因工死亡','health and safety','occupational safety'],
  ['供应链劳工','供应商人权','供应商劳工','供应商社会责任','supply chain labor'],
  ['产品安全与质量','产品质量','质量管理','产品召回','product safety and quality'],
  ['化学品安全','有害化学物质','化学物质管理','chemical safety'],
  ['金融消费者保护','金融消费者权益','客户权益保护','投诉处理','consumer financial protection'],
  ['隐私与数据安全','隐私保护','个人信息保护','数据安全','信息安全','privacy and data security'],
  ['负责任投资','ESG投资','可持续投资','responsible investment'],
  ['医疗可及性','药品可及性','医疗服务覆盖','access to health care'],
  ['金融可及性','普惠金融','小微金融','无障碍金融','access to finance'],
  ['营养与健康机遇','健康营养','营养改善','nutrition and health'],
  ['争议性采购','冲突矿产','负责任矿产','controversial sourcing'],
  ['社区关系','社区沟通','社区影响','community relations'],
  ['董事会','独立董事','董事会独立性','board independence'],
  ['薪酬','高管薪酬','薪酬委员会','股权激励','executive pay'],
  ['所有权与控制','股权结构','控股股东','实际控制人','ownership and control'],
  ['会计','财务报告内控','审计委员会','accounting'],
  ['商业道德','反腐败','反贿赂','廉洁','举报机制','business ethics'],
  ['税收透明度','税务治理','税务风险','tax transparency'],
];

export function normalizeDisclosureSearch(value) {
  return String(value??'').normalize('NFKC').toLowerCase()
    .replace(/([\p{Script=Han}])\s+(?=[\p{Script=Han}])/gu,'$1')
    .replace(/scope\s*([123])\b/g,'scope$1')
    .replace(/范围\s*([123])/g,(_,n)=>'范围'+['','一','二','三'][Number(n)]);
}

export function disclosureSearchExpansion(query) {
  const normalized=normalizeDisclosureSearch(query), terms=[];
  const contains=term=>{
    const needle=normalizeDisclosureSearch(term);
    if(/[\p{Script=Han}]/u.test(needle))return normalized.includes(needle);
    const escaped=needle.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    return new RegExp('(?:^|[^a-z0-9])'+escaped+'(?:$|[^a-z0-9])','i').test(normalized);
  };
  for(const group of DISCLOSURE_TERM_GROUPS)if(group.some(contains))terms.push(...group);
  return [...new Set(terms)].filter(term=>!normalized.includes(normalizeDisclosureSearch(term))).slice(0,80);
}
