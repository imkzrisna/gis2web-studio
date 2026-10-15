import type { LayerValueMappings } from "./lib/valueMapping";
import { sanitizeLabelPositions, type LabelPositions } from "./lib/labelPositions";
import { useMemo, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SCALE_BAR_SEGMENTS_DEFAULT, clampScaleBarSegments } from "./lib/scaleBar";
import "./App.css";
import MapView from "./components/MapView";
import ProjectPanel, { type LayerInfo } from "./components/ProjectPanel";
import ImportToolbar from "./components/ImportToolbar";
import {
  type WebGisConfig,
  type ExportConfig,
  type BasemapCandidateInfo,
  ZOOM_MIN_LIMIT,
  ZOOM_MAX_LIMIT,
  LABEL_FONT_SIZE_MIN,
  LABEL_FONT_SIZE_MAX,
} from "./components/ConfigurationPanel";
import ExportPanel from "./components/ExportPanel";
import BasemapSwitcher from "./components/BasemapSwitcher";
import AttributeTablePanel from "./components/AttributeTablePanel";
import FeatureInfoCard from "./components/FeatureInfoCard";
import { getCachedGeojson } from "./lib/layerGeojsonCache";
import { buildCategories } from "./lib/autoCategories";

type MenuKey = "project" | "export";

const MENU_ITEMS: { key: MenuKey; label: string }[] = [
  { key: "project", label: "Project" },
  { key: "export", label: "Export" },
];

function enforceBoundaryAtBack(order: number[], boundaryIndex: number | null): number[] {
  if (boundaryIndex === null || !order.includes(boundaryIndex)) return order;
  const withoutBoundary = order.filter((i) => i !== boundaryIndex);
  return [...withoutBoundary, boundaryIndex];
}

