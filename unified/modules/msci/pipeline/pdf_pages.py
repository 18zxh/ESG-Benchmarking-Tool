"""Physical-page labels and conservative source-page alignment, without an LLM."""
import io, re, difflib, base64, threading
import pdfplumber
from PyPDF2 import PdfWriter, Transformation
from PyPDF2.generic import NameObject, DictionaryObject, DecodedStreamObject, ArrayObject
_PREVIEW_LOCK=threading.Lock()

def page_texts(content):
    with pdfplumber.open(io.BytesIO(content)) as pdf:
        texts=[]
        for page in pdf.pages:
            try:texts.append(page.extract_text() or '')
            except Exception:texts.append('')  # Native PDF vision still receives this page.
        return texts

def preview_page(content, number):
    """Render one unchanged source page locally, independent of browser plugins."""
    if not isinstance(number,int) or isinstance(number,bool) or number<1:
        raise ValueError('PDF 页码无效。')
    if not content.startswith(b'%PDF-'):
        raise ValueError('原文件不是有效的 PDF。')
    try:
        with pdfplumber.open(io.BytesIO(content)) as pdf:
            if not 1<=len(pdf.pages)<=500 or number>len(pdf.pages):
                raise ValueError('PDF 页码超出原文件范围。')
            page=pdf.pages[number-1]
            if not 0<max(page.width,page.height)<=12000:
                raise ValueError('PDF 页面尺寸无效。')
            with _PREVIEW_LOCK:
                image=page.to_image(resolution=72*min(2.5,1800/max(page.width,page.height))).original
                buffer=io.BytesIO();image.save(buffer,'PNG')
            return {'page':number,'dataUrl':'data:image/png;base64,'+base64.b64encode(buffer.getvalue()).decode('ascii')}
    except ValueError:
        raise
    except Exception:
        raise ValueError('无法预览原 PDF 页，请重新上传文件。') from None

def label_page(page, number):
    # A new margin belongs to the request copy only. Original report pixels,
    # tables, fonts and the original file are preserved.
    if page.rotation: page.transfer_rotation_to_content()
    left,bottom=map(float,page.mediabox.lower_left)
    width,height=float(page.mediabox.width),float(page.mediabox.height)
    if left or bottom:page.add_transformation(Transformation().translate(-left,-bottom))
    writer=PdfWriter(); labelled=writer.add_blank_page(width=width,height=height+24)
    labelled.merge_page(page)
    resources=labelled[NameObject('/Resources')]
    if '/Font' not in resources:resources[NameObject('/Font')]=DictionaryObject()
    fonts=resources[NameObject('/Font')]
    fonts[NameObject('/MSCIPageLabel')]=DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/Type1'),NameObject('/BaseFont'):NameObject('/Helvetica')})
    label=DecodedStreamObject()
    label.set_data(f'q 0 0 0 rg BT /MSCIPageLabel 12 Tf 8 {height+7:g} Td (Source PDF physical page {number}) Tj ET Q'.encode('ascii'))
    contents=labelled.get('/Contents')
    streams=list(contents) if isinstance(contents,ArrayObject) else [contents] if contents is not None else []
    labelled[NameObject('/Contents')]=ArrayObject([writer._add_object(stream.get_object()) for stream in [*streams,label]])
    return labelled

def _normal(text):return ''.join(c for c in text if c.isalnum())
def _decimals(text):return {n.replace(',','') for n in re.findall(r'(?<![\d.])\d+(?:,\d{3})*\.\d+(?![\d.])',text)}

ENERGY_UNITS=('万千瓦时','千瓦时','兆瓦时','万千瓦','千瓦','兆瓦')
UNIT_PATTERN=re.compile(r'(?<![\d.])(\d+(?:,\d{3})*(?:\.\d+)?)(\s*)('+'|'.join(sorted(ENERGY_UNITS,key=len,reverse=True))+')')

def repair_units(quote, source):
    """Restore an omitted energy-unit hour from one explicit value-unit pair.

    Never calculate or convert numbers, infer table columns, or choose among
    ambiguous source units. No other facts in the quote are changed.
    """
    pairs={}
    for match in UNIT_PATTERN.finditer(re.sub(r'\s+','',source)):
        pairs.setdefault(match[1].replace(',',''),set()).add(match[3])
    def restore(match):
        known=pairs.get(match[1].replace(',',''),set())
        if len(known)!=1:return match[0]
        unit=next(iter(known))
        # Only restore the omitted hour suffix. A shorter text-layer unit must
        # never override a fuller unit read from the actual PDF image.
        return match[1]+match[2]+unit if unit==match[3]+'时' else match[0]
    return UNIT_PATTERN.sub(restore,quote)

def align_evidence(evidence, texts, start, end):
    """Change a page only when one page has an unambiguous verbatim anchor.

    Short/common phrases, OCR-only pages and ties keep the model's labelled
    page. This never changes the quote or infers a disclosure judgment.
    """
    normalized=[_normal(t) for t in texts]
    page_numbers=[_decimals(t) for t in texts]
    result=[]
    for item in evidence:
        quote=_normal(item['text']);scores=[]
        for page in range(start,end+1):
            text=normalized[page-1]
            longest=difflib.SequenceMatcher(None,quote,text,autojunk=False).find_longest_match(0,len(quote),0,len(text)).size if text else 0
            scores.append((longest,page))
        scores.sort(reverse=True);best,page=scores[0];second=scores[1][0] if len(scores)>1 else 0
        decimals=_decimals(item['text'])
        numeric_pages=[p for p in range(start,end+1) if len(decimals)>=2 and decimals<=page_numbers[p-1]]
        strong=best>=20 and best>=second*1.5
        if len(numeric_pages)==1 and dict((p,size) for size,p in scores)[numeric_pages[0]]>=6:
            page=numeric_pages[0];strong=True
        corrected={**item}
        if page!=item['pdfPage'] and strong:
            corrected['pdfPage']=page;corrected['heading']=f'PDF 第 {page} 页'
        corrected['text']=repair_units(corrected['text'],texts[corrected['pdfPage']-1])
        result.append(corrected)
    return result
