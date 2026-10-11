import { invoke } from "@tauri-apps/api/core";
import type { LayerInfo, RasterMeta } from "../components/ProjectPanel";

export type ScanStatus = "ok" | "warning" | "error";

export interface ScannedDataset {
  name: string;
  kind: "vector" | "raster";
  format: "shapefile" | "geotiff" | "geojson" | "geopackage";
  path: string;
  relative_path: string;
  layer_name: string | null;
  geometry_type: LayerInfo["geometry_type"] | null;
  crs: string | null;
  status: ScanStatus;
  messages: string[];
  companion_files: string[];
  raster: RasterMeta | null;
}

export interface FolderScanResult {
  folder: string;
  datasets: ScannedDataset[];
  truncated: boolean;
}

export function scanGisFolder(folder: string): Promise<FolderScanResult> {
  return invoke<FolderScanResult>("scan_gis_folder", { folder });
}

// Dataset valid (status ok/warning) menjadi layer internal. Dataset berstatus
// "error" tidak dijadikan layer; alasannya tetap ditampilkan di hasil scan.
export function datasetsToLayers(datasets: ScannedDataset[]): LayerInfo[] {
  return datasets
    .filter((d) => d.status !== "error")
    .map((d): LayerInfo => {
      const isRaster = d.kind === "raster";
      const datasource =
        d.format === "geopackage" && d.layer_name
          ? `${d.path}|layername=${d.layer_name}`
          : d.path;
      return {
        name: d.name,
        geometry_type: isRaster ? "Raster" : (d.geometry_type ?? "Unknown"),
        datasource,
        color: null,
        category_field: null,
        categories: null,
        ranges: null,
        labeling: null,
        kind: d.kind,
        crs: d.crs,
        raster: d.raster,
        source_format: d.format,
      };
    });
}
