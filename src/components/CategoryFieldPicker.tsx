import { useEffect, useMemo, useRef, useState } from "react";
import type { LayerInfo } from "./ProjectPanel";
import { getCachedGeojson } from "../lib/layerGeojsonCache";
import { listCategoryFields } from "../lib/autoCategories";

interface Props {
  projectPath: string | null;
  layer: LayerInfo;
  onChange: (field: string | null) => void;
}

const NONE_LABEL = "Satu warna";

export default function CategoryFieldPicker({ projectPath, layer, onChange }: Props) {
  const fields = useMemo(
    () => (projectPath ? listCategoryFields(getCachedGeojson(projectPath, layer.datasource)) : []),
    [projectPath, layer.datasource]
  );
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!wrapRef.current?.contains(t) && !listRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onScroll = (e: Event) => {
      if (listRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  if (fields.length === 0) return null;

  const current = layer.category_field ?? "";

  function toggle() {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      const maxH = 240;
      const below = window.innerHeight - r.bottom;
      const top = below < maxH + 12 && r.top > below ? r.top - maxH - 6 : r.bottom + 6;
      setPos({ top: Math.max(8, top), left: r.left, width: Math.max(r.width, 160) });
    }
    setOpen((v) => !v);
  }

  function pick(value: string) {
    setOpen(false);
    onChange(value === "" ? null : value);
  }

  const options = [{ value: "", label: NONE_LABEL }, ...fields.map((f) => ({ value: f, label: f }))];

  return (
    <div className="cfp" ref={wrapRef} onClick={(e) => e.stopPropagation()}>
      <span className="cfp-label">Warna berdasarkan</span>
      <button
        ref={btnRef}
        type="button"
        className={"cfp-trigger" + (open ? " open" : "") + (current ? " has-value" : "")}
        onClick={toggle}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="cfp-trigger-text">{current || NONE_LABEL}</span>
        <svg className="cfp-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && pos && (
        <ul
          ref={listRef}
          className="cfp-list"
          role="listbox"
          style={{ top: pos.top, left: pos.left, minWidth: pos.width }}
        >
          {options.map((o) => (
            <li
              key={o.value || "__none"}
              role="option"
              aria-selected={o.value === current}
              className={"cfp-item" + (o.value === current ? " selected" : "")}
              onClick={() => pick(o.value)}
            >
              <span className="cfp-item-text">{o.label}</span>
              {o.value === current && (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12l5 5 9-10" />
                </svg>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
