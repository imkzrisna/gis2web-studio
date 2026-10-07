import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { fetchLayerGeojson } from "../lib/layerGeojsonCache";
import { styleForLayer, resolveFeatureColor, computeLabeledFeatureIndexes, getStrongHighlightStyle, getSubtleHighlightStyle, getPreviewHighlightStyle } from "../lib/layerStyle";
import { getFeatureCandidates } from "../lib/featureHitTest";
import type { LayerInfo } from "./ProjectPanel";
import type { WebGisConfig, BasemapOption, FeatureDisplayMode } from "./ConfigurationPanel";

interface MapViewProps {
  projectPath: string | null;
  layers: LayerInfo[];
  selectedLayerIndexes: number[];
  boundaryLayerIndex: number | null;
  config: WebGisConfig;
  layerColors: Record<number, string>;
  layerCategoryColors: Record<number, Record<string, string>>;
  layerOpacities: Record<number, number>;
  layerPointSizes: Record<number, number>;
  layerOrder: number[];
  activeLayerIndex: number | null;
  onFocusLayer: (index: number) => void;
  activeFeature: { layerIndex: number; featureIndex: number } | null;
  onFocusFeature: (layerIndex: number, featureIndex: number) => void;
  visibleFields: Record<number, string[]>;
  fieldAliases: Record<number, Record<string, string>>;
  featureDisplayMode: FeatureDisplayMode;
}

// Map utama (workspace) memakai nilai tetap; zoom/font label hasil Web GIS
// diatur di Export (ExportConfig).
// Map utama tanpa batas zoom manual. Konstanta ini hanya membatasi animasi
// fokus ke Boundary Layer agar tidak terbang terlalu dekat.
const BOUNDARY_FOCUS_MAX_ZOOM = 18;
const BOUNDARY_FOCUS_MIN_ZOOM = 5;
const MAIN_MAP_LABEL_FONT_SIZE = 13;

interface BasemapTileDef {
  url: string;
  attribution: string;
  maxNativeZoom?: number;
}

const BASEMAP_TILE_CONFIG: Record<BasemapOption, BasemapTileDef> = {
  osm: {
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: "&copy; OpenStreetMap contributors",
  },
  satellite: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution: "Tiles &copy; Esri",
    maxNativeZoom: 19,
  },
  topo: {
    url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
    attribution: "Map data: &copy; OpenStreetMap contributors, SRTM | Map style: &copy; OpenTopoMap",
    maxNativeZoom: 17,
  },
  // Placeholder untuk kelengkapan type. Nilai sesungguhnya untuk basemap
  // custom dihitung secara dinamis lewat resolveCustomBasemapPreview(),
  // karena bergantung pada layer yang dipilih user dari project QGIS.
  custom: {
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: "&copy; OpenStreetMap contributors",
  },
};

// Preview di dalam app untuk basemap custom dari QGIS project:
// - external_tile: datasource QGIS biasanya "type=xyz&url=<url-encoded>&...",
//   ambil url-nya langsung untuk preview.
// - local_raster: tile baru digenerate saat export (gdal2tiles), belum ada
//   tile untuk di-preview di dalam app, jadi fallback ke OSM sebagai preview
//   sementara (bukan hasil akhir export).
function resolveCustomBasemapPreview(
  customBasemap: { kind: string; datasource: string; name: string } | null
): BasemapTileDef {
  const fallback = BASEMAP_TILE_CONFIG.osm;
  if (!customBasemap) return fallback;

  if (customBasemap.kind === "external_tile") {
    const match = customBasemap.datasource.match(/url=([^&]+)/);
    if (match) {
      try {
        const decoded = decodeURIComponent(match[1]);
        return { url: decoded, attribution: `Custom: ${customBasemap.name}` };
      } catch {
        return fallback;
      }
    }
  }

  return fallback;
}

