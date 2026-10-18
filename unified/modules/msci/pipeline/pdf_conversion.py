"""Page-complete extraction: text layer, image OCR, geometry and tables."""
from __future__ import annotations
import base64
import hashlib
import io
import json
from pathlib import Path
import platform
import re
import subprocess
import tempfile
import threading
import time
import unicodedata

MAX_PDF_BYTES = 30 * 1024 * 1024
MAX_MARKDOWN_BYTES = 16 * 1024 * 1024  # Internal parsed text, not an upload format.
MAX_FIGURES_PER_PAGE = 4
MAX_FIGURES_PER_REPORT = 24
CONVERTER_VERSION = "pdfkit-vision-structured-v2"
_CONVERSION_LOCK = threading.Lock()

class ConversionError(ValueError):
    pass

def _converter() -> Path:
    if platform.system() != "Darwin":
        raise ConversionError("本机 PDF 识别需要 macOS，请在支持的电脑上运行此工作台。")
    source = Path(__file__).with_name("pdf_convert.m")
    bundled = source.parent / "bin/pdf-converter-macos-arm64"
    manifest_path = source.parent / "bin/pdf-converter-manifest.json"
    if platform.machine() == "arm64" and bundled.is_file() and manifest_path.is_file():
        manifest = json.loads(manifest_path.read_text())
        if manifest.get("sourceSha256") == hashlib.sha256(source.read_bytes()).hexdigest() and manifest.get("binarySha256") == hashlib.sha256(bundled.read_bytes()).hexdigest():
            return bundled
    digest = hashlib.sha256(source.read_bytes()).hexdigest()[:20]
    cache = Path.home() / "Library/Caches/MSCI-ESG-Workbench"
    cache.mkdir(parents=True, exist_ok=True, mode=0o700)
    binary = cache / ("pdf-converter-" + digest)
    if not binary.is_file():
        try:
            with tempfile.TemporaryDirectory(dir=cache) as temp:
                output = Path(temp) / "converter"
                result = subprocess.run(["xcrun", "clang", "-O2", "-fobjc-arc", "-framework", "Foundation", "-framework", "AppKit", "-framework", "PDFKit", "-framework", "Vision", str(source), "-o", str(output)], capture_output=True, timeout=180)
                if result.returncode:
                    raise ConversionError("无法准备本机 PDF 识别器，请检查 macOS 命令行开发工具。")
                output.chmod(0o700)
                output.replace(binary)
        except (FileNotFoundError, subprocess.TimeoutExpired):
            raise ConversionError("本机 PDF 识别工具缺失或准备超时，请初始化运行环境。") from None
    return binary

def _normal(text):
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC",str(text))).casefold()

def _clean(text):
    return str(text or "").replace("\x00", "").strip()

def _rect(observation, page):
    x,y,w,h=observation["bbox"]
    return (x*page.width,y*page.height,(x+w)*page.width,(y+h)*page.height)

def _inside(observation, box, page):
    x,y,x2,y2=_rect(observation,page)
    return box[0]-3 <= (x+x2)/2 <= box[2]+3 and box[1]-3 <= (y+y2)/2 <= box[3]+3

