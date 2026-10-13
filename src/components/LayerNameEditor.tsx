import { useRef, useState } from "react";

interface LayerNameEditorProps {
  name: string;
  originalName: string;
  onRename: (name: string) => void;
}

export default function LayerNameEditor({ name, originalName, onRename }: LayerNameEditorProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const cancelledRef = useRef(false);
  const renamed = name !== originalName;

  function start() {
    cancelledRef.current = false;
    setDraft(name);
    setEditing(true);
  }

  function commit() {
    if (cancelledRef.current) {
      cancelledRef.current = false;
      setEditing(false);
      return;
    }
    const clean = draft.trim();
    if (clean !== name) onRename(clean);
    setEditing(false);
  }

  if (editing) {
    return (
      <div className="layer-name-editor" onClick={(e) => e.stopPropagation()}>
        <input
          type="text"
          className="layer-name-input"
          autoFocus
          value={draft}
          placeholder={originalName}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              cancelledRef.current = true;
              setEditing(false);
            }
          }}
        />
        <div className="layer-name-hint">Enter = simpan &middot; Esc = batal</div>
      </div>
    );
  }

  return (
    <div className="layer-name-editor" onClick={(e) => e.stopPropagation()}>
      <div className="layer-name-row">
        <span className="layer-name-text" onDoubleClick={start} title={name}>
          {name}
        </span>
        <button
          type="button"
          className="layer-name-edit-btn"
          title="Ubah nama layer"
          aria-label="Ubah nama layer"
          onClick={start}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
          </svg>
        </button>
      </div>
      {renamed && (
        <div className="layer-name-original">
          <span title={originalName}>Asli: {originalName}</span>
          <button
            type="button"
            className="layer-name-reset-btn"
            title="Kembalikan nama asli"
            aria-label="Kembalikan nama asli"
            onClick={() => onRename("")}
          >
            {"\u21BA"}
          </button>
        </div>
      )}
    </div>
  );
}
