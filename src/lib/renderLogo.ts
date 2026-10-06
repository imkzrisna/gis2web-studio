import { LogoCrop, logoLayout } from "./logoCrop";

const MIN_OUT = 64;
const MAX_OUT = 1024;

// Render favicon dari foto asli + crop config. Foto asli tidak diubah.
// Ukuran output = ukuran area crop di foto asli (tanpa upscale), dibatasi MIN..MAX.
export async function renderLogoPng(src: string, crop: LogoCrop): Promise<Uint8Array | null> {
  try {
    const res = await fetch(src);
    if (!res.ok) return null;
    const url = URL.createObjectURL(await res.blob());
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error("decode"));
        i.src = url;
      });
      const natW = img.naturalWidth || 512;
      const natH = img.naturalHeight || 512;
      const side = Math.min(natW, natH) / crop.zoom;
      const size = Math.max(MIN_OUT, Math.min(MAX_OUT, Math.round(side)));
      const l = logoLayout(natW, natH, size, crop);

      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";

      ctx.beginPath();
      if (crop.shape === "circle") {
        ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
      } else if (crop.shape === "rounded") {
        const r = size * 0.18;
        ctx.moveTo(r, 0);
        ctx.arcTo(size, 0, size, size, r);
        ctx.arcTo(size, size, 0, size, r);
        ctx.arcTo(0, size, 0, 0, r);
        ctx.arcTo(0, 0, size, 0, r);
        ctx.closePath();
      } else {
        ctx.rect(0, 0, size, size);
      }
      ctx.clip();
      ctx.drawImage(img, l.left, l.top, l.w, l.h);

      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
      return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch (err) {
    console.error("Gagal merender logo, memakai foto asli:", err);
    return null;
  }
}
