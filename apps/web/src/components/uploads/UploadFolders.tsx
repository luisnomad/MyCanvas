import { useEffect, useRef, useState } from "react";
import { type AssetInfo, type Folder } from "@mycanvas/shared";
import { type FolderView } from "../../utils/folders";
import { FolderIcon, NameInput } from "../folders/FolderBar";

/*
 * Upload folders: their own list, separate from design folders. "All
 * uploads" shows everything, "Unfiled" what's in no folder.
 */

const VIEW_KEY = "mycanvas-upload-folder";

function readView(): FolderView {
  try {
    const stored = JSON.parse(localStorage.getItem(VIEW_KEY) ?? "null") as FolderView | null;
    if (stored && (stored.kind === "all" || stored.kind === "unfiled" || (stored.kind === "folder" && typeof stored.id === "string"))) {
      return stored;
    }
  } catch {
    // Unreadable: start from all uploads.
  }
  return { kind: "all" };
}

/** The open upload folder, remembered on this device; falls back to all uploads when the folder is gone. */
export function useUploadFolderView(folders: Folder[] | null): [FolderView, (view: FolderView) => void] {
  const [view, setView] = useState<FolderView>(readView);
  const choose = (next: FolderView) => {
    setView(next);
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify(next));
    } catch {
      // Not remembered.
    }
  };
  const gone = view.kind === "folder" && folders !== null && !folders.some((folder) => folder.id === view.id);
  return [gone ? { kind: "all" } : view, choose];
}

/** The folder new uploads go into for a view (none for "All" and "Unfiled"). */
export function folderIdOf(view: FolderView): string | undefined {
  return view.kind === "folder" ? view.id : undefined;
}

