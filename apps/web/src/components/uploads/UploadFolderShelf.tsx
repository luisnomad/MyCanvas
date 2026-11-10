import { useMemo } from "react";
import { type AssetInfo } from "@mycanvas/shared";
import { type FolderView } from "../../utils/folders";
import { FolderIcon } from "../folders/FolderBar";
import { useAssetLibrary } from "./library";
import { folderCounts } from "./UploadFolders";

/**
 * "Your images" on the main screen: one card per upload folder with a few
 * of its pictures. A card opens the Uploads manager at that folder.
 */
export function UploadFolderShelf({ onOpen }: { onOpen: (view: FolderView) => void }) {
  const { assets, folders } = useAssetLibrary();
  const counts = useMemo(() => folderCounts(assets ?? []), [assets]);
  if (!assets) {
    return null;
  }

  const card = (key: string, view: FolderView, label: string, items: AssetInfo[], icon: boolean) => (
    <button key={key} type="button" className="upload-shelf-card" onClick={() => { onOpen(view); }}>
      <span className={`upload-shelf-mosaic count-${String(Math.min(items.length, 4))}`} aria-hidden="true">
        {items.slice(0, 4).map((info) => <img key={info.asset} src={`/assets/${info.asset}`} alt="" loading="lazy" />)}
        {items.length === 0 && <span className="upload-shelf-empty">Empty</span>}
      </span>
      <span className="upload-shelf-label">
        {icon && <FolderIcon />}
        <span className="upload-folder-name">{label}</span>
        <span className="folder-count">{items.length}</span>
      </span>
    </button>
  );

  return (
    <section className="upload-shelf" aria-label="Your images">
      <div className="section-header">
        <h2 className="section-title">Your images</h2>
        <button type="button" className="secondary" onClick={() => { onOpen({ kind: "all" }); }}>
          {`All uploads (${String(counts.get("all") ?? 0)})`}
        </button>
      </div>
      <div className="upload-shelf-grid">
        {folders.map((folder) => card(folder.id, { kind: "folder", id: folder.id }, folder.name, assets.filter((info) => info.folderId === folder.id), true))}
        {card("unfiled", { kind: "unfiled" }, "Unfiled", assets.filter((info) => info.folderId === undefined), false)}
      </div>
      {folders.length === 0 && <p className="muted upload-shelf-hint">Open Uploads to make folders for your images (logos, photos, per client…).</p>}
    </section>
  );
}
