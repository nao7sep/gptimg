/** Width of the zero-padded index suffix for n outputs. */
export function indexWidth(n: number): number {
  return String(Math.max(1, n)).length;
}

export function indexSuffix(index: number, n: number): string {
  if (n <= 1) return "";
  return `-${String(index).padStart(indexWidth(n), "0")}`;
}

export function imageFileName(stem: string, index: number, n: number, extension: string): string {
  return `${stem}${indexSuffix(index, n)}.${extension}`;
}
