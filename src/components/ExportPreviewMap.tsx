import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import type { LayerInfo } from "./ProjectPanel";
import type { WebGisConfig, ExportConfig } from "./ConfigurationPanel";
import { getCachedGeojson } from "../lib/layerGeojsonCache";
import { styleForLayer, resolveFeatureColor, computeLabeledFeatureIndexes, getPreviewHighlightStyle, getStrongHighlightStyle } from "../lib/layerStyle";
import { getFeatureCandidates } from "../lib/featureHitTest";

interface ExportPreviewMapProps {
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
  config: WebGisConfig;
  exportConfig: ExportConfig;
  device?: "desktop" | "mobile";
}

// Preview export murni dari CACHE (hasil prefetch saat import), tidak pernah
// memanggil invoke/ogr2ogr, tidak menulis file apa pun. Layer yang belum ada
// di cache (gagal prefetch) di-skip diam-diam, bukan memicu fetch baru.
function ExportPreviewMap({
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
  config,
  exportConfig,
  device = "desktop",
}: ExportPreviewMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const boundaryBoundsRef = useRef<L.LatLngBounds | null>(null);
  const zoomRangeRef = useRef({ minZoom: exportConfig.minZoom, maxZoom: exportConfig.maxZoom });
  zoomRangeRef.current = { minZoom: exportConfig.minZoom, maxZoom: exportConfig.maxZoom };
  const featureLayersRef = useRef<Map<string, L.Layer>>(new Map());
  const geojsonRef = useRef<Map<number, GeoJSON.FeatureCollection>>(new Map());
  const styleRef = useRef<Map<number, L.StyleFunction>>(new Map());
  const hoveredKeyRef = useRef<string | null>(null);
  const selectedKeyRef = useRef<string | null>(null);
  const clearSelectionRef = useRef<() => void>(() => {});
  const cycleRef = useRef<{ point: L.Point | null; matches: { layerIndex: number; featureIndex: number }[]; index: number }>({
    point: null,
    matches: [],
    index: 0,
  });
  const ctxRef = useRef({ layers, layerOrder, layerVisibleFields, layerPointSizes, mode: exportConfig.featureDisplayMode });
  ctxRef.current = { layers, layerOrder, layerVisibleFields, layerPointSizes, mode: exportConfig.featureDisplayMode };
  const [card, setCard] = useState<{ layerName: string; rows: { key: string; value: string }[] } | null>(null);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, { zoomControl: true }).setView([-2.5, 118], 5);
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !projectPath) return;

    map.eachLayer((l) => {
      if (l instanceof L.TileLayer || l instanceof L.GeoJSON) map.removeLayer(l);
    });

    L.tileLayer(config.basemap === "custom" ? "" : basemapUrl(config.basemap), {
      attribution: "",
    }).addTo(map);

    const indexesSet = new Set([
      ...selectedLayerIndexes,
      ...(boundaryLayerIndex !== null ? [boundaryLayerIndex] : []),
    ]);
    const indexesToShow = [
      ...layerOrder.filter((idx) => indexesSet.has(idx)),
      ...Array.from(indexesSet).filter((idx) => !layerOrder.includes(idx)),
    ];

    const allBounds: L.LatLngBounds[] = [];
    boundaryBoundsRef.current = null;
    featureLayersRef.current.clear();
    geojsonRef.current.clear();
    styleRef.current.clear();
    hoveredKeyRef.current = null;
    selectedKeyRef.current = null;
    cycleRef.current = { point: null, matches: [], index: 0 };

    for (const index of indexesToShow) {
      const layer = layers[index];
      if (!layer) continue;
      const cached = getCachedGeojson(projectPath, layer.datasource);
      if (cached === null) continue;

      let data: GeoJSON.GeoJsonObject;
      try {
        data = JSON.parse(cached);
      } catch {
        continue;
      }

      const isBoundary = index === boundaryLayerIndex;
      const layerColor = layerColors[index] ?? (isBoundary ? "#f97316" : "#2563eb");
      const layerOpacity = layerOpacities[index] ?? 0.35;
      const categoryOverrides = layerCategoryColors[index];
      const hasCategories = !!layer.categories && layer.categories.length > 0;
      const hasRanges = !!layer.ranges && layer.ranges.length > 0;
      const hasClassifiedStyle = hasCategories || hasRanges;

      const style: L.StyleFunction = (feature) => {
        const resolvedColor = hasClassifiedStyle
          ? resolveFeatureColor(layer, categoryOverrides, feature, layerColor)
          : layerColor;
        const base = styleForLayer(resolvedColor, isBoundary, layerOpacity);
        // Boundary: fill hampir transparan agar area dalam polygon tetap menangkap klik.
        return isBoundary ? { ...base, fill: true, fillOpacity: 0.001 } : base;
      };

      styleRef.current.set(index, style);
      geojsonRef.current.set(index, data as GeoJSON.FeatureCollection);

      const labeledFeatureIndexes = computeLabeledFeatureIndexes(layer, data as GeoJSON.FeatureCollection);

      const geoLayer = L.geoJSON(data, {
        style,
        pointToLayer: (feature, latlng) => {
          const resolvedColor = hasClassifiedStyle
            ? resolveFeatureColor(layer, categoryOverrides, feature, layerColor)
            : layerColor;
          return L.circleMarker(latlng, {
            radius: layerPointSizes[index] ?? 5,
            color: resolvedColor,
            fillOpacity: layerOpacity,
          });
        },
        onEachFeature: (feature, layerInstance) => {
          const properties = feature.properties as Record<string, unknown> | null;
          const featureIndex = (data as GeoJSON.FeatureCollection).features.indexOf(feature);

          // Popup: sama seperti hasil export (field sesuai visible_fields).
          if (
            !isBoundary &&
            (exportConfig.featureDisplayMode === "popup" || exportConfig.featureDisplayMode === "both") &&
            properties &&
            Object.keys(properties).length > 0
          ) {
            layerInstance.bindPopup(() => {
              const selectedFields = layerVisibleFields[index];
              const allKeys = Object.keys(properties);
              const fieldsToShow = selectedFields
                ? selectedFields.filter((f) => allKeys.includes(f))
                : allKeys;
              if (fieldsToShow.length === 0) {
                return '<div class="feature-popup"><p class="feature-popup-empty">Tidak ada kolom yang dipilih untuk ditampilkan.</p></div>';
              }
              const rows = fieldsToShow
                .map((key) => {
                  const value = properties[key];
                  return `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(
                    value === null || value === undefined ? "-" : String(value)
                  )}</td></tr>`;
                })
                .join("");
              return `<div class="feature-popup"><table class="feature-popup-table">${rows}</table></div>`;
            }, { autoPan: false });
          }

          // Feature Information card (mode "card" / "both"): klik feature
          // menampilkan card ringan, sama seperti showFeatureCard() di
          // hasil export (app.js), bukan komponen FeatureInfoCard penuh
          // yang dipakai aplikasi utama (tidak ada edit kolom di preview).
          if (!isBoundary && featureIndex !== -1) {
            featureLayersRef.current.set(`${index}:${featureIndex}`, layerInstance);
          }

          // Labeling: sama seperti hasil export (tooltip permanent).
          if (layer.labeling && featureIndex !== -1 && labeledFeatureIndexes.has(featureIndex)) {
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
                  tooltipEl.style.fontSize = `${exportConfig.labelFontSize}px`;
                }
              });
            }
          }
        },
      }).addTo(map);

      const b = geoLayer.getBounds();
      if (b.isValid()) allBounds.push(b);
      if (isBoundary && b.isValid()) boundaryBoundsRef.current = b;
    }

    if (allBounds.length > 0) {
      const combined = allBounds.reduce((acc, b) => acc.extend(b), allBounds[0]);
      map.fitBounds(combined, { padding: [16, 16] });
    }
  }, [
    projectPath,
    layers,
    selectedLayerIndexes,
    boundaryLayerIndex,
    layerColors,
    layerCategoryColors,
    layerOpacities,
    layerPointSizes,
    layerOrder,
    config.basemap,
    exportConfig.featureDisplayMode,
    exportConfig.labelFontSize,
    layerVisibleFields,
  ]);

  // Smart hover + klik + click-cycle: memakai hit-test yang sama dengan Map utama.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const getCandidates = (latlng: L.LatLng) =>
      getFeatureCandidates({
        map,
        latlng,
        layerOrder: ctxRef.current.layerOrder,
        layerIndexes: geojsonRef.current.keys(),
        isLayerVisible: (i) => i !== boundaryLayerIndex,
        getGeojson: (i) => geojsonRef.current.get(i),
        getFeatureLayer: (k) => featureLayersRef.current.get(k),
      });

    type StyledLayer = L.Path & { feature?: GeoJSON.Feature; setRadius?: (r: number) => L.Layer };

    const restoreStyle = (key: string) => {
      const [li, fi] = key.split(":").map(Number);
      const inst = featureLayersRef.current.get(key) as StyledLayer | undefined;
      if (!inst) return;
      const geomType = geojsonRef.current.get(li)?.features[fi]?.geometry?.type;
      if ((geomType === "Point" || geomType === "MultiPoint") && typeof inst.setRadius === "function") {
        inst.setRadius(ctxRef.current.layerPointSizes[li] ?? 5);
      }
      const styleFn = styleRef.current.get(li);
      if (styleFn && typeof inst.setStyle === "function") {
        inst.setStyle(styleFn(inst.feature as GeoJSON.Feature));
      }
    };

    const applySelection = (key: string | null) => {
      const prev = selectedKeyRef.current;
      if (prev && prev !== key) restoreStyle(prev);
      selectedKeyRef.current = key;
      if (!key) return;
      const [li] = key.split(":").map(Number);
      const inst = featureLayersRef.current.get(key) as StyledLayer | undefined;
      const styleFn = styleRef.current.get(li);
      if (!inst || !styleFn || typeof inst.setStyle !== "function") return;
      inst.setStyle(getStrongHighlightStyle(styleFn(inst.feature as GeoJSON.Feature)));
      inst.bringToFront?.();
    };
    clearSelectionRef.current = () => applySelection(null);

    const clearHover = () => {
      const key = hoveredKeyRef.current;
      if (!key) return;
      hoveredKeyRef.current = null;
      if (key === selectedKeyRef.current) return;
      restoreStyle(key);
    };

    const applyHover = (key: string | null) => {
      if (key === hoveredKeyRef.current) return;
      clearHover();
      if (!key) return;
      const [li, fi] = key.split(":").map(Number);
      const inst = featureLayersRef.current.get(key) as StyledLayer | undefined;
      if (!inst) return;
      const geomType = geojsonRef.current.get(li)?.features[fi]?.geometry?.type;
      if (geomType === "Point" || geomType === "MultiPoint") {
        inst.setRadius?.((ctxRef.current.layerPointSizes[li] ?? 5) + 4);
      }
      const styleFn = styleRef.current.get(li);
      if (key !== selectedKeyRef.current && styleFn && typeof inst.setStyle === "function") {
        inst.setStyle(getPreviewHighlightStyle(styleFn(inst.feature as GeoJSON.Feature)));
      }
      hoveredKeyRef.current = key;
    };

    let rafId: number | null = null;
    const onMouseMove = (e: L.LeafletMouseEvent) => {
      if (rafId !== null) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        const top = getCandidates(e.latlng)[0];
        applyHover(top ? `${top.layerIndex}:${top.featureIndex}` : null);
      });
    };
    const onMouseOut = () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
      clearHover();
    };

    const onClick = (e: L.LeafletMouseEvent) => {
      const candidates = getCandidates(e.latlng);
      if (candidates.length === 0) return;

      const clickPoint = map.latLngToContainerPoint(e.latlng);
      const prev = cycleRef.current;
      const sameKeys =
        prev.matches.length === candidates.length &&
        prev.matches.every(
          (m, i) => m.layerIndex === candidates[i].layerIndex && m.featureIndex === candidates[i].featureIndex
        );
      const closeToPrev = prev.point ? prev.point.distanceTo(clickPoint) < 15 : false;
      const nextIndex = sameKeys && closeToPrev ? (prev.index + 1) % candidates.length : 0;
      cycleRef.current = {
        point: clickPoint,
        matches: candidates.map(({ layerIndex, featureIndex }) => ({ layerIndex, featureIndex })),
        index: nextIndex,
      };

      const sel = candidates[nextIndex];
      applySelection(`${sel.layerIndex}:${sel.featureIndex}`);
      const ctx = ctxRef.current;
      const layer = ctx.layers[sel.layerIndex];
      const props = (geojsonRef.current.get(sel.layerIndex)?.features[sel.featureIndex]?.properties ?? null) as
        | Record<string, unknown>
        | null;

      if (ctx.mode === "card" || ctx.mode === "both") {
        const selectedFields = ctx.layerVisibleFields[sel.layerIndex];
        const allKeys = props ? Object.keys(props) : [];
        const fieldsToShow = selectedFields ? selectedFields.filter((f) => allKeys.includes(f)) : allKeys;
        const rows = fieldsToShow.map((key) => {
          const value = props ? props[key] : undefined;
          return { key, value: value === null || value === undefined ? "-" : String(value) };
        });
        setCard({ layerName: layer?.name ?? "", rows });
      } else {
        setCard(null);
      }

      map.closePopup();
      if (ctx.mode === "popup" || ctx.mode === "both") {
        (sel.layerInstance as L.Layer & { openPopup?: (ll?: L.LatLng) => L.Layer }).openPopup?.(e.latlng);
      }
    };

    map.on("mousemove", onMouseMove);
    map.on("mouseout", onMouseOut);
    map.on("click", onClick);
    return () => {
      if (rafId !== null) window.cancelAnimationFrame(rafId);
      map.off("mousemove", onMouseMove);
      map.off("mouseout", onMouseOut);
      map.off("click", onClick);
    };
  }, []);

  // Tombol 1 klik: fokus ke Boundary Layer, zoom hasil dijepit ke rentang
  // Minimum/Maximum Zoom dari Export Configuration.
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
          const bounds = boundaryBoundsRef.current;
          if (!bounds || !bounds.isValid()) return;
          const { minZoom, maxZoom } = zoomRangeRef.current;
          const mapEl = map.getContainer();
          mapEl.classList.add("map-flying");
          map.once("moveend", () => mapEl.classList.remove("map-flying"));
          const fitZoom = map.getBoundsZoom(bounds);
          if (fitZoom < minZoom) {
            map.flyTo(bounds.getCenter(), minZoom, { duration: 1.6 });
          } else {
            map.flyToBounds(bounds, { maxZoom, duration: 1.6 });
          }
        });
        return container;
      },
    });

    const control = new FocusControl({ position: "topleft" });
    control.addTo(map);
    const el = control.getContainer();
    const zoomEl = map.zoomControl?.getContainer();
    if (el && zoomEl && zoomEl.parentNode) {
      zoomEl.parentNode.insertBefore(el, zoomEl);
    }
    return () => {
      control.remove();
    };
  }, []);

  // Batas zoom Preview. Saat Minimum Zoom berubah, peta bergerak (maju atau
  // mundur) ke level Minimum Zoom baru dengan animasi; durasi mengikuti jarak.
  // Saat Maximum Zoom berubah, peta hanya dijepit bila melewati batas.
  const prevMinZoomRef = useRef<number | null>(null);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const { minZoom, maxZoom } = exportConfig;
    map.setMinZoom(minZoom);
    map.setMaxZoom(maxZoom);

    const minChanged = prevMinZoomRef.current !== null && prevMinZoomRef.current !== minZoom;
    prevMinZoomRef.current = minZoom;

    const timeout = window.setTimeout(() => {
      const currentZoom = map.getZoom();
      const target = minChanged
        ? minZoom
        : Math.min(maxZoom, Math.max(minZoom, currentZoom));
      if (target === currentZoom) return;
      const duration = Math.min(2.5, Math.max(0.5, 0.4 + 0.12 * Math.abs(target - currentZoom)));
      map.flyTo(map.getCenter(), target, { duration });
    }, 250);

    return () => window.clearTimeout(timeout);
  }, [exportConfig.minZoom, exportConfig.maxZoom, projectPath]);

  useEffect(() => {
    const t = window.setTimeout(() => mapRef.current?.invalidateSize(), 50);
    return () => window.clearTimeout(t);
  }, [device]);

  return (
    <div className="export-preview-map-wrap">
      <div ref={containerRef} className="export-preview-map" />
      {card && (
        <div className="export-preview-feature-card">
          <div className="export-preview-feature-card-header">
            <div>
              <p className="export-preview-feature-card-title">Feature Information</p>
              <p className="export-preview-feature-card-subtitle">{card.layerName}</p>
            </div>
            <button type="button" onClick={() => { setCard(null); clearSelectionRef.current(); }}>&times;</button>
          </div>
          <table className="feature-popup-table">
            <tbody>
              {card.rows.length === 0 ? (
                <tr><td>Tidak ada atribut.</td></tr>
              ) : (
                card.rows.map((r) => (
                  <tr key={r.key}><th>{r.key}</th><td>{r.value}</td></tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function basemapUrl(basemap: WebGisConfig["basemap"]): string {
  switch (basemap) {
    case "satellite":
      return "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
    case "topo":
      return "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png";
    default:
      return "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
  }
}

export default ExportPreviewMap;
