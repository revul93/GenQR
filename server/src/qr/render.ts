import { createRequire } from 'node:module';
import QRCode from 'qrcode';
import { HttpError } from '../http.js';
import type { QrStyle } from './style.js';

/**
 * Renders a styled QR code as SVG. Every export format (PNG, JPG, PDF, DOCX) is produced
 * from this one SVG, so all downloads look identical to the preview.
 *
 * Coordinates are in module units; the SVG is scaled with width/height.
 */

export interface RenderOptions {
  data: string;
  style: QrStyle;
  /** PNG data URI of the centre logo, if any. */
  logoDataUri?: string | null;
  sizePx?: number;
}

const f = (n: number) => Number(n.toFixed(3));

/** Rounded-rectangle path; r = 0 gives a plain rectangle, r = w/2 a circle. */
function roundRect(x: number, y: number, w: number, h: number, r: number): string {
  if (r <= 0) return `M${f(x)} ${f(y)}h${f(w)}v${f(h)}h${f(-w)}z`;
  r = Math.min(r, w / 2, h / 2);
  return (
    `M${f(x + r)} ${f(y)}h${f(w - 2 * r)}a${f(r)} ${f(r)} 0 0 1 ${f(r)} ${f(r)}` +
    `v${f(h - 2 * r)}a${f(r)} ${f(r)} 0 0 1 ${f(-r)} ${f(r)}` +
    `h${f(-(w - 2 * r))}a${f(r)} ${f(r)} 0 0 1 ${f(-r)} ${f(-r)}` +
    `v${f(-(h - 2 * r))}a${f(r)} ${f(r)} 0 0 1 ${f(r)} ${f(-r)}z`
  );
}

function modulePath(shape: QrStyle['moduleShape'], x: number, y: number): string {
  switch (shape) {
    case 'dots':
      // Full-size dots: smaller ones leave gaps that defeat some scanners.
      return roundRect(x, y, 1, 1, 0.5);
    case 'rounded':
      return roundRect(x, y, 1, 1, 0.3);
    default:
      return roundRect(x, y, 1, 1, 0);
  }
}

const FRAME_RADIUS = { square: [0, 0], rounded: [2, 1.3], circle: [3.5, 2.5] } as const;
const BALL_RADIUS = { square: 0, rounded: 0.9, circle: 1.5 } as const;

/** Builds the QR matrix; throws a 400 when the content does not fit. */
export function buildMatrix(data: string, errorCorrection: QrStyle['errorCorrection']) {
  try {
    return QRCode.create(data, { errorCorrectionLevel: errorCorrection }).modules;
  } catch (err) {
    throw new HttpError(400, `The content is too long for a QR code (${(err as Error).message}).`, 'QR_TOO_LONG');
  }
}

