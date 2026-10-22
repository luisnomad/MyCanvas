import { type DragEvent, useCallback, useMemo, useRef, useState } from "react";
import { type AssetInfo } from "@mycanvas/shared";
import { useEditorStore } from "../../store/editorStore";
import { AssetTile, type TileAction } from "./AssetTile";
import { DeleteAssetsDialog } from "./DeleteAssetsDialog";
import { ASSET_FILTERS, type AssetFilter, UPLOAD_ACCEPT, filterAssets, loadAssetSize, useAssetLibrary } from "./library";
import { UploadsManager } from "./UploadsManager";

/**
 * Editor drawer for the shared uploads library: upload (button or drop),
 * search, filter, click/drag to place, ⋯ menu per image, and a button
 * that opens the full Uploads manager.
 */
export function UploadsPanel() {
  const addImageLayer = useEditorStore((state) => state.addImageLayer);
  const addImageLayerAsBackground = useEditorStore((state) => state.addImageLayerAsBackground);
  const { assets, error, setError, upload, rename, remove } = useAssetLibrary();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<AssetFilter>("all");
  const [pendingDelete, setPendingDelete] = useState<AssetInfo[] | null>(null);
  const [managerOpen, setManagerOpen] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const visible = useMemo(() => filterAssets(assets ?? [], filter, query), [assets, filter, query]);

  const place = useCallback((asset: string, as: "layer" | "background") => {
    void loadAssetSize(asset)
      .then(({ width, height }) => {
        if (as === "background") {
          addImageLayerAsBackground(asset, width, height);
        } else {
          addImageLayer(asset, width, height);
        }
      })
      .catch(() => { setError("That image could not be loaded."); });
  }, [addImageLayer, addImageLayerAsBackground, setError]);

  const uploadFiles = (files: File[]) => {
    void upload(files).then((added) => {
      // One image: put it straight on the page, like before. Several: library only.
      const [only] = added;
      if (added.length === 1 && only) {
        place(only, "layer");
      }
    });
  };

  const actionsFor = (info: AssetInfo): TileAction[] => [
    { label: "Add to page", onClick: () => { place(info.asset, "layer"); } },
    { label: "Set as background", onClick: () => { place(info.asset, "background"); } },
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
    <div
      className={dropActive ? "uploads-panel drop-active" : "uploads-panel"}
      onDragOver={(e) => {
        if ([...e.dataTransfer.types].includes("Files")) {
          e.preventDefault();
          setDropActive(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setDropActive(false);
        }
      }}
      onDrop={onDrop}
    >
      <button type="button" className="primary block" onClick={() => fileInputRef.current?.click()}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M16 16l-4-4-4 4M12 12v9" />
          <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3" />
        </svg>
        Upload images
      </button>
      {error && <p className="form-error">{error}</p>}
      <div className="uploads-panel-tools">
        <input
          type="search"
          className="uploads-search"
          placeholder="Search uploads"
          value={query}
          onChange={(e) => { setQuery(e.target.value); }}
        />
        <select
          value={filter}
          aria-label="Filter uploads"
          onChange={(e) => { setFilter(e.target.value as AssetFilter); }}
        >
          {ASSET_FILTERS.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
        </select>
      </div>
      <button type="button" className="secondary block uploads-manage" onClick={() => { setManagerOpen(true); }}>
        Manage uploads
        {assets ? ` (${String(assets.length)})` : ""}
      </button>
      {assets && visible.length === 0 && (
        <p className="muted">{assets.length === 0 ? "No uploads yet. Drop images here." : "Nothing matches."}</p>
      )}
      <div className="asset-grid">
        {visible.map((info) => (
          <AssetTile
            key={info.asset}
            info={info}
            draggableToCanvas
            onActivate={() => { place(info.asset, "layer"); }}
            actions={actionsFor(info)}
            onRename={(name) => rename(info.asset, name)}
          />
        ))}
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
            uploadFiles(files);
          }
        }}
      />
      {pendingDelete && (
        <DeleteAssetsDialog
          items={pendingDelete}
          onCancel={() => { setPendingDelete(null); }}
          onConfirm={async () => {
            await remove(pendingDelete.map((info) => info.asset));
            setPendingDelete(null);
          }}
        />
      )}
      {managerOpen && <UploadsManager onClose={() => { setManagerOpen(false); }} onPlace={place} />}
    </div>
  );
}
