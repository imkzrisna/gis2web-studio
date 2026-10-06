import { useState } from "react";
import type { LayerInfo } from "./ProjectPanel";

interface ExportPreviewLegendProps {
  layers: LayerInfo[];
  indexes: number[];
  boundaryLayerIndex: number | null;
  layerColors: Record<number, string>;
  layerCategoryColors: Record<number, Record<string, string>>;
  layerOpacities: Record<number, number>;
}

function legendKind(geometryType: string | null | undefined) {
  const g = String(geometryType ?? "").toLowerCase();
  if (g.includes("point")) return "point";
  if (g.includes("line")) return "line";
  return "area";
}

function legendFill(color: string, opacity: number) {
  const m = /^#?([0-9a-f]{6})$/i.exec(color || "");
  if (!m) return color;
  const n = parseInt(m[1], 16);
  const a = Math.max(0.35, opacity);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function Swatch({ kind, color, opacity }: { kind: string; color: string; opacity: number }) {
  const style: React.CSSProperties =
    kind === "boundary"
      ? { borderColor: color }
      : kind === "line"
        ? { background: color }
        : { background: legendFill(color, opacity), borderColor: color };
  return <i className={`legend-swatch legend-swatch--${kind}`} style={style} />;
}

export default function ExportPreviewLegend({
  layers,
  indexes,
  boundaryLayerIndex,
  layerColors,
  layerCategoryColors,
  layerOpacities,
}: ExportPreviewLegendProps) {
  const [collapsed, setCollapsed] = useState(false);
  const items = indexes.filter((i) => layers[i]);
  if (items.length === 0) return null;

  return (
    <div className="export-preview-legend">
      <div className="export-preview-legend-header">
        <span>Layer</span>
        <button type="button" onClick={() => setCollapsed((v) => !v)} aria-label="Lipat legenda">
          {collapsed ? "\u25B2" : "\u25BC"}
        </button>
      </div>
      {!collapsed && (
        <div className="export-preview-legend-list">
          {items.map((index) => {
            const layer = layers[index];
            const isBoundary = index === boundaryLayerIndex;
            const color = layerColors[index] ?? (isBoundary ? "#f97316" : "#2563eb");
            const opacity = layerOpacities[index] ?? 0.35;
            const overrides = layerCategoryColors[index];
            const kind = isBoundary ? "boundary" : legendKind(layer.geometry_type);

            let entries: { label: string; color: string }[] | null = null;
            if (!isBoundary && layer.category_field && layer.categories && layer.categories.length > 0) {
              entries = layer.categories.map((c) => ({
                label: c.value === "NULL" ? "(kosong)" : c.value,
                color: overrides?.[c.value] ?? c.color,
              }));
            } else if (!isBoundary && layer.category_field && layer.ranges && layer.ranges.length > 0) {
              entries = layer.ranges.map((r) => ({ label: r.label, color: overrides?.[r.label] ?? r.color }));
            }

            return (
              <div key={index} className="export-preview-legend-group">
                <div className="export-preview-legend-layer">
                  {!entries && <Swatch kind={kind} color={color} opacity={opacity} />}
                  <span>
                    {layer.name}
                    {isBoundary ? " (Boundary)" : ""}
                  </span>
                </div>
                {entries && (
                  <div className="legend-entries">
                    {entries.map((en) => (
                      <div key={en.label} className="legend-entry">
                        <Swatch kind={kind} color={en.color} opacity={opacity} />
                        <span>{en.label}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
