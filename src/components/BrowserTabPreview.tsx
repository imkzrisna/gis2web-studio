import { memo, useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import LogoPreview from "./LogoPreview";

interface Props {
  title: string;
  logoPath: string | null;
  logoCrop: React.ComponentProps<typeof LogoPreview>["crop"] | null;
}

function BrowserTabPreview({ title, logoPath, logoCrop }: Props) {
  const [light, setLight] = useState<boolean>(
    () => localStorage.getItem("g2w_browser_light") === "1"
  );

  useEffect(() => {
    localStorage.setItem("g2w_browser_light", light ? "1" : "0");
  }, [light]);

  return (
    <div className={"browser-strip" + (light ? " light" : "")} aria-label="Pratinjau tab browser">
      <div className="export-tab-mockup">
        <span className="export-tab-mockup-icon">
          {logoPath && logoCrop ? (
            <LogoPreview src={convertFileSrc(logoPath)} crop={logoCrop} size={16} />
          ) : (
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="9" />
              <path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18" />
            </svg>
          )}
        </span>
        <span className="export-tab-mockup-title">{title.trim() || "GIS2Web Studio Export"}</span>
        <span className="export-tab-mockup-close" aria-hidden="true">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
            <path d="M5 5l14 14M19 5L5 19" />
          </svg>
        </span>
      </div>
      <button
        type="button"
        className="browser-theme-btn"
        onClick={() => setLight((v) => !v)}
        title={light ? "Lihat mode gelap" : "Lihat mode terang"}
        aria-label="Ganti mode pratinjau browser"
      >
        {light ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
          </svg>
        )}
      </button>
    </div>
  );
}

export default memo(BrowserTabPreview);