export function renderSvg({ data, style, logoDataUri, sizePx = 512 }: RenderOptions): string {
  // A centre logo hides modules, so it needs the highest error correction.
  const matrix = buildMatrix(data, logoDataUri ? 'H' : style.errorCorrection);
  const n = matrix.size;
  const m = style.margin;
  const total = n + 2 * m;

  const isFinder = (r: number, c: number) => (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7);

  // Logo box (module units, relative to the symbol), plus a half-module clearance.
  let logoBox: { x: number; size: number } | null = null;
  if (logoDataUri) {
    const size = (n * style.logoSizePercent) / 100;
    logoBox = { x: (n - size) / 2, size };
  }
  const hiddenByLogo = (r: number, c: number) => {
    if (!logoBox) return false;
    const pad = style.logoBacking ? 0.5 : 0;
    const lo = logoBox.x - pad;
    const hi = logoBox.x + logoBox.size + pad;
    return c + 1 > lo && c < hi && r + 1 > lo && r < hi;
  };

  let modules = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!matrix.get(r, c) || isFinder(r, c) || hiddenByLogo(r, c)) continue;
      // Function patterns (timing, alignment, format info) stay square whatever the style:
      // scanners locate the grid with them.
      const structural = matrix.reservedBit[r * n + c] === 1;
      modules += modulePath(structural ? 'square' : style.moduleShape, c + m, r + m);
    }
  }

  let eyes = '';
  for (const [r, c] of [
    [0, 0],
    [0, n - 7],
    [n - 7, 0],
  ] as const) {
    const x = c + m;
    const y = r + m;
    const [outerR, innerR] = FRAME_RADIUS[style.eyeFrameShape];
    eyes += `<path fill-rule="evenodd" d="${roundRect(x, y, 7, 7, outerR)}${roundRect(x + 1, y + 1, 5, 5, innerR)}"/>`;
    eyes += `<path d="${roundRect(x + 2, y + 2, 3, 3, BALL_RADIUS[style.eyeBallShape])}"/>`;
  }

  let defs = '';
  let moduleFill = style.foreground;
  if (style.gradient) {
    const g = style.gradient;
    if (g.type === 'linear') {
      const a = ((g.rotation - 90) * Math.PI) / 180;
      const cx = total / 2;
      const half = n / 2;
      const [dx, dy] = [Math.cos(a) * half, Math.sin(a) * half];
      defs = `<linearGradient id="fg" gradientUnits="userSpaceOnUse" x1="${f(cx - dx)}" y1="${f(cx - dy)}" x2="${f(cx + dx)}" y2="${f(cx + dy)}">`;
    } else {
      defs = `<radialGradient id="fg" gradientUnits="userSpaceOnUse" cx="${f(total / 2)}" cy="${f(total / 2)}" r="${f(n * 0.7)}">`;
    }
    defs += `<stop offset="0" stop-color="${style.foreground}"/><stop offset="1" stop-color="${g.color}"/></${g.type}Gradient>`;
    moduleFill = 'url(#fg)';
  }
  const eyeFill = style.eyeColor ?? moduleFill;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${sizePx}" height="${sizePx}"${style.moduleShape === 'square' ? ' shape-rendering="crispEdges"' : ''}>`,
  );
  if (defs) parts.push(`<defs>${defs}</defs>`);
  if (!style.transparentBackground) parts.push(`<rect width="${total}" height="${total}" fill="${style.background}"/>`);
  parts.push(`<path fill="${moduleFill}" d="${modules}"/>`);
  parts.push(`<g fill="${eyeFill}" shape-rendering="geometricPrecision">${eyes}</g>`);
  if (logoBox && logoDataUri) {
    const x = logoBox.x + m;
    if (style.logoBacking) {
      const pad = 0.5;
      const plate = style.transparentBackground ? '#ffffff' : style.background;
      parts.push(`<path fill="${plate}" d="${roundRect(x - pad, x - pad, logoBox.size + 2 * pad, logoBox.size + 2 * pad, 0.8)}"/>`);
    }
    parts.push(`<image href="${logoDataUri}" x="${f(x)}" y="${f(x)}" width="${f(logoBox.size)}" height="${f(logoBox.size)}" preserveAspectRatio="xMidYMid meet"/>`);
  }
  parts.push('</svg>');
  return parts.join('');
}

// jsqr is CommonJS; load it the same way under tsx and compiled output.
type JsQR = (data: Uint8ClampedArray, width: number, height: number) => { data: string } | null;
function loadJsQR(): JsQR {
  const mod = createRequire(import.meta.url)('jsqr') as JsQR & { default?: JsQR };
  return mod.default ?? mod;
}

/** Decodes a rendered SVG to check it can be read back. jsQR is stricter than phone cameras. */
export async function scanCheck(svg: string, expected: string): Promise<boolean> {
  const { default: sharp } = await import('sharp');
  const jsQR = loadJsQR();
  const { data, info } = await sharp(Buffer.from(svg)).resize(600, 600).flatten({ background: '#ffffff' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return jsQR(new Uint8ClampedArray(data), info.width, info.height)?.data === expected;
}
