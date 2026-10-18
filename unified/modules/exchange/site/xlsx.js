// 通用ZIP/SpreadsheetML工具，复用用户提供的 msci_esg 参考基线；不含其评级方法或数据。
// 极简 XLSX 生成器（无压缩 ZIP + SpreadsheetML），无外部依赖。
// 支持多工作表、字符串与数字单元格、首行加粗。
const enc = new TextEncoder();

/* ---------------- CRC32 ---------------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ---------------- ZIP（store 模式） ---------------- */
function zip(files) {
  // files: [{name, data: Uint8Array}]
  const chunks = [];
  const central = [];
  let offset = 0;
  const dosTime = 0;
  const dosDate = (2026 - 1980) << 9 | (1 << 5) | 1;

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const crc = crc32(f.data);
    const local = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0, true);
    dv.setUint16(8, 0, true);      // store
    dv.setUint16(10, dosTime, true);
    dv.setUint16(12, dosDate, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, f.data.length, true);
    dv.setUint32(22, f.data.length, true);
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    chunks.push(local, f.data);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, f.data.length, true);
    cv.setUint32(24, f.data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += local.length + f.data.length;
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const all = [...chunks, ...central, end];
  const total = all.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of all) { out.set(c, pos); pos += c.length; }
  return out;
}

/* ---------------- SpreadsheetML ---------------- */
const xmlEsc = (s) => String(s).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,"\ufffd").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
const colName = (n) => {
  let s = "";
  n += 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
};

function sheetXml(rows, options = {}) {
  const rowCount = Math.max(rows.length, 1);
  const columnCount = Math.max(...rows.map((row) => row.length), 1);
  const dimension = `<dimension ref="A1:${colName(columnCount - 1)}${rowCount}"/>`;
  const body = rows
    .map((row, r) => {
      const cells = row
        .map((val, c) => {
          if (val === null || val === undefined || val === "") return "";
          const ref = colName(c) + (r + 1);
          const style = r === 0 ? ' s="1"' : options.wrap ? ' s="2"' : "";
          if (typeof val === "number" && Number.isFinite(val)) {
            const numberStyle=r>0&&options.percentColumns?.includes(c)?' s="3"':style;
            return `<c r="${ref}"${numberStyle}><v>${val}</v></c>`;
          }
          if (String(val).length > 32767) throw new Error("导出内容超过单元格长度限制，请分为续行后导出。");
          return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(val)}</t></is></c>`;
        })
        .join("");
      const height = options.rowHeights?.[r] ?? (options.wrap ? (r===0 ? 32 : Math.min(96,Math.max(24,Math.max(...row.map((v)=>Math.ceil(String(v ?? "").length/32)),1)*15))) : 0);
      return `<row r="${r + 1}"${height ? ` ht="${height}" customHeight="1"` : ""}>${cells}</row>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${dimension}${options.freezeRows ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${options.freezeRows}" topLeftCell="A${options.freezeRows+1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` : ""}<sheetData>${body}</sheetData>${options.autoFilter ? `<autoFilter ref="A1:${colName(columnCount-1)}${rowCount}"/>` : ""}</worksheet>`;
}

function colWidths(rows) {
  const widths = [];
  rows.forEach((row) => row.forEach((v, c) => {
    const len = String(v ?? "").length;
    widths[c] = Math.min(64, Math.max(widths[c] || 8, len + 2));
  }));
  return widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("");
}

/** sheets: [{ name, rows, widths? }] -> Uint8Array (.xlsx) */
export function buildXlsx(sheets) {
  const n = sheets.length;
  const files = [];

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets.map((_s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheets.map((s, i) => `<sheet name="${xmlEsc(s.name || `Sheet${i + 1}`)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets>
</workbook>`;

  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((_s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}
<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

  files.push({ name: "[Content_Types].xml", data: enc.encode(contentTypes) });
  files.push({ name: "_rels/.rels", data: enc.encode(rels) });
  files.push({ name: "xl/workbook.xml", data: enc.encode(workbook) });
  files.push({ name: "xl/_rels/workbook.xml.rels", data: enc.encode(wbRels) });
  files.push({ name: "xl/styles.xml", data: enc.encode(styles) });
  sheets.forEach((s, i) => {
    let xml = sheetXml(s.rows,s);
    if (s.widths !== false) {
      const cols = s.columnWidths ? s.columnWidths.map((width,i)=>`<col min="${i+1}" max="${i+1}" width="${width}" customWidth="1"/>`).join("") : colWidths(s.rows);
      if (cols) xml = xml.replace("<sheetData>", `<cols>${cols}</cols><sheetData>`);
    }
    files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: enc.encode(xml) });
  });

  return zip(files);
}

let lastDownloadUrl = "";
/** 生成下载地址并触发下载，保留一个地址供页面提供再次下载入口。 */
export function downloadXlsx(filename, bytes) {
  if (lastDownloadUrl) URL.revokeObjectURL(lastDownloadUrl);
  const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  lastDownloadUrl = url;
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  return { url, filename };
}
