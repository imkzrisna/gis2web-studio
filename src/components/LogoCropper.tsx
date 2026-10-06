import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import LogoPreview from "./LogoPreview";
import { DEFAULT_LOGO_CROP, LogoCrop, LogoShape, clamp, logoLayout, shapeRadius } from "../lib/logoCrop";

const SHAPES: { value: LogoShape; label: string; icon: string }[] = [
  { value: "square", label: "Kotak", icon: "0" },
  { value: "rounded", label: "Rounded", icon: "5px" },
  { value: "circle", label: "Bulat", icon: "50%" },
];
const INSET_RATIO = 0.12;

interface LogoCropperProps {
  src: string;
  initialCrop: LogoCrop | null;
  onCancel: () => void;
  onConfirm: (crop: LogoCrop) => void;
}

export default function LogoCropper({ src, initialCrop, onCancel, onConfirm }: LogoCropperProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [stage, setStage] = useState(320);
  const [crop, setCrop] = useState<LogoCrop>(initialCrop ?? DEFAULT_LOGO_CROP);

  useEffect(() => {
    const img = new Image();
    img.onload = () => setNat({ w: img.naturalWidth, h: img.naturalHeight });
    img.src = src;
  }, [src]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const update = () => setStage(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const inset = Math.round(stage * INSET_RATIO);
  const win = Math.max(1, stage - inset * 2);
  const layout = nat ? logoLayout(nat.w, nat.h, win, crop) : null;
  const setZoom = (z: number) => setCrop((c) => ({ ...c, zoom: clamp(Math.round(z * 100) / 100, 1, 4) }));

  function onPointerMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d || !layout) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    dragRef.current = { x: e.clientX, y: e.clientY };
    setCrop((c) => ({
      ...c,
      positionX: layout.maxX > 0 ? clamp(c.positionX + dx / layout.maxX, -1, 1) : 0,
      positionY: layout.maxY > 0 ? clamp(c.positionY + dy / layout.maxY, -1, 1) : 0,
    }));
  }

  return createPortal(
    <div className="lc-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="lc-modal" role="dialog" aria-label="Potong Logo">
        <div className="lc-head">
          <div>
            <h4>Potong Logo</h4>
            <p>Geser foto, scroll untuk zoom.</p>
          </div>
          <button type="button" className="lc-link" onClick={() => setCrop(DEFAULT_LOGO_CROP)}>
            Reset
          </button>
        </div>

        <div
          ref={stageRef}
          className="lc-stage"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            dragRef.current = { x: e.clientX, y: e.clientY };
          }}
          onPointerMove={onPointerMove}
          onPointerUp={() => {
            dragRef.current = null;
          }}
          onWheel={(e) => setZoom(crop.zoom - e.deltaY * 0.004)}
        >
          {layout && (
            <>
              <img
                src={src}
                alt=""
                draggable={false}
                style={{ width: layout.w, height: layout.h, left: layout.left + inset, top: layout.top + inset }}
              />
              <div
                className="lc-window"
                style={{ left: inset, top: inset, width: win, height: win, borderRadius: shapeRadius(crop.shape) }}
              />
            </>
          )}
        </div>

        <div className="lc-row">
          <button type="button" className="lc-icon" aria-label="Perkecil" onClick={() => setZoom(crop.zoom - 0.2)}>
            −
          </button>
          <input
            type="range"
            min={1}
            max={4}
            step={0.05}
            value={crop.zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
          />
          <button type="button" className="lc-icon" aria-label="Perbesar" onClick={() => setZoom(crop.zoom + 0.2)}>
            +
          </button>
          <span className="lc-zoom">{crop.zoom.toFixed(1)}x</span>
        </div>

        <div className="lc-shapes" role="group" aria-label="Bentuk crop">
          {SHAPES.map((s) => (
            <button
              key={s.value}
              type="button"
              className={crop.shape === s.value ? "on" : ""}
              onClick={() => setCrop((c) => ({ ...c, shape: s.value }))}
            >
              <span className="lc-swatch" style={{ borderRadius: s.icon }} />
              {s.label}
            </button>
          ))}
        </div>

        <p className="lc-meta">
          {nat
            ? `Foto asli ${nat.w} × ${nat.h} px, tidak diubah. Area crop ± ${Math.round(layout?.sourceSide ?? 0)} px.`
            : "Memuat foto..."}
        </p>

        <div className="lc-foot">
          <div className="lc-preview">
            <LogoPreview src={src} crop={crop} size={36} />
            <span>Tampilan tab</span>
          </div>
          <div className="lc-actions">
            <button type="button" className="lc-secondary" onClick={onCancel}>
              Batal
            </button>
            <button type="button" className="lc-primary" disabled={!nat} onClick={() => onConfirm(crop)}>
              Gunakan
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
