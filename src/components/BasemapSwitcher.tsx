import { useEffect, useRef, useState } from "react";
import { BASEMAP_OPTIONS, type WebGisConfig } from "./ConfigurationPanel";

interface Props {
  config: WebGisConfig;
  onConfigChange: (config: WebGisConfig) => void;
}

export default function BasemapSwitcher({ config, onConfigChange }: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const options = BASEMAP_OPTIONS.filter((o) => o.value !== "custom");

  // Config lama dengan basemap dari QGIS dikembalikan ke OpenStreetMap
  useEffect(() => {
    if (config.basemap === "custom") {
      onConfigChange({ ...config, basemap: "osm", customBasemap: null });
    }
  }, [config, onConfigChange]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="basemap-switcher" ref={wrapRef}>
      <button
        type="button"
        className={"basemap-btn" + (open ? " open" : "")}
        onClick={() => setOpen((v) => !v)}
        aria-label="Ganti basemap"
        aria-expanded={open}
        title="Ganti basemap"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3l9 5-9 5-9-5 9-5z" />
          <path d="M3 13l9 5 9-5" />
          <path d="M3 17.5l9 5 9-5" opacity="0.55" />
        </svg>
      </button>

      <div className={"basemap-menu" + (open ? " open" : "")} role="listbox" aria-hidden={!open}>
        {options.map((o, i) => {
          const selected = config.basemap === o.value;
          return (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={selected}
              tabIndex={open ? 0 : -1}
              className={"basemap-item" + (selected ? " selected" : "")}
              style={{ transitionDelay: open ? `${0.03 + i * 0.05}s` : "0s" }}
              onClick={() => {
                onConfigChange({ ...config, basemap: o.value, customBasemap: null });
                setOpen(false);
              }}
            >
              <span className="basemap-item-label">{o.label}</span>
              {selected && (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12l5 5 9-10" />
                </svg>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
