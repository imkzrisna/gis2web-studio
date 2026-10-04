export type PointSizeUnit = "mm" | "pt" | "px";

export const POINT_SIZE_UNITS: { value: PointSizeUnit; label: string }[] = [
  { value: "mm", label: "Millimeters" },
  { value: "pt", label: "Points" },
  { value: "px", label: "Pixels" },
];

const PX_PER_MM = 96 / 25.4;
const PX_PER_PT = 96 / 72;

export const POINT_RADIUS_MIN_PX = 1;
export const POINT_RADIUS_MAX_PX = 30;

// Ukuran (diameter) dalam satuan tertentu -> radius circleMarker (px).
export function sizeToRadiusPx(size: number, unit: PointSizeUnit): number {
  const diameterPx = unit === "mm" ? size * PX_PER_MM : unit === "pt" ? size * PX_PER_PT : size;
  const radius = diameterPx / 2;
  return Math.min(POINT_RADIUS_MAX_PX, Math.max(POINT_RADIUS_MIN_PX, radius));
}

// Radius (px) -> ukuran (diameter) dalam satuan tertentu, untuk ditampilkan.
export function radiusPxToSize(radiusPx: number, unit: PointSizeUnit): number {
  const diameterPx = radiusPx * 2;
  const value = unit === "mm" ? diameterPx / PX_PER_MM : unit === "pt" ? diameterPx / PX_PER_PT : diameterPx;
  return Math.round(value * 100) / 100;
}
