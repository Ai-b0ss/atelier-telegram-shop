// Minimal dependency-free XLSX writer for Cloudflare Workers: true ZIP / ECMA-376.
// No formula cells: user-supplied text is always typed as inlineStr.
const te=new TextEncoder();
const u16=(buf,o,n)=>{buf[o]=n&255;buf[o+1]=(n>>>8)&255};
const u32=(buf,o,n)=>{buf[o]=n&255;buf[o+1]=(n>>>8)&255;buf[o+2]=(n>>>16)&255;buf[o+3]=(n>>>24)&255};
const xml=s=>String(s??"").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;");
const col=n=>{let s="";for(let i=n+1;i>0;i=Math.floor((i-1)/26))s=String.fromCharCode(65+(i-1)%26)+s;return s;};
const crc32=data=>{let c=0xFFFFFFFF;for(const b of data){c^=b;for(let j=0;j<8;j++)c=(c>>>1)^((c&1)?0xEDB88320:0)}return(c^0xFFFFFFFF)>>>0;};
function zip(entries){
  const local=[],central=[];let off=0;
  for(const [name,content] of entries){
    const path=te.encode(name),data=te.encode(content),crc=crc32(data);
    const h=new Uint8Array(30+path.length);
    u32(h,0,0x04034B50);u16(h,4,20);u16(h,6,0x0800);u16(h,8,0);
    u32(h,14,crc);u32(h,18,data.length);u32(h,22,data.length);u16(h,26,path.length);h.set(path,30);
    local.push(h,data);
    const cd=new Uint8Array(46+path.length);
    u32(cd,0,0x02014B50);u16(cd,4,20);u16(cd,6,20);u16(cd,8,0x0800);
    u32(cd,16,crc);u32(cd,20,data.length);u32(cd,24,data.length);u16(cd,28,path.length);
    u32(cd,42,off);cd.set(path,46);central.push(cd);
    off+=h.length+data.length;
  }
  const cdsize=central.reduce((v,a)=>v+a.length,0);
  const end=new Uint8Array(22);
  u32(end,0,0x06054B50);u16(end,8,entries.length);u16(end,10,entries.length);u32(end,12,cdsize);u32(end,16,off);
  const pieces=[...local,...central,end];
  const size=pieces.reduce((v,a)=>v+a.length,0);
  const result=new Uint8Array(size);let pos=0;
  for(const p of pieces){result.set(p,pos);pos+=p.length}
  return result;
}
function sheet(headers,records){
  const all=[headers,...records];
  const body=all.map((cells,i)=>'<row r="'+(i+1)+'">'+cells.map((v,j)=>{
    const ref=col(j)+(i+1);
    if(typeof v==="number"&&Number.isFinite(v))return '<c r="'+ref+'" t="n"><v>'+v+'</v></c>';
    return '<c r="'+ref+'" t="inlineStr"><is><t xml:space="preserve">'+xml(v)+'</t></is></c>';
  }).join("")+'</row>').join("");
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'+body+'</sheetData></worksheet>';
}
export function makeXlsx(sheets){
  if(!Array.isArray(sheets)||!sheets.length||sheets.length>15)throw new Error("Invalid workbook");
  const ct=['<?xml version="1.0" encoding="UTF-8"?>','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'];
  const wb=[],rels=[],entries=[];
  sheets.forEach(([name,headers,data],i)=>{
    const idx=i+1;
    ct.push('<Override PartName="/xl/worksheets/sheet'+idx+'.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>');
    wb.push('<sheet name="'+xml(name)+'" sheetId="'+idx+'" r:id="rId'+idx+'"/>');
    rels.push('<Relationship Id="rId'+idx+'" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet'+idx+'.xml"/>');
    entries.push(['xl/worksheets/sheet'+idx+'.xml',sheet(headers,data)]);
  });
  const stylesid=sheets.length+1;
  rels.push('<Relationship Id="rId'+stylesid+'" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>');
  ct.push('</Types>');
  entries.push(
    ['[Content_Types].xml',ct.join("")],
    ['_rels/.rels','<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml','<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'+wb.join("")+'</sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels','<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+rels.join("")+'</Relationships>'],
    ['xl/styles.xml','<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>']
  );
  return zip(entries);
}