function App({ onReset }: { onReset?: () => void }) {
  const [activeMenu, setActiveMenu] = useState<MenuKey>("project");
  const [layerPanelOpen, setLayerPanelOpen] = useState(true);

  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [layers, setLayers] = useState<LayerInfo[]>([]);
  const [isImporting, setIsImporting] = useState(false);
  const [importingLabel, setImportingLabel] = useState("Memuat layer...");
  const [selectedLayerIndexes, setSelectedLayerIndexes] = useState<number[]>([]);
  const [boundaryLayerIndex, setBoundaryLayerIndex] = useState<number | null>(null);
  const [layerColors, setLayerColors] = useState<Record<number, string>>({});
  const [layerCategoryColors, setLayerCategoryColors] = useState<Record<number, Record<string, string>>>({});
  const [layerOpacities, setLayerOpacities] = useState<Record<number, number>>({});
  const [layerPointSizes, setLayerPointSizes] = useState<Record<number, number>>({});
  const [layerOrder, setLayerOrder] = useState<number[]>([]);
  const [activeLayerIndex, setActiveLayerIndex] = useState<number | null>(null);
  const [activeFeature, setActiveFeature] = useState<
    { layerIndex: number; featureIndex: number } | null
  >(null);
  const [attributeTableCollapsed, setAttributeTableCollapsed] = useState(true);
  const [layerVisibleFields, setLayerVisibleFields] = useState<Record<number, string[]>>({});
  const [layerFieldAliases, setLayerFieldAliases] = useState<
    Record<number, Record<string, string>>
  >({});

  const [layerValueMappings, setLayerValueMappings] = useState<LayerValueMappings>({});
  const [layerFlowStep, setLayerFlowStep] = useState<"select" | "manage">("select");
  const [layerDisplayNames, setLayerDisplayNames] = useState<Record<number, string>>({});
  const displayLayers = useMemo(() => {
    if (Object.keys(layerDisplayNames).length === 0) return layers;
    return layers.map((l, i) => (layerDisplayNames[i] ? { ...l, name: layerDisplayNames[i] } : l));
  }, [layers, layerDisplayNames]);

  function handleLayerRename(index: number, name: string) {
    const clean = name.trim();
    setLayerDisplayNames((prev) => {
      const next = { ...prev };
      if (clean === "" || clean === layers[index]?.name) delete next[index];
      else next[index] = clean;
      return next;
    });
  }

  function handleValueMappingChange(
    layerIndex: number,
    field: string,
    rawValue: string,
    label: string
  ) {
    setLayerValueMappings((prev) => {
      const fieldMap = { ...(prev[layerIndex]?.[field] ?? {}) };
      const clean = label.trim();
      if (clean === "") {
        delete fieldMap[rawValue];
      } else {
        fieldMap[rawValue] = clean;
      }
      const layerMap = { ...(prev[layerIndex] ?? {}) };
      if (Object.keys(fieldMap).length === 0) {
        delete layerMap[field];
      } else {
        layerMap[field] = fieldMap;
      }
      const next = { ...prev };
      if (Object.keys(layerMap).length === 0) {
        delete next[layerIndex];
      } else {
        next[layerIndex] = layerMap;
      }
      return next;
    });
  }

  function handleFieldAliasChange(layerIndex: number, field: string, alias: string) {
    setLayerFieldAliases((prev) => {
      const layerAliases = { ...(prev[layerIndex] ?? {}) };
      if (alias.trim() === "") {
        delete layerAliases[field];
      } else {
        layerAliases[field] = alias;
      }
      const next = { ...prev };
      if (Object.keys(layerAliases).length === 0) {
        delete next[layerIndex];
      } else {
        next[layerIndex] = layerAliases;
      }
      return next;
    });
  }

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
    showLegend: true,
    showScaleBar: true,
    showFullTable: true,
    scaleBarSegments: SCALE_BAR_SEGMENTS_DEFAULT,
    exportTitle: "",
    exportLogoPath: null,
    exportLogoCrop: null,
  });
  const [, setBasemapCandidates] = useState<BasemapCandidateInfo[]>([]);
  const [labelPositions, setLabelPositions] = useState<LabelPositions>({});

  // Pengaturan (config + exportConfig) disimpan di samping file .qgz
  // sebagai <nama>.qgz.gis2web.json dan dimuat otomatis saat project dipilih.
  const loadedPathRef = useRef<string | null>(null);

  useEffect(() => {
    loadedPathRef.current = null;
    setLabelPositions({});
    setExportConfig((prev) => ({ ...prev, exportTitle: "", exportLogoPath: null, exportLogoCrop: null }));
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
                showLegend: e.showLegend !== false,
                showScaleBar: e.showScaleBar !== false,
                showFullTable: e.showFullTable !== false,
                scaleBarSegments: clampScaleBarSegments(e.scaleBarSegments),
                exportTitle: "",
                exportLogoCrop: null,
                exportLogoPath: null,
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
        json: JSON.stringify({
          version: 1,
          config,
          exportConfig: { ...exportConfig, exportTitle: "", exportLogoPath: null, exportLogoCrop: null },
          labelPositions,
        }),
      }).catch((err) => console.error("Gagal menyimpan pengaturan project:", err));
    }, 500);
    return () => window.clearTimeout(timeout);
  }, [projectPath, config, exportConfig, labelPositions]);
  const [, setGdalAvailable] = useState(false);

  useEffect(() => {
    invoke("clear_raster_preview").catch(() => {});
  }, []);

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

    setLayerOrder(newLayers.map((_, i) => i));
    setActiveLayerIndex(null);
  }

  function handleLayerCategoryFieldChange(index: number, field: string | null) {
    const target = layers[index];
    if (!target) return;
    const text = projectPath ? getCachedGeojson(projectPath, target.datasource) : null;
    const categories = field ? buildCategories(text, field) : null;
    setLayers((prev) =>
      prev.map((l, i) =>
        i === index
          ? { ...l, category_field: categories ? field : null, categories }
          : l
      )
    );
    setLayerCategoryColors((prev) => {
      const next = { ...prev };
      delete next[index];
      return next;
    });
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

  function handleResetLayer(index: number) {
    const layer = layers[index];
    if (!layer) return;
    setLayerColors((prev) => {
      const next = { ...prev };
      if (layer.color) next[index] = layer.color;
      else delete next[index];
      return next;
    });
    setLayerCategoryColors((prev) => {
      const next = { ...prev };
      if (layer.categories && layer.categories.length > 0) {
        const catMap: Record<string, string> = {};
        layer.categories.forEach((cat) => {
          catMap[cat.value] = cat.color;
        });
        next[index] = catMap;
      } else {
        delete next[index];
      }
      return next;
    });
    setLayerOpacities((prev) => {
      const next = { ...prev };
      delete next[index];
      return next;
    });
    setLayerPointSizes((prev) => {
      const next = { ...prev };
      delete next[index];
      return next;
    });
  }

  function handleResetAllLayers() {
    layers.forEach((_, index) => handleResetLayer(index));
  }

  function handleBoundaryLayerIndexChange(index: number | null) {
    setBoundaryLayerIndex(index);
    setActiveFeature((prev) => (prev && prev.layerIndex === index ? null : prev));
    setLayerOrder((prev) =>
      enforceBoundaryAtBack(prev, index !== null && selectedLayerIndexes.includes(index) ? null : index)
    );
  }

  function handleLayerOrderChange(newOrder: number[]) {
    setLayerOrder(
      enforceBoundaryAtBack(
        newOrder,
        boundaryLayerIndex !== null && selectedLayerIndexes.includes(boundaryLayerIndex) ? null : boundaryLayerIndex
      )
    );
  }

  function handleLayerOpacityChange(index: number, opacity: number) {
    setLayerOpacities((prev) => ({ ...prev, [index]: opacity }));
  }

  function handleLayerPointSizeChange(index: number, size: number) {
    setLayerPointSizes((prev) => ({ ...prev, [index]: size }));
  }

  function handleFocusFeature(layerIndex: number, featureIndex: number) {
    if (layerIndex === boundaryLayerIndex && !selectedLayerIndexes.includes(layerIndex)) return;
    setActiveFeature({ layerIndex, featureIndex });
  }

  const enabledAttributeTableLayerIndexes = layers
    .map((_, i) => i)
    .filter(
      (i) =>
        selectedLayerIndexes.includes(i) &&
        layers[i]?.kind !== "raster"
    );

  return (
    <div className="app-shell">
      <nav className="floating-nav" aria-label="Navigasi utama">
        <span className="nav-pill nav-pill--brand">GIS2Web</span>
        {MENU_ITEMS.map((item) => (
          <button
            key={item.key}
            type="button"
            className={"nav-pill" + (activeMenu === item.key ? " active" : "")}
            onClick={() => setActiveMenu(item.key)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <div className="app-body">

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
                panelOpen={layerPanelOpen}
                onTogglePanel={() => setLayerPanelOpen((v) => !v)}
                onResetProject={onReset}
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
              <BasemapSwitcher config={config} onConfigChange={setConfig} />
              <div className="project-map-layout">
                <MapView
                  projectPath={projectPath}
                  layers={displayLayers}
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
                  fieldAliases={layerFieldAliases}
                  valueMappings={layerValueMappings}
                  featureDisplayMode="card"
                />
                <FeatureInfoCard
                  projectPath={projectPath}
                  layers={displayLayers}
                  activeFeature={activeFeature}
                  onClose={() => setActiveFeature(null)}
                  onOpenFullTable={() => setAttributeTableCollapsed(false)}
                  visibleFields={layerVisibleFields}
                  onVisibleFieldsChange={handleVisibleFieldsChange}
                  fieldAliases={layerFieldAliases}
                  onFieldAliasChange={handleFieldAliasChange}
                  valueMappings={layerValueMappings}
                  onValueMappingChange={handleValueMappingChange}
                />
                {!attributeTableCollapsed && (
                  <AttributeTablePanel
                    projectPath={projectPath}
                    layers={displayLayers}
                    enabledLayerIndexes={enabledAttributeTableLayerIndexes}
                    activeFeature={activeFeature}
                    onFocusFeature={handleFocusFeature}
                    collapsed={attributeTableCollapsed}
                    onCollapsedChange={setAttributeTableCollapsed}
                  />
                )}
                <ProjectPanel
                panelOpen={layerPanelOpen}
                onPanelOpenChange={setLayerPanelOpen}
                onLayerRename={handleLayerRename}
                layerOriginalNames={layers.map((l) => l.name)}
                layerFlowStep={layerFlowStep}
                onLayerFlowStepChange={setLayerFlowStep}
              valueMappings={layerValueMappings}
                  projectPath={projectPath}
                  layers={displayLayers}
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
                  onResetLayer={handleResetLayer}
                  onResetAllLayers={handleResetAllLayers}
                  layerOrder={layerOrder}
                  onLayerOrderChange={handleLayerOrderChange}
                  onLayerCategoryFieldChange={handleLayerCategoryFieldChange}
                  activeLayerIndex={activeLayerIndex}
                  onFocusLayer={setActiveLayerIndex}
                />
              </div>
            </div>
          ) : activeMenu === "export" ? (
            <ExportPanel
              projectPath={projectPath}
              layers={displayLayers}
              selectedLayerIndexes={selectedLayerIndexes}
              boundaryLayerIndex={boundaryLayerIndex}
              layerColors={layerColors}
              layerCategoryColors={layerCategoryColors}
              layerOpacities={layerOpacities}
              layerPointSizes={layerPointSizes}
              layerOrder={layerOrder}
              layerVisibleFields={layerVisibleFields}
              layerFieldAliases={layerFieldAliases}
              layerValueMappings={layerValueMappings}
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
    </div>
  );
}

function AppRoot() {
  const [session, setSession] = useState(0);
  return <App key={session} onReset={() => setSession((n) => n + 1)} />;
}

export default AppRoot;
