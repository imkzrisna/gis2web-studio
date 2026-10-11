import { useMemo } from "react";
import type { LayerInfo } from "./ProjectPanel";
import { getCachedGeojson } from "../lib/layerGeojsonCache";
import { listCategoryFields } from "../lib/autoCategories";

interface Props {
  projectPath: string | null;
  layer: LayerInfo;
  onChange: (field: string | null) => void;
}

export default function CategoryFieldPicker({ projectPath, layer, onChange }: Props) {
  const fields = useMemo(
    () => (projectPath ? listCategoryFields(getCachedGeojson(projectPath, layer.datasource)) : []),
    [projectPath, layer.datasource]
  );
  if (fields.length === 0) return null;
  return (
    <div className="category-field-picker" onClick={(e) => e.stopPropagation()}>
      <label>
        <span className="layer-note">Warna berdasarkan kolom: </span>
        <select
          value={layer.category_field ?? ""}
          onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
        >
          <option value="">(satu warna)</option>
          {fields.map((f) => (
            <option key={f} value={f}>{f}</option>
          ))}
        </select>
      </label>
    </div>
  );
}
