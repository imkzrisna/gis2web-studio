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

// N segmen -> N+1 label (0 ... total). Jarak total = maxMeters dari Leaflet
// untuk lebar bar tetap. Harus sama dengan logika di generated app.js (lib.rs).
export function scaleTicksHtml(maxMeters: number, segments: number): string {
  const n = clampScaleBarSegments(segments);
  const useKm = maxMeters >= 1000;
  const total = useKm ? maxMeters / 1000 : maxMeters;
  const step = total / n;
  const d = step >= 10 ? 0 : step >= 1 ? 1 : 2;
  let html = '<div class="sb-ticks">';
  for (let i = 0; i <= n; i++) {
    const v = Number((step * i).toFixed(d));
    html +=
      '<span class="sb-tick" style="left:' + (i * 100) / n + '%">' + v +
      (i === n ? '<span class="sb-unit">' + (useKm ? "km" : "m") + "</span>" : "") +
      "</span>";
  }
  return html + "</div>";
}

// Scale control Leaflet dengan lebar bar tetap. maxMeters tetap dihitung Leaflet.
const FixedWidthScale = L.Control.Scale.extend({
  _updateMetric(this: any, maxMeters: number) {
    this._mScale.style.width = this.options.maxWidth + "px";
    this._mScale.innerHTML = scaleTicksHtml(maxMeters, this.options.segments);
  },
});

export function createFixedScaleControl(segments: number): L.Control.Scale {
  return new (FixedWidthScale as any)({
    position: "bottomleft",
    metric: true,
    imperial: false,
    maxWidth: SCALE_BAR_WIDTH_PX,
    segments: clampScaleBarSegments(segments),
  });
}