def _table_records(page, number, observations):
    candidates = page.find_tables({"snap_tolerance":4,"join_tolerance":4,"intersection_tolerance":5})
    candidates += page.find_tables({"vertical_strategy":"text","horizontal_strategy":"text","min_words_vertical":3,"min_words_horizontal":2,"text_x_tolerance":2,"text_y_tolerance":3})
    tables, used = [], []
    for table in candidates:
        table_box=tuple(round(float(value),2) for value in table.bbox)
        area=(table_box[2]-table_box[0])*(table_box[3]-table_box[1])
        # A text-alignment guess must not join two existing tables across columns.
        if any(max(0,min(table_box[2],other[2])-max(table_box[0],other[0]))*max(0,min(table_box[3],other[3])-max(table_box[1],other[1])) > 0.35*min(area,(other[2]-other[0])*(other[3]-other[1])) for other in used): continue
        rows=[]
        for raw_row, geometry in zip(table.extract(x_tolerance=2,y_tolerance=3),table.rows):
            cells=[]
            for column, (original, box) in enumerate(zip(raw_row,geometry.cells)):
                original=_clean(original)
                if box is None and any(re.fullmatch(r"[-+]?[\d,.]+%?",_clean(value)) for value in raw_row):
                    # Broken vertical borders can leave a row-label cell unregistered.
                    # Only read observed text at that column/row intersection.
                    column_box=table.columns[column].bbox
                    box=(column_box[0],geometry.bbox[1],column_box[2],geometry.bbox[3])
                nearby=sorted([item for item in observations if box and _inside(item,box,page)],key=lambda item:(item["bbox"][1],item["bbox"][0]))
                image=" ".join(dict.fromkeys(item["text"] for item in nearby))
                cells.append(original or image)
            if any(cells): rows.append(cells)
        cols=max((len(row) for row in rows),default=0)
        numeric=sum(bool(re.fullmatch(r"[-+]?[\d,.]+%?",cell)) for row in rows for cell in row)
        labels=sum(bool(re.search(r"[\u4e00-\u9fffA-Za-z]",cell)) for row in rows for cell in row)
        if len(rows)<2 or cols<2 or cols>30 or numeric<2 or labels<2: continue
        box=tuple(round(float(x),2) for x in table.bbox)
        if any(abs(box[0]-other[0])<15 and abs(box[1]-other[1])<15 and abs(box[2]-other[2])<15 for other in used): continue
        used.append(box)
        bands=[(box[0],max(0,box[1]-70),box[2],box[1]),(box[0],box[3],box[2],min(page.height,box[3]+70))]
        contexts=[]
        for band in bands:
            if band[3]<=band[1]: continue
            native=page.crop(band).extract_text(x_tolerance=2,y_tolerance=3) or ""
            image=" ｜ ".join(item["text"] for item in observations if _inside(item,band,page))
            contexts.extend([native,image])
        context="\n".join(dict.fromkeys(_clean(text) for text in contexts if _clean(text)))
        first_is_header=any(re.search(r"年份|年度|单位|项目|指标|范围|名称|202[0-9]",cell) for cell in rows[0])
        first_data=next((index for index,row in enumerate(rows) if sum(bool(re.fullmatch(r"[-+]?[\d,.]+%?",cell)) for cell in row)>=2),1)
        header=("表头原文：\n"+"\n".join(" ｜ ".join(row) for row in rows[:max(1,min(first_data,5))])) if first_is_header else "表格列关系：原始位置第1至"+str(cols)+"列；具体表头见邻近原文。"
        lines=[header]
        for index,row in enumerate(rows,1):
            lines.append("第"+str(index)+"行："+"；".join("第"+str(c+1)+"列="+(value or "〔原单元格为空〕") for c,value in enumerate(row)))
        tables.append({"id":f"p{number}-t{len(tables)+1}","type":"table","text":"\n".join(lines),"headerText":header,"contextText":context,"bbox":list(box),"rows":rows,"rowCount":len(rows),"columnCount":cols,"structureSource":"pdf-geometry+image"})
    return tables

def _ocr_observations(raw, page):
    source=raw.get("ocrBlocks",[])
    cropped=[item for item in source if item.get("region") in {"left","right"}]
    reading=cropped or source
    if cropped:
        # A repeated number at another position is still information. Supplement
        # cropped reads by position, never by global substring membership.
        reading=reading+[item for item in source if item.get("region")=="full" and not any(
            _normal(item.get("text",""))==_normal(other.get("text",""))
            and len(item.get("bbox",[]))==len(other.get("bbox",[]))==4
            and max(abs(float(a)-float(b)) for a,b in zip(item["bbox"],other["bbox"]))<0.008
            for other in cropped)]
    native_words=page.extract_words(x_tolerance=2,y_tolerance=3)
    observations=[]
    for item in reading:
        text=_clean(item.get("text")); normalized=_normal(text)
        box=[round(float(value),4) for value in item.get("bbox",[])]
        if not normalized or len(box)!=4: continue
        confidence=float(item.get("confidence",0))
        observation={"text":text,"confidence":confidence,"bbox":box,"region":item.get("region","full")}
        peers=[candidate for candidate in source if candidate.get("region")!=item.get("region") and _normal(candidate.get("text"))==normalized and len(candidate.get("bbox",[]))==4 and max(abs(a-float(b)) for a,b in zip(box,candidate["bbox"]))<0.008]
        if peers:
            observation["confidence"]=max([confidence]+[float(peer.get("confidence",0)) for peer in peers])
            observation["corroborated"]=True
        if re.fullmatch(r"[-+]?[\d,.]+%?",text):
            matches=[word["text"] for word in native_words if _inside(observation,(word["x0"]-2,word["top"]-2,word["x1"]+2,word["bottom"]+2),page)]
            exact=next((word for word in matches if re.sub(r"[,.]","",word)==re.sub(r"[,.]","",text)),None)
            if exact: observation.update(text=exact,ocrText=text,confidence=1.0,checkedAgainstTextLayer=True)
        duplicate=next((old for old in observations if _normal(old["text"])==_normal(observation["text"]) and max(abs(a-b) for a,b in zip(old["bbox"],box))<0.008),None)
        if duplicate:
            duplicate["corroborated"]=True
            if observation["confidence"]>duplicate["confidence"]: duplicate.update(observation)
        else: observations.append(observation)
    return observations

