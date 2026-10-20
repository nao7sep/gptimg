// What an export asks for, and the pure rules around it: the size it comes
// out at, the SDK verb that makes it, its file name, and which choices apply.

export const EXPORT_FORMATS = ["png", "jpeg", "webp"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const UPSCALE_FACTORS = [2, 4] as const;
export type UpscaleFactor = (typeof UPSCALE_FACTORS)[number];

export type ExportSize = { kind: "original" } | { kind: "longSide"; px: number } | { kind: "upscale"; factor: UpscaleFactor };

/** The choices an export remembers between uses (state.json). */
export interface ExportPrefs {
  format: ExportFormat;
  /** 1–100, for JPEG and lossy WebP. */
  quality: number;
  /** WebP only. */
  lossless: boolean;
  size: ExportSize;
  /** `#rrggbb` to fill transparency with, or null to keep it where the format can. */
  fill: string | null;
}

export interface ExportRequest extends ExportPrefs {
  /** The image to export (absolute). */
  path: string;
}

/** What the export dialog shows about the image. */
export interface ImageInfo {
  width: number;
  height: number;
  format: string;
  fileBytes: number;
  /** True when some pixel is not fully opaque. */
  transparent: boolean;
}

export const LONG_SIDE = { min: 16, max: 16384 } as const;
export const DEFAULT_FILL = "#ffffff";

export function defaultExportPrefs(): ExportPrefs {
  return { format: "png", quality: 90, lossless: false, size: { kind: "original" }, fill: null };
}

export function parseExportPrefs(value: unknown): ExportPrefs {
  const base = defaultExportPrefs();
  if (!value || typeof value !== "object") return base;
  const raw = value as Record<string, unknown>;
  const format = (EXPORT_FORMATS as readonly unknown[]).includes(raw.format) ? (raw.format as ExportFormat) : base.format;
  const quality = typeof raw.quality === "number" && Number.isInteger(raw.quality) && raw.quality >= 1 && raw.quality <= 100 ? raw.quality : base.quality;
  const lossless = typeof raw.lossless === "boolean" ? raw.lossless : base.lossless;
  const fill = typeof raw.fill === "string" && isColour(raw.fill) ? raw.fill : null;
  return { format, quality, lossless, size: parseSize(raw.size) ?? base.size, fill };
}

function parseSize(value: unknown): ExportSize | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw.kind === "original") return { kind: "original" };
  if (raw.kind === "longSide" && typeof raw.px === "number" && validLongSide(raw.px)) return { kind: "longSide", px: raw.px };
  if (raw.kind === "upscale" && (UPSCALE_FACTORS as readonly unknown[]).includes(raw.factor)) return { kind: "upscale", factor: raw.factor as UpscaleFactor };
  return null;
}

export function isColour(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

export function validLongSide(px: number): boolean {
  return Number.isInteger(px) && px >= LONG_SIDE.min && px <= LONG_SIDE.max;
}

/** The exported image's size, aspect kept. */
export function outputSize(width: number, height: number, size: ExportSize): { width: number; height: number } {
  if (size.kind === "original") return { width, height };
  const long = size.kind === "upscale" ? Math.max(width, height) * size.factor : size.px;
  const scale = long / Math.max(width, height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Whether transparency has to be filled: the image has it, and the user chose a colour or the format cannot hold it. */
export function fillFor(prefs: ExportPrefs, transparent: boolean): string | null {
  if (!transparent) return null;
  if (prefs.format === "jpeg") return prefs.fill ?? DEFAULT_FILL;
  return prefs.fill;
}

export function extensionOf(format: ExportFormat): string {
  return format === "jpeg" ? "jpg" : format;
}

/** The suggested file name: the image's own stem, its new size when it changes, and the format's extension. */
export function exportName(sourcePath: string, prefs: ExportPrefs, size: { width: number; height: number }, original: { width: number; height: number }): string {
  const base = sourcePath.split(/[\\/]/).pop() ?? "image";
  const stem = base.replace(/\.[^.]+$/, "") || "image";
  const sized = size.width === original.width && size.height === original.height ? "" : `-${size.width}x${size.height}`;
  return `${stem}${sized}.${extensionOf(prefs.format)}`;
}

/**
 * The file an export writes for the path the user chose: that path, or, when
 * its extension is not the format's (a name typed past the dialog's filter),
 * the path with the format's extension added, which the user did not agree to
 * replace.
 */
export function exportTarget(chosen: string, format: ExportFormat): { path: string; replace: boolean } {
  const given = /\.([^.\\/]+)$/.exec(chosen)?.[1]?.toLowerCase();
  const accepted = format === "jpeg" ? ["jpg", "jpeg"] : [extensionOf(format)];
  return given !== undefined && accepted.includes(given) ? { path: chosen, replace: true } : { path: `${chosen}.${extensionOf(format)}`, replace: false };
}

/** The SDK verb and its arguments that write the export at `target`, replacing a file there when `replace`. */
export function exportCall(
  request: ExportRequest,
  info: ImageInfo,
  target: { path: string; replace: boolean },
): { op: "encode" | "resize" | "upscale"; args: Record<string, unknown> } {
  const fill = fillFor(request, info.transparent);
  const lossy = request.format === "jpeg" || (request.format === "webp" && !request.lossless);
  const encoding: Record<string, unknown> = {
    format: request.format,
    ...(lossy && { quality: request.quality }),
    ...(request.format === "webp" && request.lossless && { lossless: true }),
    ...(fill && { background: fill }),
  };
  const common = { in: request.path, out: target.path, overwrite: target.replace, ...encoding };
  if (request.size.kind === "original") return { op: "encode", args: common };
  const size = outputSize(info.width, info.height, request.size);
  const toSize = Math.max(size.width, size.height);
  if (request.size.kind === "upscale") return { op: "upscale", args: { ...common, toSize } };
  return { op: "resize", args: { ...common, toSize } };
}
