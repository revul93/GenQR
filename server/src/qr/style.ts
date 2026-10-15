import { z } from 'zod';

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a #RRGGBB colour');

export const qrStyleSchema = z.object({
  foreground: hex.default('#000000'),
  background: hex.default('#ffffff'),
  transparentBackground: z.boolean().default(false),
  gradient: z
    .object({
      type: z.enum(['linear', 'radial']),
      color: hex, // second colour; the first is `foreground`
      rotation: z.number().min(0).max(360).default(45), // linear only, degrees
    })
    .nullable()
    .default(null),
  moduleShape: z.enum(['square', 'rounded', 'dots']).default('square'),
  eyeFrameShape: z.enum(['square', 'rounded', 'circle']).default('square'),
  eyeBallShape: z.enum(['square', 'rounded', 'circle']).default('square'),
  eyeColor: hex.nullable().default(null), // null = same as the modules
  margin: z.number().int().min(0).max(10).default(4), // quiet zone, in modules
  errorCorrection: z.enum(['L', 'M', 'Q', 'H']).default('M'),
  logoSizePercent: z.number().min(10).max(30).default(22),
  logoBacking: z.boolean().default(true), // background-coloured plate behind the logo
});

export type QrStyle = z.infer<typeof qrStyleSchema>;

export const DEFAULT_STYLE: QrStyle = qrStyleSchema.parse({});

/** Parses stored/posted style JSON, filling defaults for fields added later. */
export function parseStyle(value: unknown): QrStyle {
  return qrStyleSchema.parse(typeof value === 'string' ? JSON.parse(value) : (value ?? {}));
}
