import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import type { LayerInfo } from "./ProjectPanel";
import type { BasemapCandidateInfo } from "./ConfigurationPanel";
import { clearLayerGeojsonCache, prefetchAllLayers } from "../lib/layerGeojsonCache";
import { fetchRasterClassCategories } from "../lib/rasterTiles";
import {
  datasetsToLayers,
  scanGisFolder,
  type FolderScanResult,
  type ScannedDataset,
} from "../lib/folderScan";

interface ImportToolbarProps {
  projectPath: string | null;
  onProjectPathChange: (path: string | null) => void;
  onLayersLoaded: (layers: LayerInfo[]) => void;
  onSelectedLayerIndexesChange: (indexes: number[]) => void;
  onBoundaryLayerIndexChange: (index: number | null) => void;
  onBasemapCandidatesLoaded?: (candidates: BasemapCandidateInfo[]) => void;
  onGdalAvailabilityChecked?: (available: boolean) => void;
  onImportingChange?: (importing: boolean) => void;
  onImportingLabelChange?: (label: string) => void;
}

type DialogStep = "choose" | "scanning" | "review";

const STATUS_LABEL: Record<ScannedDataset["status"], string> = {
  ok: "Siap",
  warning: "Peringatan",
  error: "Tidak valid",
};

const FORMAT_LABEL: Record<ScannedDataset["format"], string> = {
  shapefile: "Shapefile",
  geotiff: "GeoTIFF",
  geojson: "GeoJSON",
  geopackage: "GeoPackage",
};

function isSelectable(d: ScannedDataset): boolean {
  return d.status !== "error";
}

// Path virtual di dalam folder data. Backend memakai parent()-nya sebagai
// folder project, dan file pengaturan disimpan sebagai
// <folder>/.gis2web-folder.gis2web.json.
function folderProjectPath(folder: string): string {
  const sep = folder.includes("\\") ? "\\" : "/";
  return `${folder.replace(/[\\/]+$/, "")}${sep}.gis2web-folder`;
}