def _ocr_reading(observations, width, height):
    regions=(["left","right","full"] if width>height*1.3 else ["full"])
    paragraphs=[]
    for region in regions:
        items=sorted([item for item in observations if item["region"]==region],key=lambda item:(item["bbox"][1],item["bbox"][0]))
        rows=[]
        for item in items:
            y=item["bbox"][1]
            if rows and abs(y-rows[-1][0])<0.006: rows[-1][1].append(item)
            else: rows.append([y,[item]])
        if rows: paragraphs.append("\n".join(" ｜ ".join(item["text"] for item in sorted(row,key=lambda item:item["bbox"][0])) for _,row in rows))
    return "\n\n".join(paragraphs)

def _page_figures(page, number, remaining):
    """Candidate figure crops on one page, as JPEG data URLs for later transcription."""
    figures=[]
    if remaining<=0: return figures
    try:
        candidates=sorted(page.images or [],key=lambda item:(float(item.get("top",0)),float(item.get("x0",0))))
    except Exception:
        return figures
    width,height=float(page.width),float(page.height)
    if width<=0 or height<=0: return figures
    for item in candidates:
        if len(figures)>=min(MAX_FIGURES_PER_PAGE,remaining): break
        try:
            x0=max(0.0,float(item["x0"])); top=max(0.0,float(item["top"]))
            x1=min(width,float(item["x1"])); bottom=min(height,float(item["bottom"]))
        except (KeyError,TypeError,ValueError):
            continue
        crop_width,crop_height=x1-x0,bottom-top
        if crop_width<80 or crop_height<80: continue
        share=(crop_width*crop_height)/(width*height)
        if share<0.02 or share>0.80: continue
        try:
            image=page.crop((x0,top,x1,bottom)).to_image(resolution=120).original
            buffer=io.BytesIO(); image.save(buffer,"JPEG",quality=70)
        except Exception:
            continue
        data_url="data:image/jpeg;base64,"+base64.b64encode(buffer.getvalue()).decode("ascii")
        figures.append({"id":f"fig-{number}-{len(figures)+1}","page":number,"width":int(image.size[0]),"height":int(image.size[1]),"dataUrl":data_url})
    return figures

def assemble_pages(raw_pages, source_path, progress=None):
    try:
        import pdfplumber
    except ImportError:
        raise ConversionError("表格识别组件未安装，请先运行工作台的环境初始化。") from None
    pages, issues, table_count, image_pages, figures = [], [], 0, 0, []
    with pdfplumber.open(source_path) as document:
        if len(document.pages) != len(raw_pages):
            raise ConversionError("两种识别器的页数不一致，请重新解析报告。")
        for index, raw in enumerate(raw_pages):
            number=index+1
            if raw.get("page") != number:
                raise ConversionError("识别结果存在重复或缺失页，请重新解析报告。")
            page=document.pages[index]
            native=_clean(raw.get("nativeText"))
            spatial=_clean(page.extract_text(x_tolerance=2,y_tolerance=3))
            base=native or spatial
            blocks=[{"id":f"p{number}-text","type":"text","text":base,"method":"text-layer"}] if base else []
            if spatial and _normal(spatial) != _normal(base):
                blocks.append({"id":f"p{number}-layout","type":"layout-text","text":spatial,"method":"pdf-geometry"})
            existing=_normal(base)+_normal(spatial)
            observations=_ocr_observations(raw,page)
            extra=[item for item in observations if _normal(item["text"]) not in existing]
            low=[item["text"] for item in extra if item["confidence"]<0.45 and not item.get("corroborated") and 0.10<item["bbox"][1]<0.95 and (len(_normal(item["text"]))>=4 or re.search(r"\d",item["text"]))]
            if extra:
                image_pages+=1
                reading=_ocr_reading(observations,float(raw["width"]),float(raw["height"]))
                blocks.append({"id":f"p{number}-image-text","type":"image-text","text":reading,"method":"image-ocr","observations":observations,"uncertainTexts":low,"requiresReview":bool(low),"warning":"第"+str(number)+"页有"+str(len(low))+"处图像文字识别不确定："+ "；".join(low[:3]) if low else ""})
            tables=_table_records(page,number,observations)
            table_count+=len(tables); blocks.extend(tables)
            figures.extend(_page_figures(page,number,MAX_FIGURES_PER_REPORT-len(figures)))
            readable=any(_normal(x["text"]) for x in blocks)
            page_issues=[]
            if not readable: page_issues.append("未识别到可读文字")
            if "\ufffd" in base or re.search(r"[\ue000-\uf8ff]",base): page_issues.append("文字层包含异常字符")
            if low: page_issues.append(str(len(low))+"处图像文字置信度较低")
            issues.extend({"page":number,"message":message} for message in page_issues)
            pages.append({"page":number,"width":raw.get("width"),"height":raw.get("height"),"blocks":blocks,"ocrObservations":observations,"tableCount":len(tables),"imageTextBlocks":len(extra),"issues":page_issues,"readable":readable,"structureChecked":True,"method":"text+image+geometry"})
            if progress: progress({"phase":"表格与页码检查","completed":number,"total":len(raw_pages)})
            page.close()
    return pages,issues,table_count,image_pages,figures

