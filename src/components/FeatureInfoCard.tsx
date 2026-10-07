import { useEffect, useMemo, useRef, useState } from "react";
import { parseGeojsonForAttributeTable, type GeojsonFeatureLike } from "../lib/geojsonFields";
import { fetchLayerGeojson, getCachedGeojson } from "../lib/layerGeojsonCache";
import type { LayerInfo } from "./ProjectPanel";

interface FeatureInfoCardProps {
  projectPath: string | null;
  layers: LayerInfo[];
  activeFeature: { layerIndex: number; featureIndex: number } | null;
  onClose: () => void;
  onOpenFullTable: () => void;
  visibleFields: Record<number, string[]>;
  onVisibleFieldsChange: (layerIndex: number, fields: string[] | null) => void;
  fieldAliases: Record<number, Record<string, string>>;
  onFieldAliasChange: (layerIndex: number, field: string, alias: string) => void;
}

function FeatureInfoCard({
  projectPath,
  layers,
  activeFeature,
  onClose,
  onOpenFullTable,
  visibleFields,
  onVisibleFieldsChange,
  fieldAliases,
  onFieldAliasChange,
}: FeatureInfoCardProps) {
  const layer = activeFeature ? layers[activeFeature.layerIndex] : undefined;
  const [fetchedText, setFetchedText] = useState<string | null>(null);
  const [columnPickerOpen, setColumnPickerOpen] = useState(false);
  const [columnSearchQuery, setColumnSearchQuery] = useState("");
  const columnPickerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setFetchedText(null);
    if (!projectPath || !layer) return;

    const cached = getCachedGeojson(projectPath, layer.datasource);
    if (cached !== null) {
      setFetchedText(cached);
      return;
    }

    let cancelled = false;
    fetchLayerGeojson(projectPath, layer.datasource)
      .then((text) => {
        if (!cancelled) setFetchedText(text);
      })
      .catch(() => {
        if (!cancelled) setFetchedText(null);
      });

    return () => {
      cancelled = true;
    };
  }, [projectPath, layer]);

  useEffect(() => {
    setColumnPickerOpen(false);
  }, [activeFeature?.layerIndex, activeFeature?.featureIndex]);

  useEffect(() => {
    if (!columnPickerOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (columnPickerRef.current && !columnPickerRef.current.contains(e.target as Node)) {
        setColumnPickerOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [columnPickerOpen]);

  useEffect(() => {
    if (!columnPickerOpen) {
      setColumnSearchQuery("");
    }
  }, [columnPickerOpen]);

  const feature = useMemo<GeojsonFeatureLike | null>(() => {
    if (!activeFeature || !fetchedText) return null;
    const parsed = parseGeojsonForAttributeTable(fetchedText);
    return parsed.features[activeFeature.featureIndex] ?? null;
  }, [activeFeature, fetchedText]);

  const allFields = useMemo<string[]>(() => {
    if (!fetchedText) return [];
    return parseGeojsonForAttributeTable(fetchedText).fields;
  }, [fetchedText]);

  const showColumnSearch = allFields.length > 8;
  const displayedFields = useMemo(() => {
    if (!showColumnSearch || columnSearchQuery.trim() === "") return allFields;
    const query = columnSearchQuery.trim().toLowerCase();
    return allFields.filter((field) => field.toLowerCase().includes(query));
  }, [allFields, showColumnSearch, columnSearchQuery]);

  if (!activeFeature || !layer || !feature) return null;

  const properties = feature.properties ?? {};
  const layerIndex = activeFeature.layerIndex;
  const selectedFields = visibleFields[layerIndex];
  const activeFields = selectedFields ?? allFields;
  const layerAliases = fieldAliases[layerIndex] ?? {};

  const entries = activeFields
    .filter((field) => Object.prototype.hasOwnProperty.call(properties, field))
    .map((field) => [field, properties[field]] as [string, unknown]);

  function toggleField(field: string) {
    const current = selectedFields ?? allFields;
    const next = current.includes(field)
      ? current.filter((f) => f !== field)
      : [...allFields.filter((f) => current.includes(f) || f === field)];
    if (next.length === allFields.length) {
      onVisibleFieldsChange(layerIndex, null);
    } else {
      onVisibleFieldsChange(layerIndex, next);
    }
  }

  function clearAllFields() {
    onVisibleFieldsChange(layerIndex, []);
  }

  return (
    <div className="feature-info-card">
      <div className="feature-info-card-header">
        <div className="feature-info-card-header-text">
          <span className="feature-info-card-title">Feature Information</span>
          <span className="feature-info-card-subtitle">{layer.name}</span>
        </div>
        <div className="feature-info-card-header-actions">
          {allFields.length > 0 && (
            <div className="feature-info-card-column-picker" ref={columnPickerRef}>
              <button
                type="button"
                className="feature-info-card-icon-btn"
                onClick={() => setColumnPickerOpen((v) => !v)}
                title="Pilih kolom yang ditampilkan"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="4" width="18" height="16" rx="2" />
                  <path d="M9 4v16M15 4v16" />
                </svg>
              </button>
              {columnPickerOpen && (
                <div className="feature-info-card-column-popover">
                  <div className="feature-info-card-column-popover-header">
                    <span>Pilih kolom</span>
                    <button
                      type="button"
                      className="feature-info-card-column-reset"
                      onClick={clearAllFields}
                    >
                      Kosongkan semua
                    </button>
                  </div>
                  {showColumnSearch && (
                    <div className="feature-info-card-column-search">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="11" cy="11" r="7" />
                        <path d="M21 21l-4.3-4.3" />
                      </svg>
                      <input
                        type="text"
                        placeholder="Cari kolom..."
                        value={columnSearchQuery}
                        onChange={(e) => setColumnSearchQuery(e.target.value)}
                        autoFocus
                      />
                    </div>
                  )}
                  <div className="feature-info-card-column-list">
                    {displayedFields.length === 0 ? (
                      <div className="feature-info-card-column-empty">
                        Tidak ada kolom yang cocok dengan "{columnSearchQuery}".
                      </div>
                    ) : (
                      displayedFields.map((field) => (
                        <label key={field} className="feature-info-card-column-item">
                          <input
                            type="checkbox"
                            checked={activeFields.includes(field)}
                            onChange={() => toggleField(field)}
                          />
                          <span>{field}</span>
                          {activeFields.includes(field) && (
                            <input
                              type="text"
                              className="feature-info-card-alias-input"
                              placeholder="Alias (opsional)"
                              value={layerAliases[field] ?? ""}
                              onClick={(e) => e.stopPropagation()}
                              onChange={(e) =>
                                onFieldAliasChange(layerIndex, field, e.target.value)
                              }
                            />
                          )}
                        </label>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
          <button
            type="button"
            className="feature-info-card-close"
            onClick={onClose}
            title="Tutup"
          >
            {"\u2715"}
          </button>
        </div>
      </div>

      {entries.length === 0 ? (
        <div className="feature-info-card-empty">
          {allFields.length === 0
            ? "Tidak ada data atribut pada feature ini."
            : "Tidak ada kolom yang dipilih untuk ditampilkan."}
        </div>
      ) : (
        <div className="feature-info-card-body">
          <table className="feature-info-card-table">
            <tbody>
              {entries.map(([key, value]) => (
                <tr key={key}>
                  <th>{layerAliases[key] || key}</th>
                  <td>
                    {value === null || value === undefined ? "-" : String(value)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="feature-info-card-footer">
        <button
          type="button"
          className="feature-info-card-full-table-btn"
          onClick={onOpenFullTable}
        >
          Lihat tabel penuh
        </button>
      </div>
    </div>
  );
}

export default FeatureInfoCard;