export function folderCounts(assets: AssetInfo[]): Map<string, number> {
  const counts = new Map<string, number>([["all", assets.length], ["unfiled", 0]]);
  for (const info of assets) {
    const key = info.folderId ?? "unfiled";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function viewKey(view: FolderView): string {
  return view.kind === "folder" ? `folder:${view.id}` : view.kind;
}

/** Closes a popup on a click outside `root`. */
function useOutsideClose(open: boolean, close: () => void) {
  const root = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (e: PointerEvent) => {
      if (root.current && e.target instanceof Node && !root.current.contains(e.target)) {
        close();
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open, close]);
  return root;
}

interface FolderNavProps {
  folders: Folder[];
  counts: Map<string, number>;
  view: FolderView;
  onView: (view: FolderView) => void;
  onCreate: (name: string) => Promise<void>;
  onRename: (folder: Folder, name: string) => Promise<void>;
  onDelete: (folder: Folder) => void;
}

/** Folder list beside the Uploads manager's grid. */
export function UploadFolderNav({ folders, counts, view, onView, onCreate, onRename, onDelete }: FolderNavProps) {
  const [creating, setCreating] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const menuRoot = useOutsideClose(menuId !== null, () => { setMenuId(null); });

  const entry = (target: FolderView, label: string, count: number | undefined, folder?: Folder) => {
    const active = viewKey(target) === viewKey(view);
    return (
      <li key={viewKey(target)} className={active ? "active" : ""}>
        {renamingId !== null && folder?.id === renamingId
          ? (
              <NameInput
                initial={folder.name}
                onCancel={() => { setRenamingId(null); }}
                onSave={async (name) => {
                  await onRename(folder, name);
                  setRenamingId(null);
                }}
              />
            )
          : (
              <button type="button" className="upload-folder-link" aria-current={active ? "true" : undefined} onClick={() => { onView(target); }}>
                {folder && <FolderIcon />}
                <span className="upload-folder-name">{label}</span>
                <span className="folder-count">{count ?? 0}</span>
              </button>
            )}
        {folder && renamingId !== folder.id && (
          <span className="upload-folder-actions" ref={menuId === folder.id ? menuRoot : undefined}>
            <button
              type="button"
              className="folder-chip-more"
              aria-label={`Folder actions for ${folder.name}`}
              aria-expanded={menuId === folder.id}
              onClick={() => { setMenuId((current) => (current === folder.id ? null : folder.id)); }}
            >
              ⋯
            </button>
            {menuId === folder.id && (
              <span className="folder-chip-menu" role="menu">
                <button type="button" role="menuitem" onClick={() => { setMenuId(null); setRenamingId(folder.id); }}>Rename</button>
                <button type="button" role="menuitem" className="danger-text" onClick={() => { setMenuId(null); onDelete(folder); }}>Delete folder…</button>
              </span>
            )}
          </span>
        )}
      </li>
    );
  };

  return (
    <nav className="upload-folders" aria-label="Upload folders">
      <ul>
        {entry({ kind: "all" }, "All uploads", counts.get("all"))}
        {entry({ kind: "unfiled" }, "Unfiled", counts.get("unfiled"))}
        {folders.map((folder) => entry({ kind: "folder", id: folder.id }, folder.name, counts.get(folder.id), folder))}
      </ul>
      {creating
        ? (
            <NameInput
              initial=""
              onCancel={() => { setCreating(false); }}
              onSave={async (name) => {
                await onCreate(name);
                setCreating(false);
              }}
            />
          )
        : <button type="button" className="secondary block upload-folder-new" onClick={() => { setCreating(true); }}>+ New folder</button>}
    </nav>
  );
}

const NEW_FOLDER = "__new__";

/** Compact folder chooser for the editor's Uploads panel. */
export function UploadFolderSelect({ folders, counts, view, onView, onCreate }: Pick<FolderNavProps, "folders" | "counts" | "view" | "onView"> & { onCreate: (name: string) => Promise<Folder> }) {
  const [creating, setCreating] = useState(false);
  const value = view.kind === "folder" ? view.id : view.kind;
  if (creating) {
    return (
      <NameInput
        initial=""
        onCancel={() => { setCreating(false); }}
        onSave={async (name) => {
          const folder = await onCreate(name);
          setCreating(false);
          onView({ kind: "folder", id: folder.id });
        }}
      />
    );
  }
  return (
    <select
      className="upload-folder-select"
      aria-label="Upload folder"
      value={value}
      onChange={(e) => {
        const next = e.target.value;
        if (next === NEW_FOLDER) {
          setCreating(true);
        } else if (next === "all" || next === "unfiled") {
          onView({ kind: next });
        } else {
          onView({ kind: "folder", id: next });
        }
      }}
    >
      <option value="all">{`All uploads (${String(counts.get("all") ?? 0)})`}</option>
      <option value="unfiled">{`Unfiled (${String(counts.get("unfiled") ?? 0)})`}</option>
      {folders.map((folder) => <option key={folder.id} value={folder.id}>{`${folder.name} (${String(counts.get(folder.id) ?? 0)})`}</option>)}
      <option value={NEW_FOLDER}>+ New folder…</option>
    </select>
  );
}

/** "Move to folder" for selected uploads: every folder, plus a new one. */
export function MoveUploadsMenu({ folders, onMove, onCreate }: { folders: Folder[]; onMove: (folderId: string) => void; onCreate: (name: string) => Promise<Folder> }) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const root = useOutsideClose(open, () => { setOpen(false); setCreating(false); });
  return (
    <span className="move-to-folder" ref={root}>
      <button type="button" className="secondary" aria-haspopup="menu" aria-expanded={open} onClick={() => { setOpen((prev) => !prev); }}>
        Move to folder ▾
      </button>
      {open && (
        <span className="move-menu" role="menu">
          {folders.map((folder) => (
            <button key={folder.id} type="button" role="menuitem" onClick={() => { setOpen(false); onMove(folder.id); }}>
              <span className="move-check" aria-hidden="true" />
              {folder.name}
            </button>
          ))}
          {creating
            ? (
                <NameInput
                  initial=""
                  onCancel={() => { setCreating(false); }}
                  onSave={async (name) => {
                    const folder = await onCreate(name);
                    setCreating(false);
                    setOpen(false);
                    onMove(folder.id);
                  }}
                />
              )
            : (
                <button type="button" role="menuitem" onClick={() => { setCreating(true); }}>
                  <span className="move-check" aria-hidden="true" />
                  + New folder…
                </button>
              )}
        </span>
      )}
    </span>
  );
}
