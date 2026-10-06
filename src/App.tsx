import { sanitizeLabelPositions, type LabelPositions } from "./lib/labelPositions";
import { sanitizeLogoCrop } from "./lib/logoCrop";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";
import MapView from "./components/MapView";
import ProjectPanel, { type LayerInfo } from "./components/ProjectPanel";
import ImportToolbar from "./components/ImportToolbar";
import ConfigurationPanel, {
  type WebGisConfig,
  type ExportConfig,
  type BasemapCandidateInfo,
  ZOOM_MIN_LIMIT,
  ZOOM_MAX_LIMIT,
  LABEL_FONT_SIZE_MIN,
  LABEL_FONT_SIZE_MAX,
} from "./components/ConfigurationPanel";
import ExportPanel from "./components/ExportPanel";
import AttributeTablePanel from "./components/AttributeTablePanel";
import FeatureInfoCard from "./components/FeatureInfoCard";

type MenuKey = "project" | "configuration" | "export";

type MenuIconKey = "project" | "configuration" | "export";

const MENU_ITEMS: { key: MenuKey; label: string; icon: MenuIconKey }[] = [
  { key: "project", label: "Project", icon: "project" },
  { key: "configuration", label: "Configuration", icon: "configuration" },
  { key: "export", label: "Export", icon: "export" },
];

function MenuIcon({ icon }: { icon: MenuIconKey }) {
  if (icon === "project") {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 7l6-3 6 3 6-3v13l-6 3-6-3-6 3V7z" />
        <path d="M9 4v13M15 7v13" />
      </svg>
    );
  }
  if (icon === "configuration") {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" />
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v12" />
      <path d="M7 10l5 5 5-5" />
      <path d="M4 20h16" />
    </svg>
  );
}

function enforceBoundaryAtBack(order: number[], boundaryIndex: number | null): number[] {
  if (boundaryIndex === null || !order.includes(boundaryIndex)) return order;
  const withoutBoundary = order.filter((i) => i !== boundaryIndex);
  return [...withoutBoundary, boundaryIndex];
}

