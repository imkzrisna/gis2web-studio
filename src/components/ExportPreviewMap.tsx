import ExportPreviewLegend from "./ExportPreviewLegend";
import { attachLabelDrag, isLabelPositionAllowed, type LabelDragCtx } from "../lib/labelDrag";
import type { LabelPositions } from "../lib/labelPositions";
import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import { scaleBarGradient, createFixedScaleControl } from "../lib/scaleBar";
import type { LayerInfo } from "./ProjectPanel";
import type { WebGisConfig, ExportConfig } from "./ConfigurationPanel";
import { getCachedGeojson } from "../lib/layerGeojsonCache";
import { prepareRasterPreview, rasterClassColors, rasterTileUrl } from "../lib/rasterTiles";
import { styleForLayer, isClassifiedLayer, resolveFeatureColor, computeLabeledFeatureIndexes, getPreviewHighlightStyle, getStrongHighlightStyle } from "../lib/layerStyle";
import { getFeatureCandidates } from "../lib/featureHitTest";

interface ExportPreviewMapProps {
  projectPath: string | null;
  layers: LayerInfo[];
  selectedLayerIndexes: number[];
  boundaryLayerIndex: number | null;
  labelPositions: LabelPositions;
  onLabelPositionsChange: (positions: LabelPositions) => void;
  layerColors: Record<number, string>;
  layerCategoryColors: Record<number, Record<string, string>>;
  layerOpacities: Record<number, number>;
  layerPointSizes: Record<number, number>;
  layerOrder: number[];
  layerVisibleFields: Record<number, string[]>;
  layerFieldAliases: Record<number, Record<string, string>>;
  config: WebGisConfig;
  exportConfig: ExportConfig;
  device?: "desktop" | "mobile";
  labelEdit?: boolean;
}

