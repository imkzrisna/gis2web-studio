// Posisi label manual: key "layerIndex:featureIndex" -> [lat, lng].
export type LabelPositions = Record<string, [number, number]>;

export function sanitizeLabelPositions(raw: unknown): LabelPositions {
  const out: LabelPositions = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^\d+:\d+$/.test(key) || !Array.isArray(v) || v.length !== 2) continue;
    const [lat, lng] = v;
    if (
      typeof lat === "number" && Number.isFinite(lat) && Math.abs(lat) <= 90 &&
      typeof lng === "number" && Number.isFinite(lng) && Math.abs(lng) <= 180
    ) {
      out[key] = [lat, lng];
    }
  }
  return out;
}
