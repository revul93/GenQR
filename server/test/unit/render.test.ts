import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { renderSvg, scanCheck } from '../../src/qr/render.js';
import { parseStyle, qrStyleSchema } from '../../src/qr/style.js';
import { exportQr } from '../../src/qr/export.js';

const DATA = 'https://genqr.test/short/aB3xK9q?s=qr';

async function logo(): Promise<string> {
  const png = await sharp({ create: { width: 64, height: 64, channels: 4, background: '#e69138' } }).png().toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
}

describe('QR rendering', () => {
  const styles: Record<string, object> = {
    plain: {},
    'rounded + gradient': { moduleShape: 'rounded', gradient: { type: 'linear', color: '#0b5394', rotation: 45 }, foreground: '#cc0000' },
    'dots + circle eyes': { moduleShape: 'dots', eyeFrameShape: 'circle', eyeBallShape: 'circle' },
    'radial + rounded eyes': { gradient: { type: 'radial', color: '#38761d' }, eyeFrameShape: 'rounded', eyeBallShape: 'rounded' },
  };

  for (const [name, style] of Object.entries(styles)) {
    it(`${name} decodes back to the encoded data`, async () => {
      const svg = renderSvg({ data: DATA, style: parseStyle(style) });
      expect(await scanCheck(svg, DATA)).toBe(true);
    });
  }

  it('still scans with a 30% logo (error correction forced to H)', async () => {
    for (const moduleShape of ['square', 'rounded', 'dots'] as const) {
      const svg = renderSvg({ data: DATA, style: parseStyle({ moduleShape, logoSizePercent: 30 }), logoDataUri: await logo() });
      expect(await scanCheck(svg, DATA), moduleShape).toBe(true);
    }
  });

  it('fails the scan check for light finder patterns', async () => {
    const svg = renderSvg({ data: DATA, style: parseStyle({ eyeColor: '#eeeeee' }) });
    expect(await scanCheck(svg, DATA)).toBe(false);
  });

  it('rejects content that cannot fit in a QR code', () => {
    expect(() => renderSvg({ data: 'x'.repeat(5000), style: parseStyle({}) })).toThrow(/too long/);
  });

  it('validates colours and fills defaults', () => {
    expect(qrStyleSchema.safeParse({ foreground: 'red' }).success).toBe(false);
    expect(parseStyle('{}')).toMatchObject({ foreground: '#000000', margin: 4, errorCorrection: 'M' });
  });
});

describe('exports', () => {
  const svgAt = (px: number) => renderSvg({ data: DATA, style: parseStyle({}), sizePx: px });
  const magic: Record<string, string> = { png: '89504e47', jpg: 'ffd8ff', svg: '3c737667', pdf: '25504446', docx: '504b0304' };

  for (const format of ['png', 'jpg', 'svg', 'pdf', 'docx'] as const) {
    it(`produces a valid ${format}`, async () => {
      const buf = await exportQr(format, svgAt, format === 'pdf' || format === 'docx' ? 5 : 512, '#ffffff');
      expect(buf.subarray(0, 4).toString('hex').startsWith(magic[format]!)).toBe(true);
    });
  }

  it('renders PNG at the requested size', async () => {
    const png = await exportQr('png', svgAt, 777, '#ffffff');
    expect((await sharp(png).metadata()).width).toBe(777);
  });

  it('sizes the PDF page in centimetres', async () => {
    const pdf = (await exportQr('pdf', svgAt, 5, '#ffffff')).toString('latin1');
    const box = /MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(pdf);
    expect(Number(box![1])).toBeCloseTo((5 / 2.54) * 72, 1);
  });
});
