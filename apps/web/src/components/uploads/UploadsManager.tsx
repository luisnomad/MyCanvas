import { type DragEvent, useEffect, useMemo, useRef, useState } from "react";
import { type AssetInfo } from "@mycanvas/shared";
import { relativeTime } from "../../utils/relative-time";
import { AssetTile, type TileAction } from "./AssetTile";
import { DeleteAssetsDialog } from "./DeleteAssetsDialog";
import {
  ASSET_FILTERS,
  type AssetFilter,
  UPLOAD_ACCEPT,
  filterAssets,
  formatBytes,
  loadAssetSize,
  usageOf,
  useAssetLibrary,
} from "./library";

interface UploadsManagerProps {
  onClose: () => void;
  /** Editor only: place an image on the open design. */
  onPlace?: (asset: string, as: "layer" | "background") => void;
}

/** Details for the focused upload: preview, size, date, where it's used. */
function AssetDetails({ info }: { info: AssetInfo }) {
  const [dims, setDims] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    setDims(null);
    let cancelled = false;
    void loadAssetSize(info.asset).then((size) => {
      if (!cancelled) {
        setDims(size);
      }
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [info.asset]);
  const uses = usageOf(info);

  return (
    <aside className="uploads-details">
      <div className="uploads-details-preview">
        <img src={`/assets/${info.asset}`} alt={info.name} />
      </div>
      <h3 title={info.name}>{info.name}</h3>
      <dl className="uploads-meta">
        <dt>Size</dt>
        <dd>{dims ? `${String(dims.width)} × ${String(dims.height)} px` : "…"}</dd>
        <dt>File</dt>
        <dd>{formatBytes(info.size)}</dd>
        <dt>Added</dt>
        <dd title={new Date(info.uploadedAt).toLocaleString()}>{relativeTime(info.uploadedAt)}</dd>
        {info.generated && (
          <>
            <dt>Source</dt>
            <dd>AI result</dd>
          </>
        )}
      </dl>
      <h4>{uses.length > 0 ? `Used in ${String(uses.length)}` : "Not used yet"}</h4>
      {uses.length > 0 && (
        <ul className="usage-list">
          {uses.map((use) => (
            <li key={`${use.kind}:${use.id}`}>
              <span className="usage-kind">{use.kind}</span>
              {use.kind === "design" ? <a href={`#/edit/${use.id}`}>{use.name}</a> : use.name}
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

/**
 * Full-size library window: search, filters, multi-select, bulk delete and
 * a details pane. Shared by every project.
 */
export function UploadsManager({ onClose, onPlace }: UploadsManagerProps) {
  const { assets, error, upload, rename, remove } = useAssetLibrary();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<AssetFilter>("all");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AssetInfo[] | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const visible = useMemo(() => filterAssets(assets ?? [], filter, query), [assets, filter, query]);
  const focused = assets?.find((info) => info.asset === focusedId) ?? visible[0];
  const totalBytes = (assets ?? []).reduce((sum, info) => sum + info.size, 0);
  const selectedInfos = (assets ?? []).filter((info) => selected.has(info.asset));

  // Drop selections that no longer exist (deleted elsewhere).
  useEffect(() => {
    if (!assets) {
      return;
    }
    setSelected((prev) => new Set([...prev].filter((id) => assets.some((info) => info.asset === id))));
  }, [assets]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !pendingDelete) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose, pendingDelete]);

  const toggle = (asset: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(asset)) {
        next.delete(asset);
      } else {
        next.add(asset);
      }
      return next;
    });
  };

  const actionsFor = (info: AssetInfo): TileAction[] => [
    ...(onPlace
      ? [
          { label: "Add to page", onClick: () => { onPlace(info.asset, "layer"); onClose(); } },
          { label: "Set as background", onClick: () => { onPlace(info.asset, "background"); onClose(); } },
        ]
      : []),
    { label: "Open full size", onClick: () => { window.open(`/assets/${info.asset}`, "_blank", "noopener"); } },
    { label: "Delete", danger: true, onClick: () => { setPendingDelete([info]); } },
  ];

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDropActive(false);
    const files = [...e.dataTransfer.files].filter((file) => file.type.startsWith("image/"));
    if (files.length > 0) {
      void upload(files);
    }
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className={dropActive ? "dialog uploads-manager drop-active" : "dialog uploads-manager"}
        role="dialog"
        aria-label="Uploads"
        onClick={(e) => {
          e.stopPropagation();
        }}
        onDragOver={(e) => {
          if ([...e.dataTransfer.types].includes("Files")) {
            e.preventDefault();
            setDropActive(true);
          }
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) {
            setDropActive(false);
          }
        }}
        onDrop={onDrop}
      >
        <header className="uploads-header">
          <div>
            <h2>Uploads</h2>
            <p className="muted">
              {assets ? `${String(assets.length)} images · ${formatBytes(totalBytes)} · shared by all designs` : "Loading…"}
            </p>
          </div>
          <div className="uploads-header-actions">
            <button type="button" className="primary" onClick={() => fileInputRef.current?.click()}>
              Upload images
            </button>
            <button type="button" className="secondary" onClick={onClose} aria-label="Close">✕</button>
          </div>
        </header>
        <div className="uploads-toolbar">
          <input
            type="search"
            className="uploads-search"
            placeholder="Search uploads"
            value={query}
            onChange={(e) => { setQuery(e.target.value); }}
          />
          <div className="segmented" role="radiogroup" aria-label="Filter uploads">
            {ASSET_FILTERS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="radio"
                aria-checked={filter === entry.id}
                className={filter === entry.id ? "active" : ""}
                onClick={() => { setFilter(entry.id); }}
              >
                {entry.label}
              </button>
            ))}
          </div>
          <span className="top-bar-spacer" />
          {selected.size > 0
            ? (
                <>
                  <span className="muted">{`${String(selected.size)} selected`}</span>
                  <button type="button" className="secondary" onClick={() => { setSelected(new Set()); }}>Clear</button>
                  <button type="button" className="danger" onClick={() => { setPendingDelete(selectedInfos); }}>
                    Delete selected
                  </button>
                </>
              )
            : (
                <button
                  type="button"
                  className="secondary"
                  disabled={!assets?.some((info) => usageOf(info).length === 0)}
                  onClick={() => {
                    setSelected(new Set((assets ?? []).filter((info) => usageOf(info).length === 0).map((info) => info.asset)));
                  }}
                >
                  Select unused
                </button>
              )}
        </div>
        {error && <p className="form-error">{error}</p>}
        <div className="uploads-body">
          <div className="uploads-grid-scroll">
            {assets && visible.length === 0 && (
              <p className="muted uploads-empty">
                {assets.length === 0 ? "No uploads yet. Drop images here or use Upload images." : "Nothing matches."}
              </p>
            )}
            <div className="asset-grid uploads-grid">
              {visible.map((info) => (
                <AssetTile
                  key={info.asset}
                  info={info}
                  focused={focused?.asset === info.asset}
                  onActivate={() => { setFocusedId(info.asset); }}
                  actions={actionsFor(info)}
                  onRename={(name) => rename(info.asset, name)}
                  selection={{ selected: selected.has(info.asset), onToggle: () => { toggle(info.asset); } }}
                />
              ))}
            </div>
          </div>
          {focused && <AssetDetails info={focused} />}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept={UPLOAD_ACCEPT}
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = "";
            if (files.length > 0) {
              void upload(files);
            }
          }}
        />
      </div>
      {pendingDelete && (
        <DeleteAssetsDialog
          items={pendingDelete}
          onCancel={() => { setPendingDelete(null); }}
          onConfirm={async () => {
            await remove(pendingDelete.map((info) => info.asset));
            setSelected(new Set());
            setPendingDelete(null);
          }}
        />
      )}
    </div>
  );
}
