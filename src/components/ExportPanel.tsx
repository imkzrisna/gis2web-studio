import type { LabelPositions } from "../lib/labelPositions";
import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import LogoCropper from "./LogoCropper";
import { renderLogoPng } from "../lib/renderLogo";
import LogoPreview from "./LogoPreview";
import ExportPreviewMap from "./ExportPreviewMap";
import { invoke } from "@tauri-apps/api/core";
import type { LayerInfo } from "./ProjectPanel";
import type { WebGisConfig, ExportConfig } from "./ConfigurationPanel";
import {
  BASEMAP_TILE_INFO,
  ZOOM_MIN_LIMIT,
  ZOOM_MAX_LIMIT,
  LABEL_FONT_SIZE_MIN,
  LABEL_FONT_SIZE_MAX,
} from "./ConfigurationPanel";

interface ExportPanelProps {
  projectPath: string | null;
  layers: LayerInfo[];
  selectedLayerIndexes: number[];
  boundaryLayerIndex: number | null;
  layerColors: Record<number, string>;
  layerCategoryColors: Record<number, Record<string, string>>;
  layerOpacities: Record<number, number>;
  layerPointSizes: Record<number, number>;
  layerOrder: number[];
  layerVisibleFields: Record<number, string[]>;
  layerAttributeTableEnabled: Record<number, boolean>;
  labelPositions: LabelPositions;
  onLabelPositionsChange: (positions: LabelPositions) => void;
  config: WebGisConfig;
  exportConfig: ExportConfig;
  onExportConfigChange: (config: ExportConfig) => void;
}

interface ExportCategoryInput {
  value: string;
  color: string;
}

interface ExportRangeInput {
  lower: number;
  upper: number;
  label: string;
  color: string;
}

interface ExportLabelingInput {
  field: string;
  group_by_field: string | null;
}

interface ExportLayerInput {
  layer_index: number;
  name: string;
  datasource: string;
  geometry_type: string;
  color: string;
  opacity: number;
  point_size: number;
  category_field: string | null;
  categories: ExportCategoryInput[] | null;
  ranges: ExportRangeInput[] | null;
  labeling: ExportLabelingInput | null;
  visible_fields: string[] | null;
  is_boundary: boolean;
  show_attribute_table: boolean;
}

async function resolveExportBasemap(
  config: WebGisConfig,
  exportConfig: ExportConfig,
  outputDir: string
): Promise<{ tile_url: string; attribution: string }> {
  if (config.basemap !== "custom" || !config.customBasemap) {
    return {
      tile_url: BASEMAP_TILE_INFO[config.basemap].url,
      attribution: BASEMAP_TILE_INFO[config.basemap].attribution,
    };
  }

  const candidate = config.customBasemap;

  if (candidate.kind === "external_tile") {
    const match = candidate.datasource.match(/url=([^&]+)/);
    if (!match) {
      throw new Error(
        `Tidak dapat membaca URL basemap dari datasource QGIS: ${candidate.datasource}`
      );
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(match[1]);
    } catch {
      throw new Error(`URL basemap tidak valid pada datasource: ${candidate.datasource}`);
    }
    return { tile_url: decoded, attribution: `Custom: ${candidate.name}` };
  }

  // local_raster: generate tile pyramid via GDAL sebelum export dilanjutkan.
  await invoke<string>("generate_tile_pyramid", {
    rasterPath: candidate.datasource,
    outputDir,
    minZoom: exportConfig.minZoom,
    maxZoom: exportConfig.maxZoom,
  });

  return {
    tile_url: "./tiles/{z}/{x}/{y}.png",
    attribution: `Custom raster: ${candidate.name}`,
  };
}