const BASE_POINT_RADIUS = 5;
const HOVER_POINT_RADIUS_EXTRA = 4;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function MapView({
  projectPath,
  layers,
  selectedLayerIndexes,
  boundaryLayerIndex,
  config,
  layerColors,
  layerCategoryColors,
  layerOpacities,
  layerPointSizes,
  layerOrder,
  activeLayerIndex,
  onFocusLayer,
  activeFeature,
  onFocusFeature,
  visibleFields,
  fieldAliases,
  featureDisplayMode,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  const dataLayerGroupRef = useRef<L.LayerGroup | null>(null);
  const layerRefsRef = useRef<Map<number, L.GeoJSON>>(new Map());
  const layerStyleRef = useRef<Map<number, L.PathOptions | L.StyleFunction>>(new Map());
  const featureLayerRefsRef = useRef<Map<string, L.Layer>>(new Map());
  const layerGeojsonDataRef = useRef<Map<number, GeoJSON.FeatureCollection>>(new Map());
  const clickCycleRef = useRef<{
    point: L.Point | null;
    matches: { layerIndex: number; featureIndex: number }[];
    index: number;
  }>({ point: null, matches: [], index: -1 });
  const layerPointSizesRef = useRef<Record<number, number>>(layerPointSizes);
  const hoveredKeyRef = useRef<string | null>(null);
  const activeFeatureRef = useRef<{ layerIndex: number; featureIndex: number } | null>(activeFeature);
  const layerOrderRef = useRef<number[]>(layerOrder);
  const prevBoundaryLayerIndexRef = useRef<number | null>(null);
  const boundaryLayerIndexRef = useRef<number | null>(boundaryLayerIndex);

  useEffect(() => {
    boundaryLayerIndexRef.current = boundaryLayerIndex;
  }, [boundaryLayerIndex]);
  const visibleFieldsRef = useRef<Record<number, string[]>>(visibleFields);
  const fieldAliasesRef = useRef<Record<number, Record<string, string>>>(fieldAliases);
  const featureDisplayModeRef = useRef<FeatureDisplayMode>(featureDisplayMode);

  useEffect(() => {
    activeFeatureRef.current = activeFeature;
  }, [activeFeature]);

  useEffect(() => {
    layerPointSizesRef.current = layerPointSizes;
  }, [layerPointSizes]);

  // Point Size dinamis seperti opacity: langsung setRadius ke marker yang sudah
  // terender (tanpa rebuild layer).
  useEffect(() => {
    layerRefsRef.current.forEach((geoLayer, index) => {
      const radius = layerPointSizes[index] ?? BASE_POINT_RADIUS;
      const apply = (l: L.Layer) => {
        if (l instanceof L.CircleMarker) {
          l.setRadius(radius);
        } else if ((l as L.FeatureGroup).eachLayer) {
          (l as L.FeatureGroup).eachLayer(apply);
        }
      };
      geoLayer.eachLayer(apply);
    });
  }, [layerPointSizes]);

  useEffect(() => {
    visibleFieldsRef.current = visibleFields;
    fieldAliasesRef.current = fieldAliases;
  }, [visibleFields, fieldAliases]);

  useEffect(() => {
    featureDisplayModeRef.current = featureDisplayMode;
  }, [featureDisplayMode]);

  const [layerErrors, setLayerErrors] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  function applyStackingOrder(order: number[]) {
    [...order].reverse().forEach((idx) => {
      layerRefsRef.current.get(idx)?.bringToFront();
    });
    bringPointFeaturesToFront();
  }

  // Point/MultiPoint harus selalu tampak di atas Polygon/Buffer secara visual
  // (murni z-order, tidak menyentuh style/data), supaya tetap mudah di-hover
  // dan diklik walau berada di dalam buffer.
  function bringPointFeaturesToFront() {
    featureLayerRefsRef.current.forEach((layerInstance, key) => {
      const [layerIndexStr, featureIndexStr] = key.split(":");
      const layerIndex = Number(layerIndexStr);
      const featureIndex = Number(featureIndexStr);

      const geojsonData = layerGeojsonDataRef.current.get(layerIndex);
      const geomType = geojsonData?.features[featureIndex]?.geometry?.type;
      if (geomType !== "Point" && geomType !== "MultiPoint") return;

      const anyLayer = layerInstance as L.Layer & { bringToFront?: () => L.Layer };
      anyLayer.bringToFront?.();
    });
  }

  const handleCycleClickRef = useRef<((e: L.LeafletMouseEvent) => void) | null>(null);

  function getVisibleZOrderedFeatureCandidates(latlng: L.LatLng) {
    const group = dataLayerGroupRef.current;
    const map = mapRef.current;
    if (!group || !map) return [];
    return getFeatureCandidates({
      map,
      latlng,
      layerOrder: layerOrderRef.current,
      layerIndexes: layerRefsRef.current.keys(),
      isLayerVisible: (idx) => {
        if (idx === boundaryLayerIndexRef.current) return false;
        const geoLayer = layerRefsRef.current.get(idx);
        return !!geoLayer && group.hasLayer(geoLayer);
      },
      getGeojson: (idx) => layerGeojsonDataRef.current.get(idx),
      getFeatureLayer: (key) => featureLayerRefsRef.current.get(key),
    });
  }

  useEffect(() => {
    handleCycleClickRef.current = (e: L.LeafletMouseEvent) => {
      const map = mapRef.current;
      if (!map) return;

      const candidates = getVisibleZOrderedFeatureCandidates(e.latlng);
      if (candidates.length === 0) return;

      const clickPoint = map.latLngToContainerPoint(e.latlng);
      const prev = clickCycleRef.current;

      const sameKeys =
        prev.matches.length === candidates.length &&
        prev.matches.every(
          (m, i) => m.layerIndex === candidates[i].layerIndex && m.featureIndex === candidates[i].featureIndex
        );
      const closeToPrev = prev.point ? prev.point.distanceTo(clickPoint) < 15 : false;

      const nextIndex = sameKeys && closeToPrev ? (prev.index + 1) % candidates.length : 0;

      clickCycleRef.current = {
        point: clickPoint,
        matches: candidates.map(({ layerIndex, featureIndex }) => ({ layerIndex, featureIndex })),
        index: nextIndex,
      };

      const selected = candidates[nextIndex];
      onFocusFeature(selected.layerIndex, selected.featureIndex);

      // Leaflet otomatis membuka popup pada layer yang benar-benar disentuh
      // (e.target), terlepas dari feature mana yang dipilih oleh cycle logic
      // di atas. Supaya mode "card" benar-benar tidak menampilkan popup apa
      // pun, tutup SEMUA popup yang mungkin terbuka di seluruh feature dulu,
      // baru buka ulang sesuai mode yang aktif.
      featureLayerRefsRef.current.forEach((layerInstance) => {
        const anyLayer = layerInstance as L.Layer & { closePopup?: () => L.Layer };
        anyLayer.closePopup?.();
      });

      if (featureDisplayModeRef.current !== "card") {
        const anyLayer = selected.layerInstance as L.Layer & {
          openPopup?: (latlng?: L.LatLng) => L.Layer;
        };
        anyLayer.openPopup?.(e.latlng);
      }
    };
  });

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current, { zoomControl: false, doubleClickZoom: false }).setView(
      [-2.5, 118],
      5
    );
    L.control.zoom({ position: "bottomright" }).addTo(map);
    dataLayerGroupRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;

    // Trackpad MacBook: double-tap 2 jari memicu gesture native "Smart Zoom"
    // bawaan WKWebView, terpisah dari dblclick Leaflet biasa. Cegah di level
    // container map saja (bukan document/global) supaya tidak mengganggu
    // double-click di elemen UI lain (form, panel, dsb).
    const containerEl = containerRef.current;
    const preventNativeDblZoom = (ev: Event) => {
      ev.preventDefault();
      ev.stopPropagation();
    };
    containerEl.addEventListener("dblclick", preventNativeDblZoom, { capture: true });

    // ---- Smart Hover / hover preview ----
    // State hover 100% lokal ke MapView, TIDAK pernah memanggil onFocusFeature
    // atau membuka popup. Tidak berhubungan dengan activeFeature/Feature
    // Information sama sekali. Reuse hit-test yang sama dengan klik supaya
    // prioritas Point > Line > Polygon konsisten antara preview dan seleksi.
    let hoverRafId: number | null = null;

    const clearHoverPreview = () => {
      const key = hoveredKeyRef.current;
      if (!key) return;
      hoveredKeyRef.current = null;

      const [layerIndexStr] = key.split(":");
      const layerIndex = Number(layerIndexStr);
      const layerInstance = featureLayerRefsRef.current.get(key);
      if (!layerInstance) return;

      const anyLayer = layerInstance as L.Path & {
        feature?: GeoJSON.Feature;
        setRadius?: (radius: number) => L.Layer;
      };

      const geojsonData = layerGeojsonDataRef.current.get(layerIndex);
      const featureIndex = Number(key.split(":")[1]);
      const geomType = geojsonData?.features[featureIndex]?.geometry?.type;

      if ((geomType === "Point" || geomType === "MultiPoint") && typeof anyLayer.setRadius === "function") {
        anyLayer.setRadius(layerPointSizesRef.current[layerIndex] ?? BASE_POINT_RADIUS);
      }

      // Jangan timpa style kalau feature ini sedang jadi seleksi aktif;
      // biarkan efek highlight seleksi yang mengatur stylenya sendiri.
      const isActiveSelected =
        activeFeatureRef.current &&
        `${activeFeatureRef.current.layerIndex}:${activeFeatureRef.current.featureIndex}` === key;
      if (isActiveSelected) return;

      const styleFnOrObj = layerStyleRef.current.get(layerIndex);
      if (!styleFnOrObj || typeof anyLayer.setStyle !== "function") return;
      const baseStyle =
        typeof styleFnOrObj === "function"
          ? styleFnOrObj(anyLayer.feature as GeoJSON.Feature)
          : styleFnOrObj;
      if (baseStyle) anyLayer.setStyle(baseStyle);
    };

    const applyHoverPreview = (newKey: string | null) => {
      if (newKey === hoveredKeyRef.current) return;

      clearHoverPreview();
      if (!newKey) return;

      const layerInstance = featureLayerRefsRef.current.get(newKey);
      if (!layerInstance) return;

      const [layerIndexStr, featureIndexStr] = newKey.split(":");
      const layerIndex = Number(layerIndexStr);
      const featureIndex = Number(featureIndexStr);
      const geojsonData = layerGeojsonDataRef.current.get(layerIndex);
      const geomType = geojsonData?.features[featureIndex]?.geometry?.type;

      const anyLayer = layerInstance as L.Path & {
        feature?: GeoJSON.Feature;
        setRadius?: (radius: number) => L.Layer;
      };

      const styleFnOrObj = layerStyleRef.current.get(layerIndex);
      const baseStyle =
        styleFnOrObj && typeof styleFnOrObj === "function"
          ? styleFnOrObj(anyLayer.feature as GeoJSON.Feature)
          : (styleFnOrObj as L.PathOptions | undefined);

      // Kalau feature ini sedang seleksi aktif, jangan timpa strong highlight
      // seleksi dengan preview style — cukup tandai sudah "di-hover" saja.
      const isActiveSelected =
        activeFeatureRef.current &&
        `${activeFeatureRef.current.layerIndex}:${activeFeatureRef.current.featureIndex}` === newKey;

      if (geomType === "Point" || geomType === "MultiPoint") {
        const currentBaseRadius = layerPointSizesRef.current[layerIndex] ?? BASE_POINT_RADIUS;
        anyLayer.setRadius?.(currentBaseRadius + HOVER_POINT_RADIUS_EXTRA);
      }

      if (!isActiveSelected && baseStyle && typeof anyLayer.setStyle === "function") {
        anyLayer.setStyle(getPreviewHighlightStyle(baseStyle));
      }

      hoveredKeyRef.current = newKey;
    };

    const handleMapMouseMove = (e: L.LeafletMouseEvent) => {
      if (hoverRafId !== null) return;
      hoverRafId = window.requestAnimationFrame(() => {
        hoverRafId = null;
        const candidates = getVisibleZOrderedFeatureCandidates(e.latlng);
        const top = candidates[0];
        const newKey = top ? `${top.layerIndex}:${top.featureIndex}` : null;
        applyHoverPreview(newKey);
      });
    };

    const handleMapMouseOut = () => {
      if (hoverRafId !== null) {
        window.cancelAnimationFrame(hoverRafId);
        hoverRafId = null;
      }
      clearHoverPreview();
    };

    map.on("mousemove", handleMapMouseMove);
    map.on("mouseout", handleMapMouseOut);

    return () => {
      if (hoverRafId !== null) window.cancelAnimationFrame(hoverRafId);
      map.off("mousemove", handleMapMouseMove);
      map.off("mouseout", handleMapMouseOut);
      containerEl.removeEventListener("dblclick", preventNativeDblZoom, { capture: true } as EventListenerOptions);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (tileLayerRef.current) {
      map.removeLayer(tileLayerRef.current);
    }

    const basemapDef =
      config.basemap === "custom"
        ? resolveCustomBasemapPreview(config.customBasemap)
        : BASEMAP_TILE_CONFIG[config.basemap];
    const tileLayer = L.tileLayer(basemapDef.url, {
      attribution: basemapDef.attribution,
      maxNativeZoom: basemapDef.maxNativeZoom,
      minZoom: 0,
      maxZoom: 22,
      updateWhenZooming: false,
    });
    tileLayer.addTo(map);
    tileLayerRef.current = tileLayer;

  }, [config.basemap, config.customBasemap]);

  // Tombol 1 klik: terbang ke Boundary Layer, zoom hasil tidak lebih kecil
  // dari BOUNDARY_FOCUS_MIN_ZOOM.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const FocusControl = L.Control.extend({
      onAdd() {
        const container = L.DomUtil.create("div", "leaflet-bar leaflet-control");
        const button = L.DomUtil.create("a", "", container) as HTMLAnchorElement;
        button.href = "#";
        button.title = "Fokus ke Boundary Layer";
        button.setAttribute("role", "button");
        button.setAttribute("aria-label", "Fokus ke Boundary Layer");
        button.style.fontSize = "18px";
        button.style.lineHeight = "30px";
        button.style.textAlign = "center";
        button.innerHTML = "&#8982;";
        L.DomEvent.disableClickPropagation(container);
        L.DomEvent.on(button, "click", (ev) => {
          L.DomEvent.preventDefault(ev);
          const idx = boundaryLayerIndexRef.current;
          if (idx === null) return;
          const layer = layerRefsRef.current.get(idx);
          if (!layer) return;
          const bounds = layer.getBounds();
          if (!bounds.isValid()) return;
          const fitZoom = map.getBoundsZoom(bounds);
          // Sembunyikan label permanen selama animasi agar tidak berat di setiap frame.
          const mapEl = map.getContainer();
          mapEl.classList.add("map-flying");
          map.once("moveend", () => mapEl.classList.remove("map-flying"));
          if (fitZoom < BOUNDARY_FOCUS_MIN_ZOOM) {
            map.flyTo(bounds.getCenter(), BOUNDARY_FOCUS_MIN_ZOOM, { duration: 1.6 });
          } else {
            map.flyToBounds(bounds, { maxZoom: BOUNDARY_FOCUS_MAX_ZOOM, duration: 1.6 });
          }
        });
        return container;
      },
    });

    const control = new FocusControl({ position: "bottomright" });
    control.addTo(map);
    return () => {
      control.remove();
    };
  }, []);

  // Zoom-out dibatasi agar hanya satu peta dunia yang terlihat (tidak berulang).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const worldBounds = L.latLngBounds([-85.0511, -180], [85.0511, 180]);
    const applyWorldMinZoom = () => {
      map.setMinZoom(map.getBoundsZoom(worldBounds, true));
    };

    map.setMaxBounds(worldBounds);
    applyWorldMinZoom();
    map.on("resize", applyWorldMinZoom);

    return () => {
      map.off("resize", applyWorldMinZoom);
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const group = dataLayerGroupRef.current;
    if (!map || !group || !projectPath) return;

    const activeMap = map;
    const activeGroup = group;
    const activeProjectPath = projectPath;

    let cancelled = false;

    async function loadLayers() {
      setIsLoading(true);
      setLayerErrors([]);
      activeGroup.clearLayers();
      layerRefsRef.current.clear();
      layerStyleRef.current.clear();
      featureLayerRefsRef.current.clear();
      layerGeojsonDataRef.current.clear();

      const errors: string[] = [];
      let boundaryGeoLayer: L.GeoJSON | null = null;

      const indexesToLoad = Array.from(
        new Set([
          ...selectedLayerIndexes,
          ...(boundaryLayerIndex !== null ? [boundaryLayerIndex] : []),
        ])
      );

      for (const index of indexesToLoad) {
        const layer = layers[index];
        if (!layer) continue;

        try {
          const geojsonText = await fetchLayerGeojson(activeProjectPath, layer.datasource);
          const geojsonData = JSON.parse(geojsonText);
          layerGeojsonDataRef.current.set(index, geojsonData);

          const isBoundary = index === boundaryLayerIndex;
          const layerColor = layerColors[index] ?? (isBoundary ? "#f97316" : "#2563eb");
          const layerOpacity = layerOpacities[index] ?? 0.35;
          const categoryOverrides = layerCategoryColors[index];
          const hasCategories = !!layer.categories && layer.categories.length > 0;
          const hasRanges = !!layer.ranges && layer.ranges.length > 0;
          const hasClassifiedStyle = hasCategories || hasRanges;
          const labeledFeatureIndexes = computeLabeledFeatureIndexes(layer, geojsonData);

          const style: L.StyleFunction = (feature) => {
            const resolvedColor = hasClassifiedStyle
              ? resolveFeatureColor(layer, categoryOverrides, feature, layerColor)
              : layerColor;
            return styleForLayer(resolvedColor, isBoundary, layerOpacity);
          };

          const geoLayer = L.geoJSON(geojsonData, {
            style,
            pointToLayer: (feature, latlng) => {
              const resolvedColor = hasClassifiedStyle
                ? resolveFeatureColor(layer, categoryOverrides, feature, layerColor)
                : layerColor;
              return L.circleMarker(latlng, {
                radius: layerPointSizes[index] ?? BASE_POINT_RADIUS,
                color: resolvedColor,
                fillOpacity: layerOpacity,
              });
            },
            onEachFeature: (feature, layerInstance) => {
              const featureIndex = geojsonData.features.indexOf(feature);
              const properties = feature.properties as Record<string, unknown> | null;

              if (!isBoundary && properties && Object.keys(properties).length > 0) {
                layerInstance.bindPopup(() => {
                  const selectedFields = visibleFieldsRef.current[index];
                  const aliases = fieldAliasesRef.current[index] ?? {};
                  const allKeys = Object.keys(properties);
                  const fieldsToShow = selectedFields
                    ? selectedFields.filter((f) => allKeys.includes(f))
                    : allKeys;

                  if (fieldsToShow.length === 0) {
                    return `<div class="feature-popup"><p class="feature-popup-empty">Tidak ada kolom yang dipilih untuk ditampilkan.</p></div>`;
                  }

                  const rows = fieldsToShow
                    .map((key) => {
                      const value = properties[key];
                      return `<tr><th>${escapeHtml(aliases[key] || key)}</th><td>${escapeHtml(
                        value === null || value === undefined ? "-" : String(value)
                      )}</td></tr>`;
                    })
                    .join("");

                  return `<div class="feature-popup"><table class="feature-popup-table">${rows}</table></div>`;
                }, { autoPan: false });
              }

              if (!isBoundary && featureIndex !== -1) {
                featureLayerRefsRef.current.set(`${index}:${featureIndex}`, layerInstance);
                layerInstance.on("click", (e: L.LeafletMouseEvent) => {
                  handleCycleClickRef.current?.(e);
                });
              }

              if (
                layer.labeling &&
                featureIndex !== -1 &&
                labeledFeatureIndexes.has(featureIndex)
              ) {
                const labelValue = properties?.[layer.labeling.field];
                const labelText =
                  labelValue === null || labelValue === undefined ? "" : String(labelValue);
                if (labelText) {
                  layerInstance.bindTooltip(escapeHtml(labelText), {
                    permanent: true,
                    direction: "center",
                    className: "layer-feature-label",
                  });
                  layerInstance.once("tooltipopen", (e: L.LeafletEvent) => {
                    const tooltipEl = (e as unknown as { tooltip: L.Tooltip }).tooltip.getElement();
                    if (tooltipEl) {
                      tooltipEl.style.fontSize = `${MAIN_MAP_LABEL_FONT_SIZE}px`;
                    }
                  });
                }
              }
            },
          });

          geoLayer.on("click", () => onFocusLayer(index));

          layerRefsRef.current.set(index, geoLayer);
          layerStyleRef.current.set(index, style);

          if (isBoundary) {
            boundaryGeoLayer = geoLayer;
          }

          if (selectedLayerIndexes.includes(index) || isBoundary) {
            geoLayer.addTo(activeGroup);
          }
        } catch (err) {
          let message: string;
          if (err instanceof Error) {
            message = err.message;
          } else if (typeof err === "string") {
            message = err;
          } else {
            try {
              message = JSON.stringify(err);
            } catch {
              message = "Terjadi error yang tidak diketahui";
            }
          }
          errors.push(`${layer.name}: ${message}`);
        }
      }

      if (!cancelled) {
        setLayerErrors(errors);
        setIsLoading(false);
        applyStackingOrder(layerOrderRef.current);

        if (boundaryGeoLayer && boundaryLayerIndex !== prevBoundaryLayerIndexRef.current) {
          const bounds = boundaryGeoLayer.getBounds();
          if (bounds.isValid()) {
            activeMap.flyToBounds(bounds, {
              maxZoom: BOUNDARY_FOCUS_MAX_ZOOM,
              duration: 2.4,
              easeLinearity: 0.08,
            });
          }
        }
        prevBoundaryLayerIndexRef.current = boundaryLayerIndex;
      }
    }

    loadLayers();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath, layers, selectedLayerIndexes, boundaryLayerIndex, layerColors, layerCategoryColors]);

  useEffect(() => {
    layerOrderRef.current = layerOrder;
    applyStackingOrder(layerOrder);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layerOrder]);

  // Opacity harus langsung terlihat begitu slider digeser, tanpa menunggu
  // effect loadLayers (yang berat: clear + rebuild semua layer, reset popup,
  // reset highlight). Jadi cukup panggil setStyle() ke layer yang sudah
  // terender, dengan opacity terbaru, tanpa fetch ulang atau rebuild apa pun.
  useEffect(() => {
    layerRefsRef.current.forEach((geoLayer, index) => {
      const layer = layers[index];
      if (!layer) return;

      const isBoundary = index === boundaryLayerIndex;
      const layerColor = layerColors[index] ?? (isBoundary ? "#f97316" : "#2563eb");
      const layerOpacity = layerOpacities[index] ?? 0.35;
      const categoryOverrides = layerCategoryColors[index];
      const hasCategories = !!layer.categories && layer.categories.length > 0;

      const style: L.StyleFunction = (feature) => {
        const resolvedColor = hasCategories
          ? resolveFeatureColor(layer, categoryOverrides, feature, layerColor)
          : layerColor;
        return styleForLayer(resolvedColor, isBoundary, layerOpacity);
      };

      geoLayer.setStyle(style);
      layerStyleRef.current.set(index, style);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layerOpacities]);

  // Opacity harus langsung terlihat begitu slider digeser, tanpa menunggu
  // effect loadLayers (yang berat: clear + rebuild semua layer, reset popup,
  // reset highlight). Jadi cukup panggil setStyle() ke layer yang sudah
  // terender, dengan opacity terbaru, tanpa fetch ulang atau rebuild apa pun.
  useEffect(() => {
    layerRefsRef.current.forEach((geoLayer, index) => {
      const layer = layers[index];
      if (!layer) return;

      const isBoundary = index === boundaryLayerIndex;
      const layerColor = layerColors[index] ?? (isBoundary ? "#f97316" : "#2563eb");
      const layerOpacity = layerOpacities[index] ?? 0.35;
      const categoryOverrides = layerCategoryColors[index];
      const hasCategories = !!layer.categories && layer.categories.length > 0;

      const style: L.StyleFunction = (feature) => {
        const resolvedColor = hasCategories
          ? resolveFeatureColor(layer, categoryOverrides, feature, layerColor)
          : layerColor;
        return styleForLayer(resolvedColor, isBoundary, layerOpacity);
      };

      geoLayer.setStyle(style);
      layerStyleRef.current.set(index, style);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layerOpacities]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || activeLayerIndex === null) return;

    const geoLayer = layerRefsRef.current.get(activeLayerIndex);
    if (!geoLayer) return;

    geoLayer.setStyle({ weight: 5 });

    const timeout = window.setTimeout(() => {
      const originalStyle = layerStyleRef.current.get(activeLayerIndex);
      if (originalStyle) {
        geoLayer.setStyle(originalStyle);
      }
    }, 900);

    return () => window.clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLayerIndex]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !activeFeature) return;
    if (featureDisplayMode === "card") return;

    const key = `${activeFeature.layerIndex}:${activeFeature.featureIndex}`;
    const layerInstance = featureLayerRefsRef.current.get(key);
    if (!layerInstance) return;

    const anyLayer = layerInstance as L.Layer & {
      getBounds?: () => L.LatLngBounds;
      getLatLng?: () => L.LatLng;
      openPopup: () => L.Layer;
    };

    anyLayer.openPopup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFeature, featureDisplayMode]);

  useEffect(() => {
    if (!activeFeature) return;

    const key = `${activeFeature.layerIndex}:${activeFeature.featureIndex}`;
    const layerInstance = featureLayerRefsRef.current.get(key);
    if (!layerInstance) return;

    const anyLayer = layerInstance as L.Layer & {
      getPopup?: () => L.Popup | undefined;
      isPopupOpen?: () => boolean;
      closePopup: () => L.Layer;
    };

    if (typeof anyLayer.isPopupOpen === "function" && anyLayer.isPopupOpen()) {
      if (featureDisplayMode === "card") {
        anyLayer.closePopup();
      } else {
        anyLayer.getPopup?.()?.update();
      }
    }
  }, [visibleFields, fieldAliases, activeFeature, featureDisplayMode]);

  // Visual feedback: feature yang diklik mendapat strong highlight,
  // feature lain di layer yang sama mendapat subtle highlight,
  // feature dari layer lain kembali ke style normal.
  // Generic: dikelompokkan berdasarkan layerIndex (key "layerIndex:featureIndex"),
  // bukan berdasarkan nama layer.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    featureLayerRefsRef.current.forEach((layerInstance, key) => {
      const [layerIndexStr, featureIndexStr] = key.split(":");
      const layerIndex = Number(layerIndexStr);
      const featureIndex = Number(featureIndexStr);

      const styleFnOrObj = layerStyleRef.current.get(layerIndex);
      if (!styleFnOrObj) return;

      const anyLayer = layerInstance as L.Path & { feature?: GeoJSON.Feature };
      if (typeof anyLayer.setStyle !== "function") return;

      const baseStyle =
        typeof styleFnOrObj === "function"
          ? styleFnOrObj(anyLayer.feature as GeoJSON.Feature)
          : styleFnOrObj;
      if (!baseStyle) return;

      if (!activeFeature || activeFeature.layerIndex !== layerIndex) {
        anyLayer.setStyle(baseStyle);
        return;
      }

      if (featureIndex === activeFeature.featureIndex) {
        anyLayer.setStyle(getStrongHighlightStyle(baseStyle));
        if (typeof (anyLayer as L.Path).bringToFront === "function") {
          (anyLayer as L.Path).bringToFront();
        }
      } else {
        anyLayer.setStyle(getSubtleHighlightStyle(baseStyle));
      }
    });
  }, [activeFeature]);

  // Safety-net: zoom cepat kadang membuat Leaflet me-redraw path SVG
  // sehingga style highlight sesaat hilang. Re-apply highlight setelah
  // zoom selesai, tanpa mengubah logic utama di atas.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const reapplyHighlight = () => {
      if (!activeFeature) return;

      featureLayerRefsRef.current.forEach((layerInstance, key) => {
        const [layerIndexStr, featureIndexStr] = key.split(":");
        const layerIndex = Number(layerIndexStr);
        const featureIndex = Number(featureIndexStr);

        if (layerIndex !== activeFeature.layerIndex) return;

        const styleFnOrObj = layerStyleRef.current.get(layerIndex);
        if (!styleFnOrObj) return;

        const anyLayer = layerInstance as L.Path & { feature?: GeoJSON.Feature };
        if (typeof anyLayer.setStyle !== "function") return;

        const baseStyle =
          typeof styleFnOrObj === "function"
            ? styleFnOrObj(anyLayer.feature as GeoJSON.Feature)
            : styleFnOrObj;
        if (!baseStyle) return;

        if (featureIndex === activeFeature.featureIndex) {
          anyLayer.setStyle(getStrongHighlightStyle(baseStyle));
          if (typeof anyLayer.bringToFront === "function") {
            anyLayer.bringToFront();
          }
        } else {
          anyLayer.setStyle(getSubtleHighlightStyle(baseStyle));
        }
      });
    };

    map.on("zoomend", reapplyHighlight);
    return () => {
      map.off("zoomend", reapplyHighlight);
    };
  }, [activeFeature]);

  return (
    <div className="map-view-wrapper">
      {isLoading && (
        <div className="map-status-banner">Memuat layer...</div>
      )}
      {layerErrors.length > 0 && (
        <div className="map-error-banner">
          <strong>Beberapa layer gagal dimuat:</strong>
          <ul>
            {layerErrors.map((err, i) => (
              <li key={i}>{err}</li>
            ))}
          </ul>
        </div>
      )}
      <div ref={containerRef} className="map-container" />
    </div>
  );
}

export default MapView;
