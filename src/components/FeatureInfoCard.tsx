import { formatDisplayValue, type LayerValueMappings } from "../lib/valueMapping";
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
  valueMappings: LayerValueMappings;
  onValueMappingChange: (
    layerIndex: number,
    field: string,
    rawValue: string,
    label: string
  ) => void;
}

function prettifyName(raw: string): string {
  return raw
    .replace(/[_\-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim()
    .split(/\s+/)
    .map((w) => (w === w.toUpperCase() ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join(" ");
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
  valueMappings,
  onValueMappingChange,
}: FeatureInfoCardProps) {
  const layer = activeFeature ? layers[activeFeature.layerIndex] : undefined;
  const [fetchedText, setFetchedText] = useState<string | null>(null);
  const [columnPickerOpen, setColumnPickerOpen] = useState(false);
  const [columnSearchQuery, setColumnSearchQuery] = useState("");
  const columnPickerRef = useRef<HTMLDivElement | null>(null);
  const [editingField, setEditingField] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const editCancelledRef = useRef(false);

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
      setEditingField(null);
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

  const [mappingOpen, setMappingOpen] = useState(false);
  const [mappingField, setMappingField] = useState("");
  const [mapSelOpen, setMapSelOpen] = useState(false);
  const mappingRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!mappingOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (mappingRef.current && !mappingRef.current.contains(e.target as Node)) {
        setMappingOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [mappingOpen]);

  const activeMappingField = allFields.includes(mappingField) ? mappingField : (allFields[0] ?? "");

  const mappingValues = useMemo(() => {
    const MAX_UNIQUE_VALUES = 200;
    if (!mappingOpen || !fetchedText || !activeMappingField) {
      return { values: [] as string[], truncated: false };
    }
    const set = new Set<string>();
    for (const f of parseGeojsonForAttributeTable(fetchedText).features) {
      const v = f.properties?.[activeMappingField];
      if (v !== null && v !== undefined) set.add(String(v));
    }
    const all = Array.from(set);
    const numeric = all.every((v) => v.trim() !== "" && !Number.isNaN(Number(v)));
    all.sort((a, b) => (numeric ? Number(a) - Number(b) : a.localeCompare(b)));
    return { values: all.slice(0, MAX_UNIQUE_VALUES), truncated: all.length > MAX_UNIQUE_VALUES };
  }, [mappingOpen, fetchedText, activeMappingField]);

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

  function selectAllFields() {
    onVisibleFieldsChange(layerIndex, null);
  }

  function startEditAlias(field: string) {
    if (!activeFields.includes(field)) return;
    editCancelledRef.current = false;
    setEditDraft(layerAliases[field] ?? "");
    setEditingField(field);
  }

  function commitEditAlias(field: string) {
    if (editCancelledRef.current) {
      editCancelledRef.current = false;
      return;
    }
    onFieldAliasChange(layerIndex, field, editDraft.trim());
    setEditingField(null);
  }

  function cancelEditAlias() {
    editCancelledRef.current = true;
    setEditingField(null);
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
            <div className="feature-info-card-column-picker" ref={mappingRef}>
              <button
                type="button"
                className="feature-info-card-icon-btn"
                onClick={() => setMappingOpen((v) => !v)}
                title="Pemetaan nilai atribut"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8Z" />
                  <circle cx="7.5" cy="7.5" r="1.2" />
                </svg>
              </button>
              {mappingOpen && (
                <div className="feature-info-card-column-popover">
                  <div className="feature-info-card-column-popover-header">
                    <span>Pemetaan nilai</span>
                  </div>
                  <div className="fic-select">
                    <button
                      type="button"
                      className={"fic-select-trigger" + (mapSelOpen ? " open" : "")}
                      onClick={() => setMapSelOpen((v) => !v)}
                    >
                      <span>{layerAliases[activeMappingField] || activeMappingField}</span>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M6 9l6 6 6-6" />
                      </svg>
                    </button>
                    {mapSelOpen && (
                      <ul className="fic-select-list">
                        {allFields.map((f) => (
                          <li
                            key={f}
                            className={"fic-select-item" + (f === activeMappingField ? " selected" : "")}
                            onClick={() => {
                              setMappingField(f);
                              setMapSelOpen(false);
                            }}
                          >
                            {layerAliases[f] || f}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div className="feature-info-card-column-list">
                    {mappingValues.values.length === 0 ? (
                      <div className="feature-info-card-column-empty">Tidak ada nilai.</div>
                    ) : (
                      mappingValues.values.map((raw) => {
                        const current = valueMappings[layerIndex]?.[activeMappingField]?.[raw] ?? "";
                        return (
                          <div key={raw} className="feature-info-card-column-item">
                            <span className="feature-info-card-column-name">{raw}</span>
                            <input
                              type="text"
                              className="feature-info-card-alias-input"
                              key={`${activeMappingField}:${raw}:${current}`}
                              defaultValue={current}
                              placeholder={raw}
                              onBlur={(e) =>
                                onValueMappingChange(layerIndex, activeMappingField, raw, e.target.value)
                              }
                              onKeyDown={(e) => {
                                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                              }}
                            />
                          </div>
                        );
                      })
                    )}
                  </div>
                  <div className="feature-info-card-column-hint">
                    {mappingValues.truncated
                      ? "Hanya 200 nilai pertama ditampilkan \u00b7 kosongkan label = nilai asli"
                      : "Enter = simpan \u00b7 kosongkan label = nilai asli"}
                  </div>
                </div>
              )}
            </div>
          )}
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
                    <span>
                      Pilih kolom{" "}
                      <em className="fic-count">{activeFields.length}/{allFields.length}</em>
                    </span>
                    <div className="fic-head-actions">
                      <button type="button" className="feature-info-card-column-reset" onClick={selectAllFields}>
                        Pilih semua
                      </button>
                      <button type="button" className="feature-info-card-column-reset" onClick={clearAllFields}>
                        Kosongkan
                      </button>
                    </div>
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
                        <div
                          key={field}
                          className="feature-info-card-column-item"
                        >
                          <input
                            type="checkbox"
                            checked={activeFields.includes(field)}
                            onChange={() => toggleField(field)}
                          />
                          <span
                              className="feature-info-card-column-name"
                            >
                              {layerAliases[field] ? (
                                <>
                                  <span className="feature-info-card-column-name-alias">
                                    {layerAliases[field]}
                                  </span>
                                  <span className="feature-info-card-column-name-original">
                                    {field}
                                  </span>
                                </>
                              ) : (
                                field
                              )}
                            </span>
                          {activeFields.includes(field) && (
                            <button
                              type="button"
                              className={"feature-info-card-alias-edit-btn" + (layerAliases[field] ? " has-alias" : "") + (editingField === field ? " editing" : "")}
                              title="Ubah alias"
                              aria-label={`Ubah alias ${field}`}
                              onClick={() => startEditAlias(field)}
                            >
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M12 20h9" />
                                <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
                              </svg>
                            </button>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                  {editingField && (
                    <div className="fic-alias-pop">
                      <div className="fic-alias-title">Ubah nama tampilan</div>
                      <div className="fic-alias-orig">
                        Kolom asli: <code>{editingField}</code>
                      </div>
                      <input
                        type="text"
                        className="fic-alias-input"
                        autoFocus
                        value={editDraft}
                        placeholder={prettifyName(editingField)}
                        onFocus={(e) => e.currentTarget.select()}
                        onChange={(e) => setEditDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            commitEditAlias(editingField);
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            e.stopPropagation();
                            cancelEditAlias();
                          }
                        }}
                      />
                      <div className="fic-alias-actions">
                        <button type="button" className="fic-btn fic-btn--ghost" onClick={() => setEditDraft(prettifyName(editingField))}>
                          Rapikan
                        </button>
                        <span className="fic-spacer" />
                        <button type="button" className="fic-btn fic-btn--ghost" onClick={cancelEditAlias}>
                          Batal
                        </button>
                        <button type="button" className="fic-btn fic-btn--primary" onClick={() => commitEditAlias(editingField)}>
                          Simpan
                        </button>
                      </div>
                    </div>
                  )}
                  <div className="feature-info-card-column-hint">
                    {editingField
                      ? "Enter = simpan \u00b7 Esc = batal"
                      : "Klik ikon pensil untuk ubah alias"}
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
                    {formatDisplayValue(value, valueMappings[layerIndex]?.[key])}
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
