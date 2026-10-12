import type { CategoryInfo } from "../components/ProjectPanel";

export const MAX_CATEGORY_VALUES = 20;

const PALETTE = [
  "#c8553d", "#3fa66b", "#2f6fd0", "#4a8fb5", "#f2c94c",
  "#9b51e0", "#f2994a", "#27ae60", "#eb5757", "#00b8a9",
];

function valueKey(raw: unknown): string {
  return raw === null || raw === undefined ? "NULL" : String(raw);
}

function uniqueValues(fc: GeoJSON.FeatureCollection, field: string): string[] {
  const set = new Set<string>();
  for (const f of fc.features) {
    set.add(valueKey(f.properties?.[field]));
    if (set.size > MAX_CATEGORY_VALUES) break;
  }
  return Array.from(set);
}

function sortValues(values: string[]): string[] {
  const allNumeric = values.every((v) => v === "NULL" || !Number.isNaN(Number(v)));
  return [...values].sort((a, b) => {
    if (a === "NULL") return 1;
    if (b === "NULL") return -1;
    return allNumeric ? Number(a) - Number(b) : a.localeCompare(b);
  });
}

function parse(text: string | null): GeoJSON.FeatureCollection | null {
  if (!text) return null;
  try {
    const fc = JSON.parse(text) as GeoJSON.FeatureCollection;
    return Array.isArray(fc.features) ? fc : null;
  } catch {
    return null;
  }
}

export function listCategoryFields(text: string | null): string[] {
  const fc = parse(text);
  if (!fc) return [];
  const fields = new Set<string>();
  fc.features.forEach((f) => Object.keys(f.properties ?? {}).forEach((k) => fields.add(k)));
  return Array.from(fields).filter((field) => {
    const n = uniqueValues(fc, field).length;
    return n >= 2 && n <= MAX_CATEGORY_VALUES;
  });
}

export function buildCategories(text: string | null, field: string): CategoryInfo[] | null {
  const fc = parse(text);
  if (!fc) return null;
  const values = uniqueValues(fc, field);
  if (values.length === 0 || values.length > MAX_CATEGORY_VALUES) return null;
  return sortValues(values).map((v, i) => ({
    value: v,
    label: v === "NULL" ? "(kosong)" : v,
    color: PALETTE[i % PALETTE.length],
  }));
}
