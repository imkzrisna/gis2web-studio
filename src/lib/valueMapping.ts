/** layerIndex -> field -> (nilai asli sebagai string -> label tampilan) */
export type LayerValueMappings = Record<number, Record<string, Record<string, string>>>;

/**
 * Format nilai atribut untuk tampilan. Nilai asli tidak diubah.
 * null/undefined -> "-", nilai tanpa pemetaan -> nilai asli.
 */
export function formatDisplayValue(
  value: unknown,
  fieldMap?: Record<string, string>
): string {
  if (value === null || value === undefined) return "-";
  const raw = String(value);
  if (fieldMap && Object.prototype.hasOwnProperty.call(fieldMap, raw)) {
    const label = fieldMap[raw];
    if (label !== "") return label;
  }
  return raw;
}
