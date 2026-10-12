import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import type { CategoryInfo, LayerInfo } from "../components/ProjectPanel";
import { PALETTE } from "./autoCategories";

export interface RasterTilesResult {
  tiles_dir: string;
  tile_url_template: string;
  south: number;
  west: number;
  north: number;
  east: number;
  min_zoom: number;
  max_zoom: number;
  tile_count: number;
}

export interface RasterClassColor {
  value: number;
  color: string;
}

interface RasterClassValue {
  value: number;
  count: number;
}

// Daftar kelas raster (nilai unik) dengan palet awal. Pengguna dapat mengubah
// warnanya lewat UI kategori yang sama dengan layer vektor.
export async function fetchRasterClassCategories(path: string): Promise<CategoryInfo[] | null> {
  try {
    const values = await invoke<RasterClassValue[]>("raster_class_values", { rasterPath: path });
    if (values.length === 0) return null;
    return values.map((v, i) => ({
      value: String(v.value),
      label: String(v.value),
      color: PALETTE[i % PALETTE.length],
    }));
  } catch {
    return null;
  }
}

export function rasterClassColors(
  layer: LayerInfo,
  overrides: Record<string, string> | undefined
): RasterClassColor[] {
  return (layer.categories ?? [])
    .map((c) => ({ value: Number(c.value), color: overrides?.[c.value] ?? c.color }))
    .filter((c) => Number.isFinite(c.value));
}

export async function prepareRasterPreview(
  layer: LayerInfo,
  colors: RasterClassColor[]
): Promise<RasterTilesResult> {
  const outDir = await invoke<string>("raster_preview_dir");
  const categorical = colors.length > 0 || !!layer.raster?.has_color_table;
  return invoke<RasterTilesResult>("prepare_raster_tiles", {
    rasterPath: layer.datasource,
    outDir,
    slug: `${layer.name}_${Date.now().toString(36)}`,
    minZoom: 10,
    maxZoom: 22,
    categorical,
    colors,
  });
}

export function rasterTileUrl(result: RasterTilesResult): string {
  return `${convertFileSrc(result.tiles_dir)}/{z}/{x}/{y}.png`;
}
