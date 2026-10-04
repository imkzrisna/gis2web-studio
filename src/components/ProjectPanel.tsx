import { useRef, useState } from "react";
import LayerPreview from "./LayerPreview";

export interface CategoryInfo {
  value: string;
  label: string;
  color: string;
}

export interface GraduatedRangeInfo {
  lower: number;
  upper: number;
  label: string;
  color: string;
}

export interface LabelingInfo {
  field: string;
  group_by_field: string | null;
}

export interface LayerInfo {
  name: string;
  geometry_type: "Point" | "Line" | "Polygon" | "NoGeometry" | "Unknown";
  datasource: string;
  color: string | null;
  category_field: string | null;
  categories: CategoryInfo[] | null;
  ranges: GraduatedRangeInfo[] | null;
  labeling: LabelingInfo | null;
}

interface ProjectPanelProps {
  projectPath: string | null;
  layers: LayerInfo[];
  hasProject: boolean;
  isImporting: boolean;
  importingLabel?: string;
  selectedLayerIndexes: number[];
  onSelectedLayerIndexesChange: (indexes: number[]) => void;
  boundaryLayerIndex: number | null;
  labelFontSize?: number;
  onBoundaryLayerIndexChange: (index: number | null) => void;
  layerColors: Record<number, string>;
  onLayerColorChange: (index: number, color: string) => void;
  layerCategoryColors: Record<number, Record<string, string>>;
  onLayerCategoryColorChange: (index: number, categoryValue: string, color: string) => void;
  layerOpacities: Record<number, number>;
  onLayerOpacityChange: (index: number, opacity: number) => void;
  layerPointSizes: Record<number, number>;
  onLayerPointSizeChange: (index: number, size: number) => void;
  layerAttributeTableEnabled: Record<number, boolean>;
  onAttributeTableToggle: (index: number, enabled: boolean) => void;
  layerOrder: number[];
  onLayerOrderChange: (order: number[]) => void;
  activeLayerIndex: number | null;
  onFocusLayer: (index: number) => void;
}

type PanelTab = "layers" | "order";

