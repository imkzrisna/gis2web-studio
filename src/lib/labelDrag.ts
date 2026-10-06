import L from "leaflet";
import type { LabelPositions } from "./labelPositions";

export interface LabelDragCtx {
  getMap: () => L.Map | null;
  isEditing: () => boolean;
  getPositions: () => LabelPositions;
  setPositions: (p: LabelPositions) => void;
}

type Ring = number[][];

function inRing(lng: number, lat: number, ring: Ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inPolygon(lng: number, lat: number, rings: Ring[]) {
  if (rings.length === 0 || !inRing(lng, lat, rings[0])) return false;
  for (let k = 1; k < rings.length; k++) if (inRing(lng, lat, rings[k])) return false; // hole
  return true;
}

// Polygon/MultiPolygon: titik harus di dalam area. Geometri lain: tanpa batas.
export function isLabelPositionAllowed(geometry: GeoJSON.Geometry | null | undefined, lat: number, lng: number) {
  if (!geometry) return true;
  if (geometry.type === "Polygon") return inPolygon(lng, lat, geometry.coordinates as Ring[]);
  if (geometry.type === "MultiPolygon") {
    return (geometry.coordinates as Ring[][]).some((poly) => inPolygon(lng, lat, poly));
  }
  return true;
}

// Tarik label (tooltip) untuk memindahkannya, dibatasi di dalam polygon asalnya.
// Posisi disimpan sebagai lat/lng. Klik dua kali = kembali ke posisi otomatis.
export function attachLabelDrag(
  el: HTMLElement,
  tooltip: L.Tooltip,
  source: L.Layer,
  key: string,
  ctx: LabelDragCtx,
  geometry?: GeoJSON.Geometry | null
) {
  let dragging = false;
  let last: L.LatLng | null = null;

  el.addEventListener("pointerdown", (ev) => {
    const map = ctx.getMap();
    if (!ctx.isEditing() || !map) return;
    ev.preventDefault();
    ev.stopPropagation();
    dragging = true;
    last = tooltip.getLatLng() ?? null;
    el.setPointerCapture(ev.pointerId);
    map.dragging.disable();
  });

  el.addEventListener("pointermove", (ev) => {
    const map = ctx.getMap();
    if (!dragging || !map || !last) return;
    const target = map.mouseEventToLatLng(ev);
    if (isLabelPositionAllowed(geometry, target.lat, target.lng)) {
      last = target;
    } else {
      // Geser sejauh mungkin ke arah mouse sampai tepi polygon.
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 10; i++) {
        const mid = (lo + hi) / 2;
        const lat = last.lat + (target.lat - last.lat) * mid;
        const lng = last.lng + (target.lng - last.lng) * mid;
        if (isLabelPositionAllowed(geometry, lat, lng)) lo = mid;
        else hi = mid;
      }
      last = L.latLng(last.lat + (target.lat - last.lat) * lo, last.lng + (target.lng - last.lng) * lo);
    }
    tooltip.setLatLng(last);
  });

  const end = () => {
    if (!dragging) return;
    dragging = false;
    ctx.getMap()?.dragging.enable();
    const ll = tooltip.getLatLng();
    if (ll) ctx.setPositions({ ...ctx.getPositions(), [key]: [ll.lat, ll.lng] });
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);

  el.addEventListener("click", (ev) => {
    if (ctx.isEditing()) ev.stopPropagation();
  });

  el.addEventListener("dblclick", (ev) => {
    if (!ctx.isEditing()) return;
    ev.stopPropagation();
    const src = source as L.Layer & { getCenter?: () => L.LatLng; getLatLng?: () => L.LatLng };
    const def = src.getCenter ? src.getCenter() : src.getLatLng?.();
    if (def) tooltip.setLatLng(def);
    const next = { ...ctx.getPositions() };
    delete next[key];
    ctx.setPositions(next);
  });
}
