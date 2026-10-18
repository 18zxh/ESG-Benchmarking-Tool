export function decodeMarkdown(bytes) {
  const data=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);
  let encoding='UTF-8',text;
  if(data[0]===255&&data[1]===254){encoding='UTF-16LE';text=new TextDecoder('utf-16le',{fatal:true}).decode(data);}
  else if(data[0]===254&&data[1]===255){encoding='UTF-16BE';text=new TextDecoder('utf-16be',{fatal:true}).decode(data);}
  else{
    try{text=new TextDecoder('utf-8',{fatal:true}).decode(data);}
    catch{encoding='GB18030';try{text=new TextDecoder('gb18030',{fatal:true}).decode(data);}catch{throw new Error('无法识别文件编码，请另存为 UTF-8 Markdown 后载入。');}}
  }
  if(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text))throw new Error('文件包含非文本控制字节，请确认是 Markdown 并另存为 UTF-8。');
  if(!text.trim())throw new Error('Markdown 文件为空，请检查转换结果。');
  const replacement=(text.match(/\uFFFD/g)||[]).length,privateGlyphs=(text.match(/[\uE000-\uF8FF]/g)||[]).length;
  const warnings=[];
  if(encoding!=='UTF-8')warnings.push('按 '+encoding+' 读取，请核对公司名、年份和关键表格；建议另存 UTF-8。');
  if(replacement||privateGlyphs>=5)warnings.push('检测到可能的转换乱码，请对照原 PDF 核验，尤其是数值、单位和表格。');
  if(/\[本页(?:无可提取原生文字| OCR 未找到可读文字)/.test(text))warnings.push('转换文件标出了未提取到文字的页面，不能据此判定企业未披露；请检查原 PDF。');
  if(/\[本页补充 OCR 原文/.test(text))warnings.push('文件包含 OCR 文字，请逐项核对引用页的数字、单位和表格列序。');
  return{text,encoding,warnings};
}