// Preview export murni dari CACHE (hasil prefetch saat import), tidak pernah
// memanggil invoke/ogr2ogr, tidak menulis file apa pun. Layer yang belum ada
// di cache (gagal prefetch) di-skip diam-diam, bukan memicu fetch baru.
function ExportPreviewMap({
  projectPath,
  layers,
  selectedLayerIndexes,
  boundaryLayerIndex,
  labelPositions,
  onLabelPositionsChange,
  layerColors,
  layerCategoryColors,
  layerOpacities,
  layerPointSizes,
  layerOrder,
  layerVisibleFields,
  layerFieldAliases,
  config,
  exportConfig,
  device = "desktop",
  labelEdit = false,
}: ExportPreviewMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const boundaryBoundsRef = useRef<L.LatLngBounds | null>(null);
  const hiddenBoundaryRef = useRef<number | null>(null);
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
  const ctxRef = useRef({ layers, layerOrder, layerVisibleFields, layerFieldAliases, layerPointSizes });
  ctxRef.current = { layers, layerOrder, layerVisibleFields, layerFieldAliases, layerPointSizes };
  const labelEditRef = useRef(false);
  const labelPositionsRef = useRef<LabelPositions>(labelPositions);
  const onLabelPositionsChangeRef = useRef(onLabelPositionsChange);
  labelEditRef.current = labelEdit;
  labelPositionsRef.current = labelPositions;
  onLabelPositionsChangeRef.current = onLabelPositionsChange;
  const labelDragCtx: LabelDragCtx = {
    getMap: () => mapRef.current,
    isEditing: () => labelEditRef.current,
    getPositions: () => labelPositionsRef.current,
    setPositions: (p) => onLabelPositionsChangeRef.current(p),
  };
  const [card, setCard] = useState<{ layerName: string; layerIndex: number; featureIndex: number; rows: { key: string; label: string; value: string }[] } | null>(null);
  const [tableOpen, setTableOpen] = useState(false);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, { zoomControl: false, doubleClickZoom: false }).setView([-2.5, 118], 5);
    L.control.zoom({ position: "bottomright" }).addTo(map);
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
      if (l instanceof L.TileLayer && (l.options as L.TileLayerOptions).pane === "rasterPane") return;
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
    hiddenBoundaryRef.current =
      boundaryLayerIndex !== null && !selectedLayerIndexes.includes(boundaryLayerIndex) ? boundaryLayerIndex : null;
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

      const isBoundary = index === boundaryLayerIndex && !selectedLayerIndexes.includes(index);
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
        const base = styleForLayer(resolvedColor, isBoundary, layerOpacity, isClassifiedLayer(layer));
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
                const tooltip = (e as unknown as { tooltip: L.Tooltip }).tooltip;
                const tooltipEl = tooltip.getElement();
                const labelKey = `${index}:${featureIndex}`;
                const saved = labelPositionsRef.current[labelKey];
                if (saved && isLabelPositionAllowed(feature.geometry, saved[0], saved[1])) {
                  tooltip.setLatLng(L.latLng(saved[0], saved[1]));
                }
                if (tooltipEl) {
                  tooltipEl.style.fontSize = `${exportConfig.labelFontSize}px`;
                  attachLabelDrag(tooltipEl, tooltip, layerInstance, labelKey, labelDragCtx, feature.geometry);
                }
              });
            }
          }
        },
      }).addTo(map);

      const b = geoLayer.getBounds();
      if (b.isValid()) allBounds.push(b);
      if (index === boundaryLayerIndex && b.isValid()) boundaryBoundsRef.current = b;
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
    exportConfig.labelFontSize,
    layerVisibleFields,
  ]);

  // ---- Raster overlay: pane di atas basemap (200) dan di bawah vektor (400).
  const rasterTileRefs = useRef<Map<number, L.TileLayer>>(new Map());
  const rasterKeyRef = useRef<Map<number, string>>(new Map());
  const opacityRef = useRef(layerOpacities);
  opacityRef.current = layerOpacities;
  const orderRef = useRef(layerOrder);
  orderRef.current = layerOrder;

  function applyRasterZ() {
    rasterTileRefs.current.forEach((tl, idx) => {
      const pos = orderRef.current.indexOf(idx);
      tl.setZIndex(100 - (pos < 0 ? 99 : pos));
    });
  }

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !projectPath) return;
    if (!map.getPane("rasterPane")) map.createPane("rasterPane").style.zIndex = "250";
    const wanted = selectedLayerIndexes.filter((i) => layers[i]?.kind === "raster");
    rasterTileRefs.current.forEach((tl, idx) => {
      if (!wanted.includes(idx)) {
        map.removeLayer(tl);
        rasterTileRefs.current.delete(idx);
        rasterKeyRef.current.delete(idx);
      }
    });
    if (wanted.length === 0) return;

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      for (const idx of wanted) {
        const layer = layers[idx];
        if (!layer) continue;
        const colors = rasterClassColors(layer, layerCategoryColors[idx]);
        const key = `${layer.datasource}|${colors.map((c) => `${c.value}:${c.color}`).join(",")}`;
        if (rasterKeyRef.current.get(idx) === key && rasterTileRefs.current.has(idx)) continue;
        try {
          const result = await prepareRasterPreview(layer, colors);
          if (cancelled) return;
          const categorical = colors.length > 0 || !!layer.raster?.has_color_table;
          const bounds = L.latLngBounds([result.south, result.west], [result.north, result.east]);
          const tl = L.tileLayer(rasterTileUrl(result), {
            pane: "rasterPane",
            bounds,
            minNativeZoom: result.min_zoom,
            maxNativeZoom: result.max_zoom,
            minZoom: 0,
            maxZoom: 22,
            opacity: opacityRef.current[idx] ?? 1,
            className: categorical ? "raster-pixelated" : "",
          });
          const old = rasterTileRefs.current.get(idx);
          tl.addTo(map);
          if (old) map.removeLayer(old);
          rasterTileRefs.current.set(idx, tl);
          rasterKeyRef.current.set(idx, key);
          if (!old && geojsonRef.current.size === 0) map.fitBounds(bounds, { padding: [16, 16] });
        } catch (err) {
          console.error("Raster preview gagal:", layer.name, err);
        }
      }
      if (!cancelled) applyRasterZ();
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath, layers, selectedLayerIndexes, layerCategoryColors]);

  useEffect(() => {
    rasterTileRefs.current.forEach((tl, idx) => tl.setOpacity(layerOpacities[idx] ?? 1));
  }, [layerOpacities]);

  useEffect(() => {
    applyRasterZ();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layerOrder]);

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
        isLayerVisible: (i) => i !== hiddenBoundaryRef.current,
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
      if (labelEditRef.current) return;
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
      if (labelEditRef.current) return;
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

      const selectedFields = ctx.layerVisibleFields[sel.layerIndex];
      const allKeys = props ? Object.keys(props) : [];
      const fieldsToShow = selectedFields ? selectedFields.filter((f) => allKeys.includes(f)) : allKeys;
      const aliases = ctx.layerFieldAliases[sel.layerIndex] ?? {};
      const rows = fieldsToShow.map((key) => {
        const value = props ? props[key] : undefined;
        return { key, label: aliases[key] || key, value: value === null || value === undefined ? "-" : String(value) };
      });
      setCard({ layerName: layer?.name ?? "", layerIndex: sel.layerIndex, featureIndex: sel.featureIndex, rows });
      map.closePopup();
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

    const control = new FocusControl({ position: "bottomright" });
    control.addTo(map);
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
    const map = mapRef.current;
    if (!map || !exportConfig.showScaleBar) return;
    const control = createFixedScaleControl(exportConfig.scaleBarSegments).addTo(map);
    const line = control.getContainer()?.querySelector<HTMLElement>(".leaflet-control-scale-line");
    line?.style.setProperty("--sb-bg", scaleBarGradient(exportConfig.scaleBarSegments));
    return () => {
      control.remove();
    };
  }, [exportConfig.showScaleBar, exportConfig.scaleBarSegments]);

  useEffect(() => {
    const t = window.setTimeout(() => mapRef.current?.invalidateSize(), 50);
    return () => window.clearTimeout(t);
  }, [device]);

  return (
    <div className={"export-preview-map-wrap" + (labelEdit ? " label-edit-mode" : "")}>
      <div ref={containerRef} className="export-preview-map" />
      {exportConfig.showLegend && (
        <ExportPreviewLegend
          layers={layers}
          indexes={[
            ...layerOrder.filter((i) => selectedLayerIndexes.includes(i) || i === boundaryLayerIndex),
            ...[...selectedLayerIndexes, ...(boundaryLayerIndex !== null ? [boundaryLayerIndex] : [])].filter(
              (i, pos, arr) => !layerOrder.includes(i) && arr.indexOf(i) === pos
            ),
          ]}
          boundaryLayerIndex={boundaryLayerIndex !== null && !selectedLayerIndexes.includes(boundaryLayerIndex) ? boundaryLayerIndex : null}
          layerColors={layerColors}
          layerCategoryColors={layerCategoryColors}
          layerOpacities={layerOpacities}
        />
      )}
      {card && (
        <div className="export-preview-feature-card">
          <div className="export-preview-feature-card-header">
            <div>
              <p className="export-preview-feature-card-title">Feature Information</p>
              <p className="export-preview-feature-card-subtitle">{card.layerName}</p>
            </div>
            <button type="button" onClick={() => { setCard(null); setTableOpen(false); clearSelectionRef.current(); }}>&times;</button>
          </div>
          <table className="feature-popup-table">
            <tbody>
              {card.rows.length === 0 ? (
                <tr><td>Tidak ada atribut.</td></tr>
              ) : (
                card.rows.map((r) => (
                  <tr key={r.key}><th>{r.label}</th><td>{r.value}</td></tr>
                ))
              )}
            </tbody>
          </table>
          {exportConfig.showFullTable && (
            <div className="export-preview-feature-card-footer">
              <button type="button" className="export-preview-full-table-btn" onClick={() => setTableOpen(true)}>Lihat tabel lengkap</button>
            </div>
          )}
        </div>
      )}
      {card && tableOpen && exportConfig.showFullTable && (() => {
        const fc = geojsonRef.current.get(card.layerIndex);
        const features = fc?.features ?? [];
        const fields: string[] = [];
        features.forEach((f) => {
          Object.keys((f.properties ?? {}) as Record<string, unknown>).forEach((k) => {
            if (!fields.includes(k)) fields.push(k);
          });
        });
        return (
          <div className="export-preview-table-panel">
            <div className="export-preview-table-header">
              <span><strong>Attribute Table</strong> {card.layerName} · {features.length} fitur</span>
              <button type="button" onClick={() => setTableOpen(false)} title="Tutup">{"\u25BC"}</button>
            </div>
            <div className="export-preview-table-scroll">
              <table className="attribute-data-table">
                <thead>
                  <tr>{fields.map((f) => <th key={f}>{f}</th>)}</tr>
                </thead>
                <tbody>
                  {features.map((f, i) => (
                    <tr key={i} className={i === card.featureIndex ? "active-row" : undefined}>
                      {fields.map((k) => {
                        const v = (f.properties as Record<string, unknown> | null)?.[k];
                        return <td key={k}>{v === null || v === undefined ? "-" : String(v)}</td>;
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}
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