function ProjectPanel({
  projectPath,
  layers,
  hasProject,
  isImporting,
  importingLabel,
  selectedLayerIndexes,
  onSelectedLayerIndexesChange,
  boundaryLayerIndex,
  onBoundaryLayerIndexChange,
  labelFontSize,
  layerColors,
  onLayerColorChange,
  layerCategoryColors,
  onLayerCategoryColorChange,
  layerOpacities,
  onLayerOpacityChange,
  layerPointSizes,
  onLayerPointSizeChange,
  layerAttributeTableEnabled,
  onAttributeTableToggle,
  layerOrder,
  onLayerOrderChange,
  activeLayerIndex,
  onFocusLayer,
}: ProjectPanelProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [panelTab, setPanelTab] = useState<PanelTab>("layers");
  const [layerFlowStep, setLayerFlowStep] = useState<"select" | "manage">("select");
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  // Index terakhir yang pernah di-hover, dipakai supaya LayerPreview tetap
  // mounted (map Leaflet tidak dibuat ulang) walau hover sedang tidak aktif;
  // visibilitasnya diatur lewat CSS (prop `visible`), bukan unmount/mount.
  const [lastPreviewIndex, setLastPreviewIndex] = useState<number | null>(null);
  const [expandedLayerIndex, setExpandedLayerIndex] = useState<number | null>(null);
  const hoverTimeoutRef = useRef<number | null>(null);

  function toggleLayerSelected(index: number) {
    if (selectedLayerIndexes.includes(index)) {
      onSelectedLayerIndexesChange(
        selectedLayerIndexes.filter((i) => i !== index)
      );
    } else {
      onSelectedLayerIndexesChange([...selectedLayerIndexes, index]);
    }
  }

  // Preview mini-map ditampilkan di posisi tetap (pojok kanan atas area peta)
  // supaya tidak pernah terpotong oleh tepi layar, apa pun baris yang di-hover.
  function scheduleShowPreview(index: number) {
    if (hoverTimeoutRef.current) window.clearTimeout(hoverTimeoutRef.current);
    hoverTimeoutRef.current = window.setTimeout(() => {
      setPreviewIndex(index);
      setLastPreviewIndex(index);
    }, 300);
  }

  function cancelPreview() {
    if (hoverTimeoutRef.current) window.clearTimeout(hoverTimeoutRef.current);
    hoverTimeoutRef.current = null;
    setPreviewIndex(null);
  }

  function handleDragStart(pos: number) {
    setDragIndex(pos);
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
  }

  function handleDrop(pos: number) {
    if (dragIndex === null || dragIndex === pos) {
      setDragIndex(null);
      return;
    }
    const newOrder = [...layerOrder];
    const [moved] = newOrder.splice(dragIndex, 1);
    newOrder.splice(pos, 0, moved);
    onLayerOrderChange(newOrder);
    setDragIndex(null);
  }

  return (
    <div className={"layer-overlay-panel" + (collapsed ? " collapsed" : " expanded")}>
      {collapsed ? (
        <button
          type="button"
          className="layer-overlay-toggle-btn layer-overlay-toggle-btn--collapsed"
          onClick={() => setCollapsed(false)}
          title="Buka panel layer"
        >
          {"\u2630"}
        </button>
      ) : (
        <div className="layer-overlay-header">
          <span className="layer-overlay-title">
            <span className="layer-overlay-title-icon">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="7" rx="1.2" />
                <rect x="14" y="3" width="7" height="7" rx="1.2" />
                <rect x="3" y="14" width="7" height="7" rx="1.2" />
                <rect x="14" y="14" width="7" height="7" rx="1.2" />
              </svg>
            </span>
            Layers
          </span>
          <button
            type="button"
            className="layer-overlay-toggle-btn"
            onClick={() => setCollapsed(true)}
            title="Tutup panel layer"
          >
            {"\u2715"}
          </button>
        </div>
      )}

      {!collapsed && (
        <div className="layer-overlay-body">
          <div className="project-panel">
            {isImporting && (
              <div className="project-empty-state">
                <p className="project-empty-title">{importingLabel || "Memuat layer..."}</p>
                <p className="project-empty-text">
                  Sedang menyiapkan data layer dari project QGIS. Mohon tunggu
                  sebentar.
                </p>
              </div>
            )}

            {!isImporting && !hasProject && (
              <div className="project-empty-state">
                <div className="project-empty-icon">
                  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
                  </svg>
                </div>
                <p className="project-empty-title">Belum ada project</p>
                <p className="project-empty-text">
                  Klik "Import Project" di toolbar atas untuk mulai memilih
                  layer yang ingin dipublikasikan ke Web GIS.
                </p>
              </div>
            )}

            {!isImporting && layers.length > 0 && (
              <div className="layer-list">
                <div className="project-panel-tabs">
                  <button
                    type="button"
                    className={"project-panel-tab-btn" + (panelTab === "layers" ? " active" : "")}
                    onClick={() => setPanelTab("layers")}
                  >
                    Layers
                  </button>
                  <button
                    type="button"
                    className={"project-panel-tab-btn" + (panelTab === "order" ? " active" : "")}
                    onClick={() => setPanelTab("order")}
                  >
                    Urutan
                  </button>
                </div>

                {panelTab === "layers" && layerFlowStep === "select" && (
                  <>
                    <h3>Pilih Layer ({layers.length})</h3>
                    <p className="order-hint">
                      Centang layer yang ingin dipublikasikan, lalu tandai salah satu
                      sebagai Boundary Layer (khusus layer polygon).
                    </p>
                    <table className="layer-table layer-table--select">
                      <thead>
                        <tr>
                          <th>Publikasikan</th>
                          <th>Boundary</th>
                          <th>Nama Layer</th>
                          <th>Tipe Geometri</th>
                        </tr>
                      </thead>
                      <tbody>
                        {layers.map((layer, index) => {
                          const isPolygon = layer.geometry_type === "Polygon";
                          const isActive = activeLayerIndex === index;
                          return (
                            <tr
                              key={index}
                              className={isActive ? "active-row" : undefined}
                              onClick={() => onFocusLayer(index)}
                              onMouseEnter={() => scheduleShowPreview(index)}
                              onMouseLeave={cancelPreview}
                            >
                              <td onClick={(e) => e.stopPropagation()}>
                                <input
                                  type="checkbox"
                                  checked={selectedLayerIndexes.includes(index)}
                                  onChange={() => toggleLayerSelected(index)}
                                />
                              </td>
                              <td onClick={(e) => e.stopPropagation()}>
                                <input
                                  type="radio"
                                  name="boundary-layer"
                                  disabled={!isPolygon}
                                  checked={boundaryLayerIndex === index}
                                  onChange={() => onBoundaryLayerIndexChange(index)}
                                  title={
                                    isPolygon
                                      ? "Jadikan Boundary Layer"
                                      : "Hanya layer polygon yang bisa dijadikan Boundary Layer"
                                  }
                                />
                              </td>
                              <td>{layer.name}</td>
                              <td>
                                {layer.geometry_type}
                                {!isPolygon && (
                                  <span className="layer-note"> (bukan polygon)</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>

                    <div className="layer-summary">
                      <p>Layer dipilih untuk dipublikasikan: {selectedLayerIndexes.length}</p>
                      <p>
                        Boundary Layer:{" "}
                        {boundaryLayerIndex !== null
                          ? layers[boundaryLayerIndex].name
                          : "(belum dipilih)"}
                      </p>
                    </div>

                    <button
                      type="button"
                      className="layer-flow-next-btn"
                      disabled={selectedLayerIndexes.length === 0}
                      onClick={() => setLayerFlowStep("manage")}
                    >
                      Lanjut atur tampilan layer
                    </button>
                  </>
                )}

                {panelTab === "layers" && layerFlowStep === "manage" && (
                  <>
                    <button
                      type="button"
                      className="layer-flow-back-btn"
                      onClick={() => setLayerFlowStep("select")}
                    >
                      {"\u2190"} Kembali pilih layer
                    </button>
                    <h3>Atur Layer Terpilih ({selectedLayerIndexes.length})</h3>
                    <table className="layer-table">
                      <thead>
                        <tr>
                          <th>Nama Layer</th>
                          <th>Warna</th>
                          <th>Opacity</th>
                          <th>Ukuran Point</th>
                          <th>Attribute Table</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedLayerIndexes.map((index) => {
                          const layer = layers[index];
                          if (!layer) return null;
                          const isPolygon = layer.geometry_type === "Polygon";
                          const isPointLayer = layer.geometry_type === "Point";
                          const color = layerColors[index] ?? "#2563eb";
                          const opacity = layerOpacities[index] ?? (isPolygon ? 0.35 : 0.7);
                          const pointSize = layerPointSizes[index] ?? 5;
                          const isActive = activeLayerIndex === index;
                          const isBoundary = boundaryLayerIndex === index;
                          return (
                            <tr
                              key={index}
                              className={isActive ? "active-row" : undefined}
                              onClick={() => onFocusLayer(index)}
                              onMouseEnter={() => scheduleShowPreview(index)}
                              onMouseLeave={cancelPreview}
                            >
                              <td>
                                {layer.name}
                                {isBoundary && (
                                  <span className="layer-note layer-note--boundary"> (Boundary)</span>
                                )}
                              </td>
                              <td onClick={(e) => e.stopPropagation()}>
                                {layer.categories && layer.categories.length > 0 ? (
                                  <button
                                    type="button"
                                    className="category-expand-button"
                                    onClick={() =>
                                      setExpandedLayerIndex(
                                        expandedLayerIndex === index ? null : index
                                      )
                                    }
                                    title="Lihat warna per kategori"
                                  >
                                    {layer.categories.length} kategori{" "}
                                    {expandedLayerIndex === index ? "\u25B2" : "\u25BC"}
                                  </button>
                                ) : layer.ranges && layer.ranges.length > 0 ? (
                                  <button
                                    type="button"
                                    className="category-expand-button"
                                    onClick={() =>
                                      setExpandedLayerIndex(
                                        expandedLayerIndex === index ? null : index
                                      )
                                    }
                                    title="Lihat warna per rentang"
                                  >
                                    {layer.ranges.length} rentang{" "}
                                    {expandedLayerIndex === index ? "\u25B2" : "\u25BC"}
                                  </button>
                                ) : (
                                  <input
                                    type="color"
                                    value={color}
                                    onChange={(e) => onLayerColorChange(index, e.target.value)}
                                    title="Pilih warna layer"
                                  />
                                )}
                              </td>
                              <td onClick={(e) => e.stopPropagation()} className="opacity-cell">
                                <input
                                  type="range"
                                  min={0}
                                  max={1}
                                  step={0.05}
                                  value={opacity}
                                  onChange={(e) =>
                                    onLayerOpacityChange(index, Number(e.target.value))
                                  }
                                  title="Atur opacity layer"
                                />
                                <span className="opacity-value">
                                  {Math.round(opacity * 100)}%
                                </span>
                              </td>
                              <td onClick={(e) => e.stopPropagation()} className="opacity-cell">
                                {isPointLayer ? (
                                  <>
                                    <input
                                      type="range"
                                      min={2}
                                      max={20}
                                      step={1}
                                      value={pointSize}
                                      onChange={(e) =>
                                        onLayerPointSizeChange(index, Number(e.target.value))
                                      }
                                      title="Atur ukuran point layer"
                                    />
                                    <span className="opacity-value">{pointSize}px</span>
                                  </>
                                ) : (
                                  <span className="layer-note">-</span>
                                )}
                              </td>
                              <td onClick={(e) => e.stopPropagation()}>
                                <label className="attribute-table-toggle">
                                  <input
                                    type="checkbox"
                                    checked={layerAttributeTableEnabled[index] ?? false}
                                    onChange={(e) =>
                                      onAttributeTableToggle(index, e.target.checked)
                                    }
                                    title="Tampilkan Attribute Table untuk layer ini"
                                  />
                                  <span className="attribute-table-toggle-label">Tampilkan</span>
                                </label>
                              </td>
                            </tr>
                          );
                        })}
                        {selectedLayerIndexes.map((index) => {
                          const layer = layers[index];
                          if (
                            !layer ||
                            expandedLayerIndex !== index ||
                            !layer.categories ||
                            layer.categories.length === 0
                          ) {
                            return null;
                          }
                          const categoryColorMap = layerCategoryColors[index] ?? {};
                          return (
                            <tr key={`categories-${index}`} className="category-subrow">
                              <td colSpan={4} onClick={(e) => e.stopPropagation()}>
                                <div className="category-subrow-inner">
                                  <span className="category-subrow-title">
                                    Warna per kategori{layer.category_field ? ` (${layer.category_field})` : ""}:
                                  </span>
                                  <div className="category-list">
                                    {layer.categories.map((cat) => {
                                      const catColor = categoryColorMap[cat.value] ?? cat.color;
                                      return (
                                        <div className="category-item" key={cat.value}>
                                          <input
                                            type="color"
                                            value={catColor}
                                            onChange={(e) =>
                                              onLayerCategoryColorChange(
                                                index,
                                                cat.value,
                                                e.target.value
                                              )
                                            }
                                            title={`Warna untuk ${cat.label}`}
                                          />
                                          <span className="category-item-label">{cat.label}</span>
                                        </div>
                                      );
                                    })}
                                  </div>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                        {selectedLayerIndexes.map((index) => {
                          const layer = layers[index];
                          if (
                            !layer ||
                            expandedLayerIndex !== index ||
                            !layer.ranges ||
                            layer.ranges.length === 0
                          ) {
                            return null;
                          }
                          const rangeColorMap = layerCategoryColors[index] ?? {};
                          return (
                            <tr key={`ranges-${index}`} className="category-subrow">
                              <td colSpan={4} onClick={(e) => e.stopPropagation()}>
                                <div className="category-subrow-inner">
                                  <span className="category-subrow-title">
                                    Warna per rentang{layer.category_field ? ` (${layer.category_field})` : ""}:
                                  </span>
                                  <div className="category-list">
                                    {layer.ranges.map((range) => {
                                      const rangeColor = rangeColorMap[range.label] ?? range.color;
                                      return (
                                        <div className="category-item" key={range.label}>
                                          <input
                                            type="color"
                                            value={rangeColor}
                                            onChange={(e) =>
                                              onLayerCategoryColorChange(
                                                index,
                                                range.label,
                                                e.target.value
                                              )
                                            }
                                            title={`Warna untuk ${range.label} (${range.lower} - ${range.upper})`}
                                          />
                                          <span className="category-item-label">
                                            {range.label} ({range.lower} - {range.upper})
                                          </span>
                                        </div>
                                      );
                                    })}
                                  </div>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </>
                )}

                {panelTab === "order" && (
                  <>
                    <h3>Urutan Tumpukan Layer</h3>
                    <p className="order-hint">
                      Tarik untuk mengatur layer mana yang tampil paling depan (atas)
                      atau paling belakang (bawah) di peta.
                    </p>
                    <div className="order-list">
                      {layerOrder
                        .map((layerIdx, pos) => ({ layerIdx, pos }))
                        .filter(
                          ({ layerIdx }) =>
                            selectedLayerIndexes.includes(layerIdx) || layerIdx === boundaryLayerIndex
                        )
                        .map(({ layerIdx, pos }, displayIndex) => {
                        const layer = layers[layerIdx];
                        if (!layer) return null;
                        const isBoundary = layerIdx === boundaryLayerIndex;
                        return (
                          <div
                            key={layerIdx}
                            className={
                              "order-list-item" +
                              (dragIndex === pos ? " dragging" : "") +
                              (isBoundary ? " order-list-item--locked" : "")
                            }
                            draggable={!isBoundary}
                            onDragStart={() => !isBoundary && handleDragStart(pos)}
                            onDragOver={handleDragOver}
                            onDrop={() => handleDrop(pos)}
                            onMouseEnter={() => scheduleShowPreview(layerIdx)}
                            onMouseLeave={cancelPreview}
                          >
                            <span className="order-drag-handle">
                              {isBoundary ? "\uD83D\uDD12" : "\u2630"}
                            </span>
                            <span
                              className="order-color-dot"
                              style={{ backgroundColor: layerColors[layerIdx] ?? "#2563eb" }}
                            />
                            <span className="order-item-name">{layer.name}</span>
                            {displayIndex === 0 && !isBoundary && (
                              <span className="order-item-badge">Paling depan</span>
                            )}
                            {isBoundary && (
                              <span
                                className="order-item-badge order-item-badge--back"
                                title="Boundary selalu ditampilkan paling belakang"
                              >
                                Dasar
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {lastPreviewIndex !== null && projectPath && layers[lastPreviewIndex] && (
        <LayerPreview
          projectPath={projectPath}
          datasource={layers[lastPreviewIndex].datasource}
          layer={layers[lastPreviewIndex]}
          fallbackColor={layerColors[lastPreviewIndex] ?? "#2563eb"}
          categoryColorOverrides={layerCategoryColors[lastPreviewIndex]}
          name={layers[lastPreviewIndex].name}
          visible={previewIndex !== null}
          labelFontSize={labelFontSize}
        />
      )}
    </div>
  );
}

export default ProjectPanel;
