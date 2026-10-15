import sharp from 'sharp';
import PDFDocument from 'pdfkit';
import { Document, ImageRun, Packer, Paragraph } from 'docx';

export type ExportFormat = 'png' | 'jpg' | 'svg' | 'pdf' | 'docx';

export const EXPORT_TYPES: Record<ExportFormat, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

const CM_PER_INCH = 2.54;
const PRINT_DPI = 600;

/** Re-renders the SVG at a given pixel size. */
export type SvgAtSize = (sizePx: number) => string;

async function raster(svgAt: SvgAtSize, sizePx: number, format: 'png' | 'jpg', background: string): Promise<Buffer> {
  const img = sharp(Buffer.from(svgAt(sizePx)));
  // JPEG has no transparency: flatten onto the background colour (white for transparent codes).
  return format === 'png' ? img.png().toBuffer() : img.flatten({ background }).jpeg({ quality: 92 }).toBuffer();
}

function pdf(png: Buffer, sizeCm: number): Promise<Buffer> {
  const pt = (sizeCm / CM_PER_INCH) * 72;
  const doc = new PDFDocument({ size: [pt, pt], margin: 0, info: { Title: 'QR code', Producer: 'GenQR' } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  doc.image(png, 0, 0, { width: pt, height: pt });
  doc.end();
  return done;
}

function docx(png: Buffer, sizeCm: number): Promise<Buffer> {
  const px = Math.round((sizeCm / CM_PER_INCH) * 96); // docx sizes images at 96 px per inch
  const doc = new Document({
    creator: 'GenQR',
    title: 'QR code',
    sections: [{ children: [new Paragraph({ children: [new ImageRun({ type: 'png', data: png, transformation: { width: px, height: px } })] })] }],
  });
  return Packer.toBuffer(doc);
}

/**
 * `size` is pixels for png/jpg/svg and centimetres for pdf/docx (the printed size).
 */
export async function exportQr(format: ExportFormat, svgAt: SvgAtSize, size: number, background: string): Promise<Buffer> {
  switch (format) {
    case 'svg':
      return Buffer.from(svgAt(size));
    case 'png':
    case 'jpg':
      return raster(svgAt, size, format, background);
    case 'pdf':
    case 'docx': {
      const px = Math.min(4096, Math.round((size / CM_PER_INCH) * PRINT_DPI));
      const png = await raster(svgAt, px, 'png', background);
      return format === 'pdf' ? pdf(png, size) : docx(png, size);
    }
  }
}
