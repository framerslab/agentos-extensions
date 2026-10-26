/**
 * The reader's fixtures, written in code at test time: no binary is committed and no library writes them. Each PDF
 * carries the byte offset of every object in its cross-reference table, so pdf.js opens it without rebuilding the
 * table; each Word file is a ZIP archive laid out as JSZip and AgentOS's DocxLoader read one.
 */
import { crc32, deflateRawSync } from 'node:zlib';

/** A PDF of `objects`, numbered from 1, the first the catalog. Every character is one byte (Latin-1). */
function pdf(objects: readonly string[]): Buffer {
  let out = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = out.length;
    out += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** A stream object holding `content`, its dictionary's other entries before its length. */
const stream = (content: string, entries = ''): string => `<< ${entries}/Length ${content.length} >>\nstream\n${content}\nendstream`;

/** A page of US Letter size whose resources and content are the given objects. */
const page = (resources: string, contents: number): string =>
  `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << ${resources} >> /Contents ${contents} 0 R >>`;

/** Two pages of text, "First page" and "Second page", in Helvetica. */
export function twoPagePdf(): Buffer {
  return pdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    page('/Font << /F1 5 0 R >>', 6),
    page('/Font << /F1 5 0 R >>', 7),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    stream('BT /F1 24 Tf 72 700 Td (First page) Tj ET'),
    stream('BT /F1 24 Tf 72 700 Td (Second page) Tj ET'),
  ]);
}

/** One page holding one 2 by 2 pixel grey image and no text, as a scanner writes a page. */
export function scannedPdf(): Buffer {
  return pdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    page('/XObject << /Im1 4 0 R >>', 5),
    stream('ABCD', '/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 '),
    stream('q 612 0 0 792 0 0 cm /Im1 Do Q'),
  ]);
}

/** One entry of a ZIP archive: its name and its bytes before deflating. */
interface ZipEntry {
  readonly name: string;
  readonly data: Buffer;
}

/** The DOS date of 1 January 1980, the first a ZIP archive can say. */
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

/**
 * A ZIP archive of deflated entries: each local header with its data, then the central directory, then its end
 * record, with nothing between the directory and the end record, as DocxLoader's bound check requires.
 */
function zip(entries: readonly ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const deflated = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed to extract
    local.writeUInt16LE(8, 8); // deflated
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed to extract
    central.writeUInt16LE(8, 10); // deflated
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42); // where the local header starts
    parts.push(local, nameBytes, deflated);
    directory.push(central, nameBytes);
    offset += local.length + nameBytes.length + deflated.length;
  }
  const centralDirectory = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8); // entries on this disk
  end.writeUInt16LE(entries.length, 10); // entries in all
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16); // where the central directory starts
  return Buffer.concat([...parts, centralDirectory, end]);
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** The three parts a Word reader needs: the content types, the package's relationships and the document. */
function wordParts(text: string): ZipEntry[] {
  return [
    {
      name: '[Content_Types].xml',
      data: Buffer.from(`${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        + '</Types>'),
    },
    {
      name: '_rels/.rels',
      data: Buffer.from(`${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
        + '</Relationships>'),
    },
    {
      name: 'word/document.xml',
      data: Buffer.from(`${XML}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">`
        + `<w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`),
    },
  ];
}

/** A Word file of one paragraph, "Memo". */
export function simpleDocx(): Buffer {
  return zip(wordParts('Memo'));
}

/** A Word file of one paragraph and a part of `bytes` zeros, which deflates to a few kilobytes and inflates back to `bytes`. */
export function inflatingDocx(bytes: number): Buffer {
  return zip([...wordParts('Memo'), { name: 'word/media/zeros.bin', data: Buffer.alloc(bytes) }]);
}
