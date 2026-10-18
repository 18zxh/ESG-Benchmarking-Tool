function cellValue(value){return typeof value==='string'?value:JSON.stringify(value);}

export function assessmentBasisSheet(references){
  const list=(Array.isArray(references)?references:[references]).filter(Boolean),rows=[['市场 / 适用情形','内容类型','议题ID','字段','传入AI的内容']];
  for(const reference of list){
    const market=reference.exchange+(reference.context?.issuerCategory?` · ${reference.context.issuerCategory} · ${reference.context.fiscalYearStart}`:'');
    rows.push([market,'模型任务','','task',cellValue(reference.task)]);
    for(const [field,value] of Object.entries(reference.context||{}))rows.push([market,'适用条件','',field,cellValue(value)]);
    for(const [field,value] of Object.entries(reference.assessmentGuide||{}))rows.push([market,'评估方法','',`assessmentGuide.${field}`,cellValue(value)]);
    rows.push([market,'模型指令','','instruction',reference.instruction]);
    for(const [field,value] of Object.entries(reference.limits||{}))rows.push([market,'请求约束','',`limits.${field}`,cellValue(value)]);
    if(reference.applicationText!==undefined)rows.push([market,'适用条文','','applicationText',reference.applicationText]);
    rows.push([market,'输出结构','','output',cellValue(reference.output)]);
    for(const topic of reference.topics||[])for(const [field,value] of Object.entries(topic))rows.push([market,'议题输入',topic.id,field,cellValue(value)]);
  }
  return {name:'AI评级依据',rows,columnWidths:[42,22,24,32,110],wrap:true,freezeRows:1,autoFilter:false};
}
