import { LocalOpError } from "../errors.js";
import type { DetectedFormat } from "../image/detectFormat.js";
import { imageFileName } from "../internal/output-naming.js";

/**
 * A provider image after its bytes have been format-detected. `format` is null
 * when the item yielded no usable image — the provider returned no data, or the
 * bytes would not decode — so the slot contributes only to `partial` and is
 * dropped from the outputs.
 */
export interface DetectedImage {
  format: DetectedFormat | null;
}

export interface PlannedImage {
  /**
   * 1-based position in the provider response. This is provenance, not a count
   * of successes, so it is deliberately stable across failures: if image 2 of 3
   * fails, the survivors keep indices 1 and 3 (filenames `-01`/`-03`, a gap).
   * Renumbering to `-01`/`-02` would desync the filename from the per-image
   * sidecar's `index` field and from the response position — so the gap is the
   * correct behavior, not a defect to compact away.
   */
  index: number;
  format: DetectedFormat;
  fileName: string;
}

export interface GenerateOutputPlan {
  /** Zero-pad width driver: the larger of the requested n and what came back. */
  suffixCount: number;
  images: PlannedImage[];
  /** The single extension the artifact group uses; "png" when nothing succeeded. */
  groupExtension: string;
  /** True when at least one returned item failed to become an output. */
  partial: boolean;
}

/**
 * The pure naming/grouping decision behind `generate`: reconcile the requested
 * count with the provider's actual return, assign each successful image a stable
 * suffixed filename, and enforce the single-format invariant for the group.
 * Format detection (I/O) happens in the caller; this function only decides.
 */
export function planGenerateOutputs(
  n: number,
  stem: string,
  detected: readonly DetectedImage[],
): GenerateOutputPlan {
  // The provider may return fewer or more images than requested; the suffix
  // width must cover whichever is larger so indices never outrun their padding.
  const suffixCount = Math.max(n, detected.length);
  const images: PlannedImage[] = [];
  let partial = false;

  detected.forEach((item, i) => {
    if (!item.format) {
      partial = true;
      return;
    }
    const index = i + 1;
    images.push({
      index,
      format: item.format,
      fileName: imageFileName(stem, index, suffixCount, item.format.extension),
    });
  });

  const extensions = new Set(images.map((img) => img.format.extension));
  if (extensions.size > 1) {
    throw new LocalOpError(
      "output.mixedExtensions",
      `Provider returned images with mixed extensions (${[...extensions].join(", ")}); the artifact group requires a single image format.`,
    );
  }

  const groupExtension = images[0]?.format.extension ?? "png";
  return { suffixCount, images, groupExtension, partial };
}