function ImportToolbar({
  projectPath,
  onProjectPathChange,
  onLayersLoaded,
  onSelectedLayerIndexesChange,
  onBoundaryLayerIndexChange,
  onBasemapCandidatesLoaded,
  onGdalAvailabilityChecked,
  onImportingChange,
  onImportingLabelChange,
}: ImportToolbarProps) {
  const [loading, setLoading] = useState(false);
  const [loadingLabel, setLoadingLabel] = useState("Membaca project...");
  const [error, setError] = useState<string | null>(null);
  const [sourceLabel, setSourceLabel] = useState<string | null>(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [step, setStep] = useState<DialogStep>("choose");
  const [scan, setScan] = useState<FolderScanResult | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<number>>(new Set());

  function closeDialog() {
    setDialogOpen(false);
    setStep("choose");
    setScan(null);
    setScanError(null);
    setChecked(new Set());
  }

  useEffect(() => {
    if (!dialogOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && step !== "scanning") closeDialog();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dialogOpen, step]);

  function setLabel(label: string) {
    setLoadingLabel(label);
    onImportingLabelChange?.(label);
  }

  async function checkGdal() {
    try {
      onGdalAvailabilityChecked?.(await invoke<boolean>("check_gdal_available"));
    } catch {
      onGdalAvailabilityChecked?.(false);
    }
  }

  // ---------- Pilihan A: Project QGIS ----------
  async function handleImportQgis() {
    setScanError(null);
    const selected = await open({
      multiple: false,
      filters: [{ name: "QGIS Project", extensions: ["qgz", "qgs"] }],
    });
    if (!selected || Array.isArray(selected)) return;

    closeDialog();
    setError(null);
    onImportingChange?.(true);
    setLoading(true);
    setSourceLabel(selected);
    onProjectPathChange(selected);
    setLabel("Membaca project...");
    clearLayerGeojsonCache();

    try {
      const result = await invoke<LayerInfo[]>("parse_qgis_project", { path: selected });

      // Basemap candidates & GDAL check bersifat pelengkap, bukan syarat
      // import berhasil.
      try {
        const candidates = await invoke<BasemapCandidateInfo[]>(
          "parse_qgis_basemap_candidates",
          { path: selected }
        );
        onBasemapCandidatesLoaded?.(candidates);
      } catch {
        onBasemapCandidatesLoaded?.([]);
      }
      await checkGdal();

      // Panel Layers baru ditampilkan setelah SEMUA data geojson layer
      // selesai dimuat ke cache.
      if (result.length > 0) {
        setLabel(`Menyiapkan preview ${result.length} layer...`);
        for (const l of result) {
          if (l.kind === "raster" && !l.issue && l.raster && !l.raster.has_color_table && l.raster.suggested_type === "single_band") {
            l.categories = await fetchRasterClassCategories(l.datasource);
          }
        }
        await prefetchAllLayers(
          selected,
          result.filter((l) => l.kind !== "raster").map((l) => l.datasource)
        );
      }

      onLayersLoaded(result);
      onSelectedLayerIndexesChange([]);
      onBoundaryLayerIndexChange(null);
    } catch (err) {
      setError(String(err));
      onLayersLoaded([]);
    } finally {
      setLoading(false);
      onImportingChange?.(false);
    }
  }

  // ---------- Pilihan B: Folder Data GIS ----------
  async function handlePickFolder() {
    setScanError(null);
    const selected = await open({ directory: true, multiple: false });
    if (!selected || Array.isArray(selected)) return;

    setStep("scanning");
    try {
      const result = await scanGisFolder(selected);
      setScan(result);
      setChecked(
        new Set(
          result.datasets
            .map((d, i) => (isSelectable(d) ? i : -1))
            .filter((i) => i >= 0)
        )
      );
      setStep("review");
    } catch (err) {
      setScanError(String(err));
      setStep("choose");
    }
  }

  function toggleChecked(index: number) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  async function handleConfirmFolder() {
    if (!scan) return;
    const chosen = scan.datasets.filter((_, i) => checked.has(i));
    const newLayers = datasetsToLayers(chosen);
    if (newLayers.length === 0) return;

    const folder = scan.folder;
    const virtualPath = folderProjectPath(folder);
    closeDialog();

    setError(null);
    onImportingChange?.(true);
    setLoading(true);
    setSourceLabel(folder);
    onProjectPathChange(virtualPath);
    setLabel("Membaca folder...");
    clearLayerGeojsonCache();
    onBasemapCandidatesLoaded?.([]);

    try {
      await checkGdal();
      setLabel(`Menyiapkan preview ${newLayers.length} layer...`);
      for (const l of newLayers) {
        if (l.kind === "raster" && l.raster && !l.raster.has_color_table && l.raster.suggested_type === "single_band") {
          l.categories = await fetchRasterClassCategories(l.datasource);
        }
      }
      await prefetchAllLayers(
        virtualPath,
        newLayers.filter((l) => l.kind !== "raster").map((l) => l.datasource)
      );

      onLayersLoaded(newLayers);
      onSelectedLayerIndexesChange([]);
      onBoundaryLayerIndexChange(null);
    } catch (err) {
      setError(String(err));
      onLayersLoaded([]);
    } finally {
      setLoading(false);
      onImportingChange?.(false);
    }
  }

  const shownPath = sourceLabel ?? projectPath;

  return (
    <div className="top-toolbar">
      <button
        type="button"
        className="top-toolbar-import-btn"
        onClick={() => {
          setError(null);
          setDialogOpen(true);
        }}
        disabled={loading}
      >
        {loading ? loadingLabel : "\u{1F4C1} Import Data GIS"}
      </button>

      {shownPath && (
        <span className="top-toolbar-path" title={shownPath}>
          {shownPath}
        </span>
      )}

      {error && <span className="top-toolbar-error">Error: {error}</span>}

      {dialogOpen && (
        <div
          className="import-overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && step !== "scanning") closeDialog();
          }}
        >
          <div className="import-dialog" role="dialog" aria-modal="true">
            {step === "choose" && (
              <>
                <div className="import-dialog-header">
                  <h2>Import Data GIS</h2>
                  <button type="button" className="import-close-btn" onClick={closeDialog} aria-label="Tutup">
                    &times;
                  </button>
                </div>
                <p className="import-dialog-sub">Pilih sumber data yang ingin dimasukkan ke GIS2Web Studio.</p>
                {scanError && <p className="import-error">{scanError}</p>}
                <div className="import-cards">
                  <div className="import-card">
                    <div className="import-card-icon">
                      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 7l6-3 6 3 6-3v13l-6 3-6-3-6 3V7z" />
                        <path d="M9 4v13M15 7v13" />
                      </svg>
                    </div>
                    <h3>Import Project QGIS</h3>
                    <p>
                      Import project <code>.qgz</code> atau <code>.qgs</code> beserta referensi layer dan
                      konfigurasi yang didukung.
                    </p>
                    <button type="button" className="import-card-btn" onClick={handleImportQgis}>
                      Pilih Project QGIS
                    </button>
                  </div>

                  <div className="import-card">
                    <div className="import-card-icon import-card-icon--folder">
                      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
                      </svg>
                    </div>
                    <h3>Import Folder Data GIS</h3>
                    <p>
                      Import Shapefile, GeoTIFF, GeoJSON, dan GeoPackage langsung dari folder, tanpa
                      project QGIS.
                    </p>
                    <button type="button" className="import-card-btn import-card-btn--alt" onClick={handlePickFolder}>
                      Pilih Folder Data GIS
                    </button>
                  </div>
                </div>
              </>
            )}

            {step === "scanning" && (
              <div className="import-scanning">
                <div className="import-spinner" />
                <p>Memindai folder dan memvalidasi data...</p>
              </div>
            )}

            {step === "review" && scan && (
              <>
                <div className="import-dialog-header">
                  <h2>Hasil Pemindaian</h2>
                  <button type="button" className="import-close-btn" onClick={closeDialog} aria-label="Tutup">
                    &times;
                  </button>
                </div>
                <p className="import-dialog-sub" title={scan.folder}>
                  {scan.folder}
                </p>
                {scan.truncated && (
                  <p className="import-warning">
                    Jumlah dataset melebihi batas pemindaian; sebagian tidak ditampilkan.
                  </p>
                )}
                {scan.datasets.length === 0 ? (
                  <p className="import-empty">
                    Tidak ada dataset yang didukung (Shapefile, GeoTIFF, GeoJSON, GeoPackage) di folder ini
                    atau subfolder sampai 2 tingkat.
                  </p>
                ) : (
                  <div className="import-scan-list">
                    {scan.datasets.map((d, i) => {
                      const selectable = isSelectable(d);
                      const isRaster = d.kind === "raster";
                      return (
                        <label
                          key={`${d.path}:${d.layer_name ?? ""}:${i}`}
                          className={"import-scan-row" + (selectable ? "" : " import-scan-row--disabled")}
                        >
                          <input
                            type="checkbox"
                            disabled={!selectable}
                            checked={checked.has(i)}
                            onChange={() => toggleChecked(i)}
                          />
                          <div className="import-scan-info">
                            <div className="import-scan-title">
                              <strong>{d.name}</strong>
                              <span className={`import-badge import-badge--${d.status}`}>
                                {STATUS_LABEL[d.status]}
                              </span>
                            </div>
                            <div className="import-scan-meta">
                              {isRaster ? "Raster" : "Vektor"} · {FORMAT_LABEL[d.format]}
                              {d.geometry_type && !isRaster ? ` · ${d.geometry_type}` : ""}
                              {" · "}
                              {d.crs ?? "CRS tidak diketahui"}
                              {d.raster
                                ? ` · ${d.raster.width}×${d.raster.height} px · ${d.raster.band_count} band${
                                    d.raster.data_type ? ` ${d.raster.data_type}` : ""
                                  }`
                                : ""}
                            </div>
                            <div className="import-scan-file">{d.relative_path}</div>
                            {d.companion_files.length > 0 && (
                              <div className="import-scan-file">
                                File pendamping: {d.companion_files.join(", ")}
                              </div>
                            )}
                            {d.messages.map((m, mi) => (
                              <div
                                key={mi}
                                className={d.status === "error" ? "import-scan-msg import-scan-msg--error" : "import-scan-msg"}
                              >
                                {m}
                              </div>
                            ))}
                          </div>
                        </label>
                      );
                    })}
                  </div>
                )}
                <div className="import-dialog-footer">
                  <button type="button" className="import-secondary-btn" onClick={() => { setStep("choose"); setScan(null); }}>
                    Kembali
                  </button>
                  <button
                    type="button"
                    className="import-card-btn import-footer-primary"
                    disabled={checked.size === 0}
                    onClick={handleConfirmFolder}
                  >
                    Masukkan {checked.size} layer ke project
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default ImportToolbar;
