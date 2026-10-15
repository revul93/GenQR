import { api } from './api';

// Mirrors server/src/qr/style.ts.
export interface QrStyle {
  foreground: string;
  background: string;
  transparentBackground: boolean;
  gradient: { type: 'linear' | 'radial'; color: string; rotation: number } | null;
  moduleShape: 'square' | 'rounded' | 'dots';
  eyeFrameShape: 'square' | 'rounded' | 'circle';
  eyeBallShape: 'square' | 'rounded' | 'circle';
  eyeColor: string | null;
  margin: number;
  errorCorrection: 'L' | 'M' | 'Q' | 'H';
  logoSizePercent: number;
  logoBacking: boolean;
}

export const DEFAULT_STYLE: QrStyle = {
  foreground: '#000000',
  background: '#ffffff',
  transparentBackground: false,
  gradient: null,
  moduleShape: 'square',
  eyeFrameShape: 'square',
  eyeBallShape: 'square',
  eyeColor: null,
  margin: 4,
  errorCorrection: 'M',
  logoSizePercent: 22,
  logoBacking: true,
};

export type ContentType = 'url' | 'text';

export interface QrCode {
  id: number;
  ownerId: number;
  ownerUsername: string;
  ownerDisplayName: string;
  title: string;
  contentType: ContentType;
  content: string;
  encodedData: string;
  style: QrStyle;
  logoId: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface Logo {
  id: number;
  name: string;
  width: number;
  height: number;
  isShared: boolean;
  ownerId: number | null;
}

export interface Preset {
  id: number;
  name: string;
  style: QrStyle;
  logoId: number | null;
  isDefault: boolean;
}

export const logoUrl = (id: number) => `/api/qr/logos/${id}/image`;
export const qrImageUrl = (qr: Pick<QrCode, 'id' | 'updatedAt'>, size = 512) => `/api/qr/${qr.id}/image.svg?size=${size}&v=${qr.updatedAt}`;
export const exportUrl = (id: number, format: string, size: number) => `/api/qr/${id}/export?format=${format}&size=${size}`;
export const svgDataUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

export const fetchLogos = async () => (await api.get<{ logos: Logo[] }>('/qr/logos')).logos;
export const fetchPresets = async () => (await api.get<{ presets: Preset[] }>('/qr/presets')).presets;

/** Reads a file into a data URL and uploads it as a logo. */
export async function uploadLogo(file: File, shared = false): Promise<Logo> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  const name = file.name.replace(/\.[^.]+$/, '') || 'Logo';
  return (await api.post<{ logo: Logo }>('/qr/logos', { name, dataUrl, shared })).logo;
}

// WCAG relative luminance / contrast, used to warn about hard-to-scan colour choices.
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

export function contrast(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1! + 0.05) / (l2! + 0.05);
}

/** Human-readable warnings about colours that scanners may struggle with. */
export function colourWarnings(style: QrStyle): string[] {
  const bg = style.transparentBackground ? '#ffffff' : style.background;
  const warnings: string[] = [];
  const check = (colour: string, what: string) => {
    if (luminance(colour) > luminance(bg)) warnings.push(`The ${what} is lighter than the background. Many scanners need dark-on-light codes.`);
    else if (contrast(colour, bg) < 3) warnings.push(`The ${what} has low contrast against the background (${contrast(colour, bg).toFixed(1)}:1). Aim for at least 3:1.`);
  };
  check(style.foreground, 'code colour');
  if (style.gradient) check(style.gradient.color, 'gradient end colour');
  if (style.eyeColor) check(style.eyeColor, 'corner (eye) colour');
  if (style.transparentBackground) warnings.push('Transparent codes rely on whatever they are printed on; make sure that surface is light.');
  return warnings;
}
