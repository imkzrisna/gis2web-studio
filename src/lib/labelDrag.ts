import L from "leaflet";
import type { LabelPositions } from "./labelPositions";

export interface LabelDragCtx {
  getMap: () => L.Map | null;
  isEditing: () => boolean;
  getPositions: () => LabelPositions;
  setPositions: (p: LabelPositions) => void;
}

// Tarik label (tooltip) untuk memindahkannya. Posisi disimpan sebagai lat/lng,
// sehingga tetap pas di semua level zoom. Klik dua kali = kembali ke posisi otomatis.
export function attachLabelDrag(
  el: HTMLElement,
  tooltip: L.Tooltip,
  source: L.Layer,
  key: string,
  ctx: LabelDragCtx
) {
  let dragging = false;

  el.addEventListener("pointerdown", (ev) => {
    const map = ctx.getMap();
    if (!ctx.isEditing() || !map) return;
    ev.preventDefault();
    ev.stopPropagation();
    dragging = true;
    el.setPointerCapture(ev.pointerId);
    map.dragging.disable();
  });

  el.addEventListener("pointermove", (ev) => {
    const map = ctx.getMap();
    if (!dragging || !map) return;
    tooltip.setLatLng(map.mouseEventToLatLng(ev));
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
