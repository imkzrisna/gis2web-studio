import L from "leaflet";

export const SCALE_BAR_SEGMENTS_MIN = 2;
export const SCALE_BAR_SEGMENTS_MAX = 6;
export const SCALE_BAR_SEGMENTS_DEFAULT = 4;
export const SCALE_BAR_WIDTH_PX = 150;

export type ScaleBarUnit = "auto" | "m" | "km";

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

// auto: km jika >= 1000 m, selain itu m. "km" / "m" memaksa satuan tersebut.
export function resolveScaleUnit(maxMeters: number, unit: ScaleBarUnit): "m" | "km" {
  return unit === "km" || (unit !== "m" && maxMeters >= 1000) ? "km" : "m";
}

// N segmen -> N+1 label (0 ... total). Jarak total = maxMeters dari Leaflet
// untuk lebar bar tetap; satu satuan untuk semua label. Harus sama dengan
// logika di generated app.js (lib.rs).
export function scaleTicksHtml(maxMeters: number, segments: number, unit: ScaleBarUnit): string {
  const n = clampScaleBarSegments(segments);
  const useKm = resolveScaleUnit(maxMeters, unit) === "km";
  const total = useKm ? maxMeters / 1000 : maxMeters;
  const step = total / n;
  const d = step >= 10 ? 0 : step >= 1 ? 1 : Math.min(4, Math.ceil(-Math.log10(step)) + 1);
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

const SWAP_ICON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>' +
  '<path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>';

// Scale control Leaflet dengan lebar bar tetap dan tombol ganti satuan (km <-> m).
// maxMeters tetap dihitung Leaflet.
const FixedWidthScale = L.Control.Scale.extend({
  onAdd(this: any, map: L.Map) {
    const container: HTMLElement = (L.Control.Scale.prototype as any).onAdd.call(this, map);
    const btn = L.DomUtil.create("button", "sb-unit-toggle", container) as HTMLButtonElement;
    btn.type = "button";
    btn.title = "Ganti satuan jarak (km / m)";
    btn.setAttribute("aria-label", "Ganti satuan jarak (km / m)");
    btn.innerHTML = SWAP_ICON_SVG;
    L.DomEvent.disableClickPropagation(btn);
    let turns = 0;
    L.DomEvent.on(btn, "click", (ev: Event) => {
      L.DomEvent.preventDefault(ev);
      this._forcedUnit = this._shownUnit === "km" ? "m" : "km";
      turns += 1;
      const icon = btn.firstElementChild as HTMLElement | null;
      if (icon) icon.style.transform = "rotate(" + turns * 180 + "deg)";
      this._update();
    });
    return container;
  },
  _updateMetric(this: any, maxMeters: number) {
    const unit: ScaleBarUnit = this._forcedUnit || "auto";
    this._shownUnit = resolveScaleUnit(maxMeters, unit);
    this._mScale.style.width = this.options.maxWidth + "px";
    this._mScale.innerHTML = scaleTicksHtml(maxMeters, this.options.segments, unit);
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
