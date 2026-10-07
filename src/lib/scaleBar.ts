export const SCALE_BAR_SEGMENTS_MIN = 2;
export const SCALE_BAR_SEGMENTS_MAX = 6;
export const SCALE_BAR_SEGMENTS_DEFAULT = 4;

export function clampScaleBarSegments(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v)
    ? Math.min(SCALE_BAR_SEGMENTS_MAX, Math.max(SCALE_BAR_SEGMENTS_MIN, Math.round(v)))
    : SCALE_BAR_SEGMENTS_DEFAULT;
}

// Pola alternating: putih - hitam - putih - ... (segmen pertama putih).
export function scaleBarGradient(segments: number): string {
  const n = clampScaleBarSegments(segments);
  const stops: string[] = [];
  for (let i = 0; i < n; i++) {
    const color = i % 2 === 0 ? "#ffffff" : "#1e293b";
    stops.push(`${color} ${(i * 100) / n}% ${((i + 1) * 100) / n}%`);
  }
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}