def convert_pdf(content: bytes, filename: str, progress=None) -> dict:
    if not content or len(content)>MAX_PDF_BYTES:
        raise ConversionError("PDF 为空或超过 30 MB。")
    if not content.startswith(b"%PDF-"):
        raise ConversionError("文件不是有效的 PDF。")
    with _CONVERSION_LOCK:
        binary=_converter()
        with tempfile.TemporaryDirectory(prefix="msci-pdf-") as temp:
            source,result_path=Path(temp)/"report.pdf",Path(temp)/"pages.json"
            source.write_bytes(content)
            process=subprocess.Popen([str(binary),str(source),str(result_path)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
            deadline=time.monotonic()+1800
            timer=threading.Timer(1800,lambda:process.kill() if process.poll() is None else None)
            timer.start()
            try:
                for line in process.stdout:
                    if progress:
                        try: progress(json.loads(line))
                        except (ValueError,TypeError): pass
                message=process.stderr.read(); process.wait()
                if time.monotonic()>=deadline:
                    raise ConversionError("PDF 识别超过 30 分钟，请检查扫描清晰度或拆分过大的报告。")
                if process.returncode or not result_path.exists():
                    allowed=["PDF 已损坏或无法读取。","PDF 已加密，请先提供可读取的副本。","PDF 页数须为 1–500 页。","本机简体中文 OCR 不可用。","PDF 页面无法渲染。"]
                    raise ConversionError(next((m for m in allowed if m in message),"PDF 识别失败，请检查文件是否损坏或加密。"))
                raw_pages=json.loads(result_path.read_text())["pages"]
                pages,issues,table_count,image_pages,figures=assemble_pages(raw_pages,source,progress)
            finally:
                timer.cancel()
                if process.poll() is None: process.kill(); process.wait()
                process.stdout.close(); process.stderr.close()
    lines=["# PDF 报告原文","","原文件："+filename.replace("\n"," ").replace("\r"," "),""]
    for page in pages:
        lines+=["## PDF 第 "+str(page["page"])+" 页",""]
        for block in page["blocks"]: lines+=[block["text"],""]
    text="\n".join(lines)
    if len(text.encode("utf-8"))>MAX_MARKDOWN_BYTES:
        raise ConversionError("解析后的信息超过 16 MB，请拆分报告。")
    parser_fingerprint=hashlib.sha256(Path(__file__).read_bytes()+Path(__file__).with_name("pdf_convert.m").read_bytes()).hexdigest()
    meta={"originalName":filename,"originalSha256":hashlib.sha256(content).hexdigest(),"converterVersion":CONVERTER_VERSION,"parserSourceSha256":parser_fingerprint,"pageCount":len(pages),"processedPages":len(pages),"readablePages":sum(p["readable"] for p in pages),"ocrPages":list(range(1,len(pages)+1)),"imageSupplementPages":image_pages,"tableCount":table_count,"pages":pages,"issues":issues,"pageCoverageComplete":len(pages)==len(raw_pages),"structureChecked":True,"layoutVerified":False}
    return {"text":text,"meta":meta,"warnings":["第"+str(x["page"])+"页："+x["message"] for x in issues],"figures":figures}
