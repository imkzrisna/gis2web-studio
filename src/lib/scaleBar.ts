import L from "leaflet";

export const SCALE_BAR_SEGMENTS_MIN = 2;
export const SCALE_BAR_SEGMENTS_MAX = 6;
export const SCALE_BAR_SEGMENTS_DEFAULT = 4;
export const SCALE_BAR_WIDTH_PX = 150;

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

// Jarak asli untuk lebar bar tetap, 2 angka signifikan (mis. 13 km, 430 m).
// Harus sama dengan logika di generated app.js (lib.rs).
export function formatScaleDistance(maxMeters: number): string {
  const raw = Number(maxMeters.toPrecision(2));
  return raw >= 1000 ? `${Number((raw / 1000).toPrecision(2))} km` : `${raw} m`;
}

// Scale control Leaflet dengan lebar bar tetap. maxMeters tetap dihitung Leaflet.
const FixedWidthScale = L.Control.Scale.extend({
  _updateMetric(this: any, maxMeters: number) {
    this._updateScale(this._mScale, formatScaleDistance(maxMeters), 1);
  },
});

export function createFixedScaleControl(): L.Control.Scale {
  return new (FixedWidthScale as any)({
    position: "bottomleft",
    metric: true,
    imperial: false,
    maxWidth: SCALE_BAR_WIDTH_PX,
  });
}
