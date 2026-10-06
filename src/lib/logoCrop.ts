export type LogoShape = "square" | "rounded" | "circle";

export interface LogoCrop {
  zoom: number;
  positionX: number; // -1..1, relatif terhadap rentang geser
  positionY: number; // -1..1
  shape: LogoShape;
}

export const DEFAULT_LOGO_CROP: LogoCrop = { zoom: 1, positionX: 0, positionY: 0, shape: "rounded" };

export function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

export function sanitizeLogoCrop(raw: unknown): LogoCrop {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown, lo: number, hi: number, d: number) =>
    typeof v === "number" && Number.isFinite(v) ? clamp(v, lo, hi) : d;
  const s = r.shape;
  const shape: LogoShape = s === "square" || s === "rounded" || s === "circle" ? s : DEFAULT_LOGO_CROP.shape;
  return {
    zoom: num(r.zoom, 1, 4, 1),
    positionX: num(r.positionX, -1, 1, 0),
    positionY: num(r.positionY, -1, 1, 0),
    shape,
  };
}

// Radius proporsional (persen) agar bentuk sama di semua ukuran, termasuk favicon.
export function shapeRadius(shape: LogoShape) {
  return shape === "circle" ? "50%" : shape === "rounded" ? "18%" : "0";
}

// Posisi dan ukuran foto asli di dalam area crop persegi `size`.
// Foto asli tidak diubah; hanya ditampilkan dengan ukuran/posisi ini.
export function logoLayout(natW: number, natH: number, size: number, crop: LogoCrop) {
  const base = Math.max(size / natW, size / natH) * crop.zoom;
  const w = natW * base;
  const h = natH * base;
  const maxX = Math.max(0, (w - size) / 2);
  const maxY = Math.max(0, (h - size) / 2);
  return {
    w,
    h,
    maxX,
    maxY,
    left: (size - w) / 2 + crop.positionX * maxX,
    top: (size - h) / 2 + crop.positionY * maxY,
    sourceSide: size / base, // sisi area crop dalam piksel foto asli
  };
}
