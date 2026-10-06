import { useEffect, useRef, useState } from "react";

type Shape = "square" | "rounded" | "circle";

const VIEW = 320;
const MAX_OUT = 2048;
const PREVIEW_SIZES = [64, 32, 16];

const SHAPES: { value: Shape; label: string }[] = [
  { value: "square", label: "Kotak" },
  { value: "rounded", label: "Rounded" },
  { value: "circle", label: "Bulat" },
];

interface LogoCropperProps {
  src: string;
  onCancel: () => void;
  onConfirm: (dataUrl: string) => void;
}

function shapePath(ctx: CanvasRenderingContext2D, shape: Shape, size: number) {
  ctx.beginPath();
  if (shape === "circle") {
    ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  } else if (shape === "rounded") {
    const r = size * 0.22;
    ctx.moveTo(r, 0);
    ctx.arcTo(size, 0, size, size, r);
    ctx.arcTo(size, size, 0, size, r);
    ctx.arcTo(0, size, 0, 0, r);
    ctx.arcTo(0, 0, size, 0, r);
    ctx.closePath();
  } else {
    ctx.rect(0, 0, size, size);
  }
}

export default function LogoCropper({ src, onCancel, onConfirm }: LogoCropperProps) {
  const stageRef = useRef<HTMLCanvasElement>(null);
  const previewRefs = useRef<(HTMLCanvasElement | null)[]>([]);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [shape, setShape] = useState<Shape>("rounded");
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      setLoaded(true);
    };
    img.src = src;
  }, [src]);

  function baseScale(z: number) {
    const img = imgRef.current;
    if (!img) return 1;
    return Math.max(VIEW / img.width, VIEW / img.height) * z;
  }

  function clampOffset(o: { x: number; y: number }, z: number) {
    const img = imgRef.current;
    if (!img) return o;
    const b = baseScale(z);
    const maxX = Math.max(0, (img.width * b - VIEW) / 2);
    const maxY = Math.max(0, (img.height * b - VIEW) / 2);
    return {
      x: Math.min(maxX, Math.max(-maxX, o.x)),
      y: Math.min(maxY, Math.max(-maxY, o.y)),
    };
  }

  // Sisi area crop dalam piksel foto asli (menentukan resolusi hasil).
  function sourceSide() {
    return VIEW / baseScale(zoom);
  }

  function outputSize() {
    return Math.max(64, Math.min(MAX_OUT, Math.round(sourceSide())));
  }

  function draw(canvas: HTMLCanvasElement, size: number, guide = false) {
    const img = imgRef.current;
    const ctx = canvas.getContext("2d");
    if (!img || !ctx) return;
    const k = size / VIEW;
    const o = clampOffset(offset, zoom);
    const b = baseScale(zoom);
    const w = img.width * b * k;
    const h = img.height * b * k;
    const x = ((VIEW - img.width * b) / 2 + o.x) * k;
    const y = ((VIEW - img.height * b) / 2 + o.y) * k;
    ctx.clearRect(0, 0, size, size);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    if (guide) {
      ctx.save();
      ctx.globalAlpha = 0.3;
      ctx.drawImage(img, x, y, w, h);
      ctx.restore();
    }
    ctx.save();
    shapePath(ctx, shape, size);
    ctx.clip();
    ctx.drawImage(img, x, y, w, h);
    ctx.restore();
    if (guide) {
      shapePath(ctx, shape, size);
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(37, 99, 235, 0.9)";
      ctx.stroke();
    }
  }

  useEffect(() => {
    if (!loaded) return;
    if (stageRef.current) draw(stageRef.current, VIEW, true);
    PREVIEW_SIZES.forEach((s, i) => {
      const c = previewRefs.current[i];
      if (c) draw(c, s * 2);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, shape, zoom, offset]);

  function handleConfirm() {
    const size = outputSize();
    const out = document.createElement("canvas");
    out.width = size;
    out.height = size;
    draw(out, size);
    onConfirm(out.toDataURL("image/png"));
  }

  function handleReset() {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
    setShape("rounded");
  }

  const img = imgRef.current;

  return (
    <div className="logo-cropper-backdrop">
      <div className="logo-cropper">
        <div className="logo-cropper-head">
          <h4>Potong Logo</h4>
          <button type="button" className="logo-cropper-reset" onClick={handleReset}>
            Reset
          </button>
        </div>

        <div className="logo-cropper-stage">
          <canvas
            ref={stageRef}
            width={VIEW}
            height={VIEW}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              dragRef.current = { x: e.clientX, y: e.clientY };
            }}
            onPointerMove={(e) => {
              const d = dragRef.current;
              if (!d) return;
              const dx = e.clientX - d.x;
              const dy = e.clientY - d.y;
              dragRef.current = { x: e.clientX, y: e.clientY };
              setOffset((prev) => clampOffset({ x: prev.x + dx, y: prev.y + dy }, zoom));
            }}
            onPointerUp={() => {
              dragRef.current = null;
            }}
          />
        </div>

        <div className="logo-cropper-segmented" role="group" aria-label="Bentuk logo">
          {SHAPES.map((s) => (
            <button
              key={s.value}
              type="button"
              className={shape === s.value ? "active" : ""}
              onClick={() => setShape(s.value)}
            >
              {s.label}
            </button>
          ))}
        </div>

        <label className="logo-cropper-zoom">
          <span>Zoom</span>
          <input
            type="range"
            min={1}
            max={4}
            step={0.02}
            value={zoom}
            onChange={(e) => {
              const z = Number(e.target.value);
              setZoom(z);
              setOffset((prev) => clampOffset(prev, z));
            }}
          />
          <span className="logo-cropper-zoom-value">{zoom.toFixed(1)}x</span>
        </label>

        <div className="logo-cropper-preview">
          <div className="logo-cropper-preview-icons">
            {PREVIEW_SIZES.map((s, i) => (
              <canvas
                key={s}
                ref={(el) => {
                  previewRefs.current[i] = el;
                }}
                width={s * 2}
                height={s * 2}
                style={{ width: s, height: s }}
              />
            ))}
          </div>
          <div className="logo-cropper-preview-info">
            <span>Hasil: {loaded ? `${outputSize()} × ${outputSize()} px` : "-"}</span>
            <span className="logo-cropper-hint">
              {img ? `Foto asli ${img.width} × ${img.height} px, resolusi dipertahankan.` : "Memuat foto..."}
            </span>
          </div>
        </div>

        <p className="logo-cropper-hint">Geser foto untuk mengatur posisi. Area di luar bentuk transparan.</p>

        <div className="logo-cropper-actions">
          <button type="button" onClick={onCancel}>Batal</button>
          <button type="button" className="primary" onClick={handleConfirm} disabled={!loaded}>
            Gunakan
          </button>
        </div>
      </div>
    </div>
  );
}
