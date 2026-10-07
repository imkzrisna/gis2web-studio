import type { LogoCrop } from "../lib/logoCrop";
export type BasemapOption = "osm" | "satellite" | "topo" | "custom";

export interface BasemapCandidateInfo {
  name: string;
  kind: "local_raster" | "external_tile";
  datasource: string;
}

export const BASEMAP_TILE_INFO: Record<BasemapOption, { url: string; attribution: string }> = {
  osm: {
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: "&copy; OpenStreetMap contributors",
  },
  satellite: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution: "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics",
  },
  topo: {
    url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
    attribution: "Map data: &copy; OpenStreetMap contributors, SRTM | Map style: &copy; OpenTopoMap",
  },
  // Placeholder saja untuk kelengkapan type. Nilai url/attribution asli untuk
  // basemap custom diambil dari config.customBasemap, ditangani terpisah
  // saat export (bukan lewat tabel statis ini).
  custom: {
    url: "",
    attribution: "",
  },
};

export type FeatureDisplayMode = "both" | "card" | "popup";

export interface WebGisConfig {
  basemap: BasemapOption;
  customBasemap: BasemapCandidateInfo | null;
}

export interface ExportConfig {
  minZoom: number;
  maxZoom: number;
  labelFontSize: number;
  exportTitle: string;
  showLegend: boolean;
  showScaleBar: boolean;
  scaleBarSegments: number;
  exportLogoPath: string | null;
  exportLogoCrop: LogoCrop | null;
}

interface ConfigurationPanelProps {
  config: WebGisConfig;
  onConfigChange: (config: WebGisConfig) => void;
  basemapCandidates?: BasemapCandidateInfo[];
  gdalAvailable?: boolean;
}

export const BASEMAP_OPTIONS: { value: BasemapOption; label: string }[] = [
  { value: "osm", label: "OpenStreetMap" },
  { value: "satellite", label: "Satellite (Esri World Imagery)" },
  { value: "topo", label: "Topographic (OpenTopoMap)" },
];

export const ZOOM_MIN_LIMIT = 5;
export const ZOOM_MAX_LIMIT = 20;
export const LABEL_FONT_SIZE_MIN = 8;
export const LABEL_FONT_SIZE_MAX = 24;

function ConfigurationPanel({
  config,
  onConfigChange,
  basemapCandidates = [],
  gdalAvailable = false,
}: ConfigurationPanelProps) {

  function updateBasemap(basemap: BasemapOption) {
    onConfigChange({ ...config, basemap });
  }

  function updateCustomBasemap(candidate: BasemapCandidateInfo) {
    onConfigChange({ ...config, basemap: "custom", customBasemap: candidate });
  }

  function isCandidateDisabled(candidate: BasemapCandidateInfo): boolean {
    return candidate.kind === "local_raster" && !gdalAvailable;
  }

  return (
    <div className="config-panel">
      <section className="config-section">
        <h3>Basemap</h3>
        <div className="config-radio-group">
          {BASEMAP_OPTIONS.map((option) => (
            <label key={option.value} className="config-radio-item">
              <input
                type="radio"
                name="basemap"
                value={option.value}
                checked={config.basemap === option.value}
                onChange={() => updateBasemap(option.value)}
              />
              {option.label}
            </label>
          ))}
        </div>

        {basemapCandidates.length > 0 && (
          <div className="config-radio-group config-radio-group--candidates">
            <p className="config-static-value">Dari QGIS Project</p>
            {basemapCandidates.map((candidate, idx) => {
              const disabled = isCandidateDisabled(candidate);
              const checked =
                config.basemap === "custom" &&
                config.customBasemap?.datasource === candidate.datasource;
              return (
                <label
                  key={`${candidate.datasource}-${idx}`}
                  className="config-radio-item config-radio-item--stacked"
                >
                  <div className="config-radio-item-row">
                    <input
                      type="radio"
                      name="basemap"
                      value={`custom-${idx}`}
                      checked={checked}
                      disabled={disabled}
                      onChange={() => updateCustomBasemap(candidate)}
                    />
                    {candidate.name} ({candidate.kind === "local_raster" ? "Raster Lokal" : "URL Eksternal"})
                  </div>
                  {disabled && (
                    <span className="config-radio-item-hint">
                      GDAL tidak ditemukan di sistem, tidak bisa memproses raster lokal ini.
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        )}
      </section>

      <section className="config-section">
        <h3>Initial View</h3>
        <p className="config-static-value">Fit to Boundary (default)</p>
      </section>

      <section className="config-summary">
        <h3>Ringkasan Konfigurasi</h3>
        <p>
          Basemap:{" "}
          {config.basemap === "custom"
            ? config.customBasemap?.name ?? "Dari QGIS Project"
            : BASEMAP_OPTIONS.find((o) => o.value === config.basemap)?.label}
        </p>
        <p>Initial View: Fit to Boundary</p>
      </section>
    </div>
  );
}

export default ConfigurationPanel;