function App() {
  const [activeMenu, setActiveMenu] = useState<MenuKey>("project");

  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [layers, setLayers] = useState<LayerInfo[]>([]);
  const [isImporting, setIsImporting] = useState(false);
  const [importingLabel, setImportingLabel] = useState("Memuat layer...");
  const [selectedLayerIndexes, setSelectedLayerIndexes] = useState<number[]>([]);
  const [boundaryLayerIndex, setBoundaryLayerIndex] = useState<number | null>(null);
  const [layerColors, setLayerColors] = useState<Record<number, string>>({});
  const [layerCategoryColors, setLayerCategoryColors] = useState<Record<number, Record<string, string>>>({});
  const [layerAttributeTableEnabled, setLayerAttributeTableEnabled] = useState<Record<number, boolean>>({});
  const [layerOpacities, setLayerOpacities] = useState<Record<number, number>>({});
  const [layerPointSizes, setLayerPointSizes] = useState<Record<number, number>>({});
  const [layerOrder, setLayerOrder] = useState<number[]>([]);
  const [activeLayerIndex, setActiveLayerIndex] = useState<number | null>(null);
  const [activeFeature, setActiveFeature] = useState<
    { layerIndex: number; featureIndex: number } | null
  >(null);
  const [attributeTableCollapsed, setAttributeTableCollapsed] = useState(true);
  const [layerVisibleFields, setLayerVisibleFields] = useState<Record<number, string[]>>({});

  function handleVisibleFieldsChange(layerIndex: number, fields: string[] | null) {
    setLayerVisibleFields((prev) => {
      if (fields === null) {
        const next = { ...prev };
        delete next[layerIndex];
        return next;
      }
      return { ...prev, [layerIndex]: fields };
    });
  }

  const [config, setConfig] = useState<WebGisConfig>({
    basemap: "osm",
    customBasemap: null,
  });
  const [exportConfig, setExportConfig] = useState<ExportConfig>({
    minZoom: 5,
    maxZoom: 18,
    labelFontSize: 13,
    exportTitle: "",
    exportLogoPath: null,
    exportLogoCrop: null,
  });
  const [basemapCandidates, setBasemapCandidates] = useState<BasemapCandidateInfo[]>([]);
  const [labelPositions, setLabelPositions] = useState<LabelPositions>({});

  // Pengaturan (config + exportConfig) disimpan di samping file .qgz
  // sebagai <nama>.qgz.gis2web.json dan dimuat otomatis saat project dipilih.
  const loadedPathRef = useRef<string | null>(null);

  useEffect(() => {
    loadedPathRef.current = null;
    setLabelPositions({});
    if (!projectPath) return;
    let cancelled = false;

    invoke<string | null>("load_project_settings", { projectPath })
      .then((raw) => {
        if (cancelled) return;
        if (raw) {
          try {
            const data = JSON.parse(raw) as {
              config?: Partial<WebGisConfig>;
              exportConfig?: Partial<ExportConfig>;
              labelPositions?: unknown;
            };
            setLabelPositions(sanitizeLabelPositions(data.labelPositions));
            const c = data.config;
            if (c && ["osm", "satellite", "topo", "custom"].includes(c.basemap as string)) {
              const isCustom = c.basemap === "custom";
              if (!isCustom || c.customBasemap) {
                setConfig({
                  basemap: c.basemap as WebGisConfig["basemap"],
                  customBasemap: isCustom ? (c.customBasemap ?? null) : null,
                });
              }
            }
            const e = data.exportConfig;
            if (e) {
              const clamp = (v: unknown, lo: number, hi: number, d: number) =>
                typeof v === "number" && Number.isFinite(v)
                  ? Math.min(hi, Math.max(lo, Math.round(v)))
                  : d;
              const minZoom = clamp(e.minZoom, ZOOM_MIN_LIMIT, ZOOM_MAX_LIMIT, 5);
              const maxZoom = Math.max(minZoom, clamp(e.maxZoom, ZOOM_MIN_LIMIT, ZOOM_MAX_LIMIT, 18));
              setExportConfig({
                minZoom,
                maxZoom,
                labelFontSize: clamp(e.labelFontSize, LABEL_FONT_SIZE_MIN, LABEL_FONT_SIZE_MAX, 13),
                exportTitle: typeof e.exportTitle === "string" ? e.exportTitle.slice(0, 120) : "",
                exportLogoCrop:
                  typeof e.exportLogoPath === "string" && e.exportLogoPath
                    ? sanitizeLogoCrop(e.exportLogoCrop)
                    : null,
                exportLogoPath:
                  typeof e.exportLogoPath === "string" && e.exportLogoPath ? e.exportLogoPath : null,
              });
            }
          } catch (err) {
            console.error("Pengaturan project tidak valid, memakai default:", err);
          }
        }
        loadedPathRef.current = projectPath;
      })
      .catch((err) => {
        console.error("Gagal memuat pengaturan project:", err);
        if (!cancelled) loadedPathRef.current = projectPath;
      });

    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  useEffect(() => {
    if (!projectPath || loadedPathRef.current !== projectPath) return;
    const timeout = window.setTimeout(() => {
      invoke("save_project_settings", {
        projectPath,
        json: JSON.stringify({ version: 1, config, exportConfig, labelPositions }),
      }).catch((err) => console.error("Gagal menyimpan pengaturan project:", err));
    }, 500);
    return () => window.clearTimeout(timeout);
  }, [projectPath, config, exportConfig, labelPositions]);
  const [gdalAvailable, setGdalAvailable] = useState(false);

  // Layer basemap/tile (mis. "OpenStreetMap" XYZ) yang ikut terbaca dari
  // file project QGIS bukan data vektor sungguhan dan tidak bisa diproses
  // sebagai layer GIS biasa, jadi disaring di sini sebelum masuk ke daftar
  // layer yang tampil/bisa dipilih user.
  function isBasemapTileLayer(layer: LayerInfo): boolean {
    const ds = layer.datasource ?? "";
    return ds.includes("type=xyz") || ds.startsWith("crs=");
  }

  function handleLayersLoaded(rawLayers: LayerInfo[]) {
    const newLayers = rawLayers.filter((layer) => !isBasemapTileLayer(layer));
    setLayers(newLayers);

    const initialColors: Record<number, string> = {};
    const initialCategoryColors: Record<number, Record<string, string>> = {};
    newLayers.forEach((layer, index) => {
      if (layer.color) {
        initialColors[index] = layer.color;
      }
      if (layer.categories && layer.categories.length > 0) {
        const catMap: Record<string, string> = {};
        layer.categories.forEach((cat) => {
          catMap[cat.value] = cat.color;
        });
        initialCategoryColors[index] = catMap;
      }
    });
    setLayerColors(initialColors);
    setLayerCategoryColors(initialCategoryColors);
    setLayerAttributeTableEnabled({});

    setLayerOrder(newLayers.map((_, i) => i));
    setActiveLayerIndex(null);
  }

  function handleLayerColorChange(index: number, color: string) {
    setLayerColors((prev) => ({ ...prev, [index]: color }));
  }

  function handleLayerCategoryColorChange(index: number, categoryValue: string, color: string) {
    setLayerCategoryColors((prev) => ({
      ...prev,
      [index]: { ...(prev[index] ?? {}), [categoryValue]: color },
    }));
  }

  function handleAttributeTableToggle(index: number, enabled: boolean) {
    setLayerAttributeTableEnabled((prev) => ({ ...prev, [index]: enabled }));
  }

  function handleBoundaryLayerIndexChange(index: number | null) {
    setBoundaryLayerIndex(index);
    setActiveFeature((prev) => (prev && prev.layerIndex === index ? null : prev));
    if (index !== null) {
      setLayerAttributeTableEnabled((prev) => ({ ...prev, [index]: false }));
    }
    setLayerOrder((prev) => enforceBoundaryAtBack(prev, index));
  }

  function handleLayerOrderChange(newOrder: number[]) {
    setLayerOrder(enforceBoundaryAtBack(newOrder, boundaryLayerIndex));
  }

  function handleLayerOpacityChange(index: number, opacity: number) {
    setLayerOpacities((prev) => ({ ...prev, [index]: opacity }));
  }

  function handleLayerPointSizeChange(index: number, size: number) {
    setLayerPointSizes((prev) => ({ ...prev, [index]: size }));
  }

  function handleFocusFeature(layerIndex: number, featureIndex: number) {
    if (layerIndex === boundaryLayerIndex) return;
    setActiveFeature({ layerIndex, featureIndex });
  }

  const enabledAttributeTableLayerIndexes = layers
    .map((_, i) => i)
    .filter(
      (i) =>
        layerAttributeTableEnabled[i] &&
        boundaryLayerIndex !== i &&
        selectedLayerIndexes.includes(i)
    );

  return (
    <div className="app-shell">
      <header className="app-header">
        <span className="app-title">GIS2Web Studio</span>
        <button className="settings-button" type="button">
          Settings
        </button>
      </header>

      <div className="app-body">
        <nav className="app-sidebar">
          {MENU_ITEMS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={
                "sidebar-item" + (activeMenu === item.key ? " active" : "")
              }
              onClick={() => setActiveMenu(item.key)}
            >
              <span className="sidebar-item-icon">
                <MenuIcon icon={item.icon} />
              </span>
              <span className="sidebar-item-label">{item.label}</span>
            </button>
          ))}
        </nav>

        <main
          className={
            "app-main" +
            (activeMenu === "project" ? " app-main--full-bleed" : "") +
            (activeMenu === "export" ? " app-main--export" : "")
          }
        >
          {activeMenu === "project" ? (
            <div className="project-view">
              <ImportToolbar
                projectPath={projectPath}
                onProjectPathChange={setProjectPath}
                onLayersLoaded={handleLayersLoaded}
                onSelectedLayerIndexesChange={setSelectedLayerIndexes}
                onBoundaryLayerIndexChange={handleBoundaryLayerIndexChange}
                onBasemapCandidatesLoaded={setBasemapCandidates}
                onGdalAvailabilityChecked={setGdalAvailable}
                onImportingChange={setIsImporting}
                onImportingLabelChange={setImportingLabel}
              />
              <div className="project-map-layout">
                <MapView
                  projectPath={projectPath}
                  layers={layers}
                  selectedLayerIndexes={selectedLayerIndexes}
                  boundaryLayerIndex={boundaryLayerIndex}
                  config={config}
                  layerColors={layerColors}
                  layerCategoryColors={layerCategoryColors}
                  layerOpacities={layerOpacities}
                  layerPointSizes={layerPointSizes}
                  layerOrder={layerOrder}
                  activeLayerIndex={activeLayerIndex}
                  onFocusLayer={setActiveLayerIndex}
                  activeFeature={activeFeature}
                  onFocusFeature={handleFocusFeature}
                  visibleFields={layerVisibleFields}
                  featureDisplayMode="card"
                />
                <FeatureInfoCard
                  projectPath={projectPath}
                  layers={layers}
                  activeFeature={activeFeature}
                  onClose={() => setActiveFeature(null)}
                  onOpenFullTable={() => setAttributeTableCollapsed(false)}
                  visibleFields={layerVisibleFields}
                  onVisibleFieldsChange={handleVisibleFieldsChange}
                />
                <AttributeTablePanel
                  projectPath={projectPath}
                  layers={layers}
                  enabledLayerIndexes={enabledAttributeTableLayerIndexes}
                  activeFeature={activeFeature}
                  onFocusFeature={handleFocusFeature}
                  collapsed={attributeTableCollapsed}
                  onCollapsedChange={setAttributeTableCollapsed}
                />
                <ProjectPanel
                  projectPath={projectPath}
                  layers={layers}
                  hasProject={projectPath !== null}
                  isImporting={isImporting}
                  importingLabel={importingLabel}
                  selectedLayerIndexes={selectedLayerIndexes}
                  onSelectedLayerIndexesChange={setSelectedLayerIndexes}
                  boundaryLayerIndex={boundaryLayerIndex}
                  onBoundaryLayerIndexChange={handleBoundaryLayerIndexChange}
                  layerColors={layerColors}
                  onLayerColorChange={handleLayerColorChange}
                  layerCategoryColors={layerCategoryColors}
                  onLayerCategoryColorChange={handleLayerCategoryColorChange}
                  layerOpacities={layerOpacities}
                  onLayerOpacityChange={handleLayerOpacityChange}
                  layerPointSizes={layerPointSizes}
                  onLayerPointSizeChange={handleLayerPointSizeChange}
                  layerAttributeTableEnabled={layerAttributeTableEnabled}
                  onAttributeTableToggle={handleAttributeTableToggle}
                  layerOrder={layerOrder}
                  onLayerOrderChange={handleLayerOrderChange}
                  activeLayerIndex={activeLayerIndex}
                  onFocusLayer={setActiveLayerIndex}
                />
              </div>
            </div>
          ) : activeMenu === "configuration" ? (
            <ConfigurationPanel
              config={config}
              onConfigChange={setConfig}
              basemapCandidates={basemapCandidates}
              gdalAvailable={gdalAvailable}
            />
          ) : activeMenu === "export" ? (
            <ExportPanel
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
              layerAttributeTableEnabled={layerAttributeTableEnabled}
              labelPositions={labelPositions}
              onLabelPositionsChange={setLabelPositions}
              config={config}
              exportConfig={exportConfig}
              onExportConfigChange={setExportConfig}
            />
          ) : (
            <>
              <h2>{MENU_ITEMS.find((m) => m.key === activeMenu)?.label}</h2>
              <p>This section is a placeholder for the "{activeMenu}" panel.</p>
            </>
          )}
        </main>
      </div>

      <footer className="app-status-bar">
        <span>Status: Ready</span>
      </footer>
    </div>
  );
}

export default App;