function ExportPanel({
  projectPath,
  layers,
  selectedLayerIndexes,
  boundaryLayerIndex,
  layerColors,
  layerCategoryColors,
  layerOpacities,
  layerPointSizes,
  layerOrder,
  layerVisibleFields,
  layerAttributeTableEnabled,
  labelPositions,
  onLabelPositionsChange,
  config,
  exportConfig,
  onExportConfigChange,
}: ExportPanelProps) {
  const [outputDir, setOutputDir] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [resultMessage, setResultMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [previewDevice, setPreviewDevice] = useState<"desktop" | "mobile">("desktop");
  const [cropPath, setCropPath] = useState<string | null>(null);

  const zoomError = exportConfig.maxZoom < exportConfig.minZoom;

  const canExport =
    !zoomError &&
    projectPath !== null &&
    selectedLayerIndexes.length > 0 &&
    boundaryLayerIndex !== null &&
    outputDir !== null;

  async function handleChooseFolder() {
    const selected = await open({ directory: true, multiple: false });
    if (!selected || Array.isArray(selected)) return;
    setOutputDir(selected);
  }

  function buildExportLayers(): ExportLayerInput[] {
    const indexesToExportSet = new Set([
      ...selectedLayerIndexes,
      ...(boundaryLayerIndex !== null ? [boundaryLayerIndex] : []),
    ]);
    const indexesToExport = [
      ...layerOrder.filter((idx) => indexesToExportSet.has(idx)),
      ...Array.from(indexesToExportSet).filter((idx) => !layerOrder.includes(idx)),
    ];

    return indexesToExport
      .map((index) => ({ index, layer: layers[index] }))
      .filter((entry): entry is { index: number; layer: LayerInfo } => Boolean(entry.layer))
      .map(({ index, layer }) => {
        const isBoundary = index === boundaryLayerIndex;
        const categoryOverrides = layerCategoryColors[index];
        const categories: ExportCategoryInput[] | null =
          layer.categories && layer.categories.length > 0
            ? layer.categories.map((cat) => ({
                value: cat.value,
                color: categoryOverrides?.[cat.value] ?? cat.color,
              }))
            : null;
        const ranges: ExportRangeInput[] | null =
          layer.ranges && layer.ranges.length > 0
            ? layer.ranges.map((range) => ({
                lower: range.lower,
                upper: range.upper,
                label: range.label,
                color: categoryOverrides?.[range.label] ?? range.color,
              }))
            : null;
        const labeling: ExportLabelingInput | null = layer.labeling
          ? { field: layer.labeling.field, group_by_field: layer.labeling.group_by_field }
          : null;

        return {
          layer_index: index,
          name: layer.name,
          datasource: layer.datasource,
          geometry_type: layer.geometry_type,
          color: layerColors[index] ?? (isBoundary ? "#f97316" : "#2563eb"),
          opacity: layerOpacities[index] ?? 0.35,
          point_size: layerPointSizes[index] ?? 5,
          category_field: layer.category_field,
          categories,
          ranges,
          labeling,
          visible_fields: layerVisibleFields[index] ?? null,
          is_boundary: isBoundary,
          show_attribute_table: isBoundary ? false : (layerAttributeTableEnabled[index] ?? false),
        };
      });
  }

  async function handleExport() {
    if (!projectPath || !outputDir) return;

    setExporting(true);
    setResultMessage(null);
    setErrorMessage(null);

    const exportLayers = buildExportLayers();

    try {
      const basemapResolved = await resolveExportBasemap(config, exportConfig, outputDir);
      const logoPng =
        exportConfig.exportLogoPath && exportConfig.exportLogoCrop
          ? await renderLogoPng(convertFileSrc(exportConfig.exportLogoPath), exportConfig.exportLogoCrop)
          : null;
      const message = await invoke<string>("export_web_gis", {
        projectPath,
        outputDir,
        layers: exportLayers,
        config: {
          basemap: config.basemap,
          min_zoom: exportConfig.minZoom,
          max_zoom: exportConfig.maxZoom,
          tile_url: basemapResolved.tile_url,
          attribution: basemapResolved.attribution,
          label_font_size: exportConfig.labelFontSize,
          label_positions: labelPositions,
          export_title: exportConfig.exportTitle,
          export_logo_path: exportConfig.exportLogoPath,
          export_logo_png: logoPng ? Array.from(logoPng) : null,
        },
      });
      setResultMessage(message);
    } catch (err) {
      setErrorMessage(String(err));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="export-panel-layout">
    <div className="export-panel">
      <section className="config-section">
        <h3>Pengaturan Export</h3>
        <div className="config-slider-block">
          <label className="config-slider-label">Minimum Zoom</label>
          <div className="config-slider-row">
            <span className="config-slider-bound">{ZOOM_MIN_LIMIT}</span>
            <input
              type="range"
              min={ZOOM_MIN_LIMIT}
              max={ZOOM_MAX_LIMIT}
              value={exportConfig.minZoom}
              onChange={(e) => onExportConfigChange({ ...exportConfig, minZoom: Number(e.target.value) })}
            />
            <span className="config-slider-bound">{ZOOM_MAX_LIMIT}</span>
          </div>
          <div className="config-slider-value">{exportConfig.minZoom}</div>
        </div>

        <div className="config-slider-block">
          <label className="config-slider-label">Maximum Zoom</label>
          <div className="config-slider-row">
            <span className="config-slider-bound">{ZOOM_MIN_LIMIT}</span>
            <input
              type="range"
              min={ZOOM_MIN_LIMIT}
              max={ZOOM_MAX_LIMIT}
              value={exportConfig.maxZoom}
              onChange={(e) => onExportConfigChange({ ...exportConfig, maxZoom: Number(e.target.value) })}
            />
            <span className="config-slider-bound">{ZOOM_MAX_LIMIT}</span>
          </div>
          <div className="config-slider-value">{exportConfig.maxZoom}</div>
        </div>

        {zoomError && (
          <p className="config-error">
            Maximum Zoom harus lebih besar atau sama dengan Minimum Zoom.
          </p>
        )}

        <div className="config-slider-block">
          <label className="config-slider-label">Ukuran Font Label (px)</label>
          <div className="config-slider-row">
            <span className="config-slider-bound">{LABEL_FONT_SIZE_MIN}</span>
            <input
              type="range"
              min={LABEL_FONT_SIZE_MIN}
              max={LABEL_FONT_SIZE_MAX}
              value={exportConfig.labelFontSize}
              onChange={(e) => onExportConfigChange({ ...exportConfig, labelFontSize: Number(e.target.value) })}
            />
            <span className="config-slider-bound">{LABEL_FONT_SIZE_MAX}</span>
          </div>
          <div className="config-slider-value">{exportConfig.labelFontSize}px</div>
        </div>
      </section>

      <section className="config-section">
        <h3>Identitas Halaman</h3>
        <div className="export-tab-mockup" aria-label="Pratinjau tab browser">
          <span className="export-tab-mockup-icon">
            {exportConfig.exportLogoPath && exportConfig.exportLogoCrop ? (
              <LogoPreview
                src={convertFileSrc(exportConfig.exportLogoPath)}
                crop={exportConfig.exportLogoCrop}
                size={20}
              />
            ) : (
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="9" />
                <path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18" />
              </svg>
            )}
          </span>
          <span className="export-tab-mockup-title">
            {exportConfig.exportTitle.trim() || "GIS2Web Studio Export"}
          </span>
        </div>
        <div className="config-slider-block">
          <label className="config-slider-label">Title Halaman</label>
          <input
            type="text"
            maxLength={120}
            placeholder="GIS2Web Studio Export"
            value={exportConfig.exportTitle}
            onChange={(e) => onExportConfigChange({ ...exportConfig, exportTitle: e.target.value })}
          />
        </div>
        <div className="config-slider-block">
          <label className="config-slider-label">Logo (Favicon)</label>
          <div className="logo-actions">
            <button
              type="button"
              onClick={async () => {
                const selected = await open({
                  multiple: false,
                  filters: [{ name: "Gambar", extensions: ["png", "jpg", "jpeg", "svg", "ico"] }],
                });
                if (typeof selected === "string") setCropPath(selected);
              }}
            >
              Pilih Logo
            </button>
            {exportConfig.exportLogoPath && (
              <>
                <button type="button" onClick={() => setCropPath(exportConfig.exportLogoPath)}>
                  Atur Crop
                </button>
                <button
                  type="button"
                  onClick={() =>
                    onExportConfigChange({ ...exportConfig, exportLogoPath: null, exportLogoCrop: null })
                  }
                >
                  Hapus Logo
                </button>
              </>
            )}
          </div>
          {exportConfig.exportLogoPath && (
            <p className="project-path">{exportConfig.exportLogoPath.split(/[\\/]/).pop()}</p>
          )}
          {cropPath && (
            <LogoCropper
              src={convertFileSrc(cropPath)}
              initialCrop={cropPath === exportConfig.exportLogoPath ? exportConfig.exportLogoCrop : null}
              onCancel={() => setCropPath(null)}
              onConfirm={(crop) => {
                onExportConfigChange({ ...exportConfig, exportLogoPath: cropPath, exportLogoCrop: crop });
                setCropPath(null);
              }}
            />
          )}
        </div>
      </section>

      <section className="config-section">
        <h3>Folder Output</h3>
        <button type="button" onClick={handleChooseFolder}>
          Pilih Folder Output
        </button>
        {outputDir && <p className="project-path">Output: {outputDir}</p>}
      </section>

      <section className="config-section">
        <button
          type="button"
          onClick={handleExport}
          disabled={!canExport || exporting}
        >
          {exporting ? "Mengekspor..." : "Export Web GIS"}
        </button>
        {!canExport && (
          <p className="config-static-value">
            Pastikan project sudah diimport, minimal 1 layer dipilih untuk
            dipublikasikan, boundary layer sudah ditentukan, dan folder output
            sudah dipilih.
          </p>
        )}
      </section>

      {resultMessage && (
        <p className="export-success">{resultMessage}</p>
      )}
      {errorMessage && <p className="project-error">Error: {errorMessage}</p>}
    </div>

    <div className="export-preview-pane">
      <div className="export-preview-device-toggle">
        <button
          type="button"
          className={"export-preview-tab" + (previewDevice === "desktop" ? " active" : "")}
          onClick={() => setPreviewDevice("desktop")}
        >
          Desktop
        </button>
        <button
          type="button"
          className={"export-preview-tab" + (previewDevice === "mobile" ? " active" : "")}
          onClick={() => setPreviewDevice("mobile")}
        >
          Mobile
        </button>
      </div>

        <div className={previewDevice === "mobile" ? "export-preview-frame--mobile" : "export-preview-frame"}>
        <ExportPreviewMap
          projectPath={projectPath}
          layers={layers}
          selectedLayerIndexes={selectedLayerIndexes}
          boundaryLayerIndex={boundaryLayerIndex}
          layerColors={layerColors}
          layerCategoryColors={layerCategoryColors}
          layerOpacities={layerOpacities}
          layerPointSizes={layerPointSizes}
          layerOrder={layerOrder}
          layerVisibleFields={layerVisibleFields}
          labelPositions={labelPositions}
          onLabelPositionsChange={onLabelPositionsChange}
          config={config}
          exportConfig={exportConfig}
          device={previewDevice}
        />
        </div>
    </div>
    </div>
  );
}

export default ExportPanel;
