import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import { getCachedGeojson, fetchLayerGeojson } from "../lib/layerGeojsonCache";
import { styleForLayer, resolveFeatureColor, computeLabeledFeatureIndexes } from "../lib/layerStyle";
import type { LayerInfo } from "./ProjectPanel";
import {
  prepareRasterPreview,
  rasterClassColors,
  rasterTileUrl,
  type RasterTilesResult,
} from "../lib/rasterTiles";

// Cache hasil tile raster per layer + kombinasi warna (hover berikutnya instan)
const rasterPreviewCache = new Map<string, RasterTilesResult>();

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

interface LayerPreviewProps {
  projectPath: string;
  datasource: string;
  layer: LayerInfo;
  fallbackColor: string;
  categoryColorOverrides?: Record<string, string>;
  name: string;
  visible: boolean;
  labelFontSize?: number;
}

function LayerPreview({
  projectPath,
  datasource,
  layer,
  fallbackColor,
  categoryColorOverrides,
  name,
  visible,
  labelFontSize = 13,
}: LayerPreviewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const vectorLayerRef = useRef<L.GeoJSON | null>(null);
  const rasterLayerRef = useRef<L.TileLayer | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Buat instance Leaflet map hanya SEKALI selama komponen ini hidup (tidak
  // pernah di-unmount oleh parent lagi), supaya tile basemap tidak perlu
  // dimuat ulang dari nol setiap kali user hover ke layer lain.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current, {
      zoomControl: false,
      attributionControl: false,
      dragging: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      boxZoom: false,
      keyboard: false,
    });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png").addTo(map);
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Setiap datasource/layer/fallbackColor/categoryColorOverrides berganti,
  // cukup ganti layer vektornya saja di atas map yang sudah ada (bukan
  // membuat map baru), lalu re-style per-feature memakai logic yang sama
  // dengan map utama (resolveFeatureColor + styleForLayer).
  useEffect(() => {
    if (layer.kind === "raster") return;
    if (rasterLayerRef.current && mapRef.current) {
      mapRef.current.removeLayer(rasterLayerRef.current);
      rasterLayerRef.current = null;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);

    const hasCategories = !!layer.categories && layer.categories.length > 0;
    const hasRanges = !!layer.ranges && layer.ranges.length > 0;
    const hasClassifiedStyle = hasCategories || hasRanges;

    function applyData(text: string) {
      if (cancelled || !mapRef.current) return;
      const data = JSON.parse(text);

      if (vectorLayerRef.current) {
        mapRef.current.removeLayer(vectorLayerRef.current);
        vectorLayerRef.current = null;
      }

      const style: L.StyleFunction = (feature) => {
        const resolvedColor = hasClassifiedStyle
          ? resolveFeatureColor(layer, categoryColorOverrides, feature, fallbackColor)
          : fallbackColor;
        return styleForLayer(resolvedColor, false, 0.5);
      };

      const labeledFeatureIndexes = computeLabeledFeatureIndexes(layer, data);

      const geoLayer = L.geoJSON(data, {
        style,
        pointToLayer: (feature, latlng) => {
          const resolvedColor = hasClassifiedStyle
            ? resolveFeatureColor(layer, categoryColorOverrides, feature, fallbackColor)
            : fallbackColor;
          return L.circleMarker(latlng, { radius: 4, color: resolvedColor, fillOpacity: 0.7 });
        },
        onEachFeature: (feature, layerInstance) => {
          if (!layer.labeling) return;
          const featureIndex = data.features.indexOf(feature);
          if (featureIndex === -1 || !labeledFeatureIndexes.has(featureIndex)) return;

          const labelValue = feature.properties?.[layer.labeling.field];
          const labelText =
            labelValue === null || labelValue === undefined ? "" : String(labelValue);
          if (!labelText) return;

          layerInstance.bindTooltip(escapeHtml(labelText), {
            permanent: true,
            direction: "center",
            className: "layer-feature-label",
          });
          layerInstance.once("tooltipopen", (e: L.LeafletEvent) => {
            const tooltipEl = (e as unknown as { tooltip: L.Tooltip }).tooltip.getElement();
            if (tooltipEl) {
              tooltipEl.style.fontSize = `${labelFontSize}px`;
            }
          });
        },
      }).addTo(mapRef.current);
      vectorLayerRef.current = geoLayer;

      const bounds = geoLayer.getBounds();
      if (bounds.isValid()) {
        mapRef.current.fitBounds(bounds, { padding: [12, 12] });
      } else {
        mapRef.current.setView([0, 0], 2);
      }
      setLoading(false);
    }

    const cached = getCachedGeojson(projectPath, datasource);
    if (cached !== null) {
      applyData(cached);
    } else {
      fetchLayerGeojson(projectPath, datasource)
        .then((text) => {
          if (!cancelled) applyData(text);
        })
        .catch((err) => {
          if (!cancelled) {
            setError(String(err));
            setLoading(false);
          }
        });
    }

    return () => {
      cancelled = true;
    };
  }, [projectPath, datasource, layer, fallbackColor, categoryColorOverrides]);

  useEffect(() => {
    if (layer.kind !== "raster") return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    const colors = rasterClassColors(layer, categoryColorOverrides);
    const key = `${layer.datasource}|${JSON.stringify(colors)}`;
    const categorical = colors.length > 0 || !!layer.raster?.has_color_table;

    function show(result: RasterTilesResult) {
      const map = mapRef.current;
      if (cancelled || !map) return;
      if (vectorLayerRef.current) {
        map.removeLayer(vectorLayerRef.current);
        vectorLayerRef.current = null;
      }
      if (rasterLayerRef.current) {
        map.removeLayer(rasterLayerRef.current);
        rasterLayerRef.current = null;
      }
      const tl = L.tileLayer(rasterTileUrl(result), {
        minZoom: result.min_zoom,
        maxNativeZoom: result.max_zoom,
        maxZoom: 22,
        className: categorical ? "raster-pixelated" : "",
      }).addTo(map);
      rasterLayerRef.current = tl;
      map.fitBounds(
        [[result.south, result.west], [result.north, result.east]],
        { padding: [12, 12] }
      );
      setLoading(false);
    }

    const cached = rasterPreviewCache.get(key);
    if (cached) {
      show(cached);
    } else {
      prepareRasterPreview(layer, colors)
        .then((result) => {
          rasterPreviewCache.set(key, result);
          show(result);
        })
        .catch((err) => {
          if (!cancelled) {
            setError(String(err));
            setLoading(false);
          }
        });
    }

    return () => {
      cancelled = true;
    };
  }, [layer, categoryColorOverrides]);

  return (
    <div className={"layer-preview-thumb" + (visible ? " layer-preview-thumb--visible" : "")}>
      <div className="layer-preview-header">
        <span className="layer-preview-color-dot" style={{ backgroundColor: fallbackColor }} />
        <span className="layer-preview-name">{name}</span>
      </div>
      <div className="layer-preview-map-wrap">
        {loading && (
          <div className="layer-preview-status">
            <span className="layer-preview-spinner" />
            Memuat preview...
          </div>
        )}
        {error && (
          <div className="layer-preview-status layer-preview-status--error">
            Gagal memuat preview
          </div>
        )}
        <div ref={containerRef} className="layer-preview-map" />
      </div>
    </div>
  );
}

export default LayerPreview;
