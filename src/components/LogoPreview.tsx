import { useState } from "react";
import { LogoCrop, logoLayout, shapeRadius } from "../lib/logoCrop";

interface LogoPreviewProps {
  src: string;
  crop: LogoCrop;
  size: number;
}

export default function LogoPreview({ src, crop, size }: LogoPreviewProps) {
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const l = nat ? logoLayout(nat.w, nat.h, size, crop) : null;
  return (
    <span
      className="logo-preview"
      style={{ width: size, height: size, borderRadius: shapeRadius(crop.shape) }}
    >
      <img
        src={src}
        alt=""
        draggable={false}
        onLoad={(e) => setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
        style={l ? { width: l.w, height: l.h, left: l.left, top: l.top } : { visibility: "hidden" }}
      />
    </span>
  );
}
