import type L from "leaflet";
import area from "@turf/area";
import type { LayerInfo } from "../components/ProjectPanel";

// Menentukan feature mana saja (by index) yang berhak dapat label, meniru
// filter QGIS "$area = maximum($area, group_by:=...)" — hanya 1 feature per
// grup (yang luasnya paling besar) yang diberi label. Kalau layer tidak
// punya group_by_field, semua feature yang punya nilai field label dianggap
// berhak (labeling QGIS type="simple" tampil di semua feature).
export function computeLabeledFeatureIndexes(
  layer: LayerInfo,
  geojsonData: GeoJSON.FeatureCollection
): Set<number> {
  const result = new Set<number>();
  if (!layer.labeling) return result;

  const { group_by_field } = layer.labeling;

  if (!group_by_field) {
    geojsonData.features.forEach((_, idx) => result.add(idx));
    return result;
  }

  const largestByGroup = new Map<string, { index: number; area: number }>();

  geojsonData.features.forEach((feature, idx) => {
    const rawGroupValue = feature.properties?.[group_by_field];
    const groupKey = rawGroupValue === null || rawGroupValue === undefined
      ? "NULL"
      : String(rawGroupValue);

    let featureArea = 0;
    try {
      featureArea = area(feature as GeoJSON.Feature);
    } catch {
      featureArea = 0;
    }

    const current = largestByGroup.get(groupKey);
    if (!current || featureArea > current.area) {
      largestByGroup.set(groupKey, { index: idx, area: featureArea });
    }
  });

  largestByGroup.forEach(({ index }) => result.add(index));
  return result;
}

export function isClassifiedLayer(layer: LayerInfo): boolean {
  return (
    !!layer.category_field &&
    ((layer.categories?.length ?? 0) > 0 || (layer.ranges?.length ?? 0) > 0)
  );
}

// Layer berkategori/berentang: isian memakai warna kelas, garis tepi gelap
// tipis. Layer satu warna dan Boundary tetap memakai gaya lama.
export function styleForLayer(
  color: string,
  isBoundary: boolean,
  fillOpacity: number,
  classified = false
): L.PathOptions {
  if (isBoundary) return { color, weight: 2, fillOpacity: 0 };
  if (classified) {
    return { color: "#1f2937", weight: 0.8, fillColor: color, fillOpacity };
  }
  return { color, weight: 1.5, fillOpacity };
}

export function resolveFeatureColor(
  layer: LayerInfo,
  categoryColorOverrides: Record<string, string> | undefined,
  feature: GeoJSON.Feature | undefined,
  fallbackColor: string
): string {
  // Categorized renderer (warna per nilai diskrit)
  if (layer.categories && layer.categories.length > 0 && layer.category_field) {
    const rawValue = feature?.properties?.[layer.category_field];
    const valueKey = rawValue === null || rawValue === undefined ? "NULL" : String(rawValue);

    const override = categoryColorOverrides?.[valueKey];
    if (override) return override;

    const matched = layer.categories.find((cat) => cat.value === valueKey);
    if (matched) return matched.color;

    return fallbackColor;
  }

  // Graduated renderer (warna per rentang angka). Field sumber nilainya sama
  // dengan category_field (di QGIS keduanya memakai atribut "attr" pada
  // <renderer-v2>, diparse ke field yang sama di backend).
  if (layer.ranges && layer.ranges.length > 0 && layer.category_field) {
    const rawValue = feature?.properties?.[layer.category_field];
    const numericValue = typeof rawValue === "number" ? rawValue : parseFloat(String(rawValue));
    if (!Number.isNaN(numericValue)) {
      const matched = layer.ranges.find(
        (r) => numericValue >= r.lower && numericValue <= r.upper
      );
      if (matched) {
        const override = categoryColorOverrides?.[matched.label];
        if (override) return override;
        return matched.color;
      }
    }
    return fallbackColor;
  }

  return fallbackColor;
}

export function getStrongHighlightStyle(base: L.PathOptions): L.PathOptions {
  return {
    ...base,
    weight: (base.weight ?? 1.5) + 3,
    color: "#facc15",
    fillOpacity: Math.min((base.fillOpacity ?? 0.35) + 0.25, 0.85),
    dashArray: undefined,
  };
}

export function getSubtleHighlightStyle(base: L.PathOptions): L.PathOptions {
  return {
    ...base,
    weight: (base.weight ?? 1.5) + 1.5,
    fillOpacity: Math.min((base.fillOpacity ?? 0.35) + 0.1, 0.7),
  };
}

// Preview hover: visual sementara yang berbeda dari highlight seleksi
// (getStrongHighlightStyle/getSubtleHighlightStyle), supaya user bisa
// membedakan "sedang di-hover" vs "sudah dipilih/diklik".
export function getPreviewHighlightStyle(base: L.PathOptions): L.PathOptions {
  return {
    ...base,
    weight: (base.weight ?? 1.5) + 2,
    color: "#3b82f6",
    dashArray: "4 3",
    fillOpacity: Math.min((base.fillOpacity ?? 0.35) + 0.1, 0.65),
  };
}
