import { type DragEvent, type ReactNode, useEffect, useState } from "react";
import { type Folder } from "@mycanvas/shared";
import { DESIGN_DRAG_MIME, type FolderView, folderViewHash } from "../../utils/folders";

interface FolderBarProps {
  folders: Folder[];
  /** Design counts: "all", "unfiled" and per folder id. */
  counts: Map<string, number>;
  view: FolderView;
  onCreate: (name: string) => Promise<void>;
  onRename: (folder: Folder, name: string) => Promise<void>;
  onDelete: (folder: Folder) => void;
  /** A design card was dropped here; null = unfiled. */
  onDropDesign: (designId: string, folderId: string | null) => void;
}

export function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

/** Inline name input used for create and rename. Enter saves, Esc cancels. */
export function NameInput({ initial, onSave, onCancel }: { initial: string; onSave: (name: string) => Promise<void>; onCancel: () => void }) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = () => {
    const name = value.trim();
    if (!name || name === initial) {
      onCancel();
      return;
    }
    setBusy(true);
    onSave(name).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : "Could not save");
      setBusy(false);
    });
  };
  return (
    <span className="folder-name-input">
      <input
        value={value}
        maxLength={80}
        // Opened by an explicit "New folder" / "Rename" click.
        autoFocus
        disabled={busy}
        placeholder="Folder name"
        aria-label="Folder name"
        aria-invalid={error !== null}
        title={error ?? undefined}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
        }}
        onBlur={() => {
          if (!error) {
            save();
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            save();
          } else if (e.key === "Escape") {
            onCancel();
          }
        }}
      />
      {error && <span className="form-error folder-error">{error}</span>}
    </span>
  );
}

/**
 * Folder chips above the design grid: All, Unfiled, then each folder (e.g.
 * per customer) with a design count. Chips are links (the view lives in the
 * URL) and drop targets for design cards.
 */
export function FolderBar({ folders, counts, view, onCreate, onRename, onDelete, onDropDesign }: FolderBarProps) {
  const [creating, setCreating] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [dropKey, setDropKey] = useState<string | null>(null);

  useEffect(() => {
    if (!menuId) {
      return;
    }
    const onPointerDown = (e: PointerEvent) => {
      if (e.target instanceof Element && !e.target.closest(".folder-chip-menu, .folder-chip-more")) {
        setMenuId(null);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [menuId]);

  const dropProps = (key: string, folderId: string | null) => ({
    onDragOver: (e: DragEvent) => {
      if ([...e.dataTransfer.types].includes(DESIGN_DRAG_MIME)) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDropKey(key);
      }
    },
    onDragLeave: () => {
      setDropKey((current) => (current === key ? null : current));
    },
    onDrop: (e: DragEvent) => {
      const designId = e.dataTransfer.getData(DESIGN_DRAG_MIME);
      setDropKey(null);
      if (designId) {
        e.preventDefault();
        onDropDesign(designId, folderId);
      }
    },
  });

  const chip = (key: string, target: FolderView, label: ReactNode, count: number | undefined, folderId: string | null | undefined) => {
    const active = target.kind === view.kind && (target.kind !== "folder" || (view.kind === "folder" && view.id === target.id));
    const classes = ["folder-chip"];
    if (active) {
      classes.push("active");
    }
    if (dropKey === key) {
      classes.push("drop-target");
    }
    return (
      <a
        className={classes.join(" ")}
        href={folderViewHash(target)}
        aria-current={active ? "page" : undefined}
        {...(folderId === undefined ? {} : dropProps(key, folderId))}
      >
        {label}
        {count !== undefined && <span className="folder-count">{count}</span>}
      </a>
    );
  };

  return (
    <nav className="folder-bar" aria-label="Project folders">
      {chip("all", { kind: "all" }, "All designs", counts.get("all"), undefined)}
      {chip("unfiled", { kind: "unfiled" }, "Unfiled", counts.get("unfiled"), null)}
      {folders.map((folder) => (
        <span key={folder.id} className="folder-chip-wrap">
          {renamingId === folder.id
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
            : chip(
                folder.id,
                { kind: "folder", id: folder.id },
                (
                  <>
                    <FolderIcon />
                    <span className="folder-label">{folder.name}</span>
                  </>
                ),
                counts.get(folder.id) ?? 0,
                folder.id,
              )}
          {renamingId !== folder.id && (
            <button
              type="button"
              className="folder-chip-more"
              aria-label={`Folder actions for ${folder.name}`}
              aria-expanded={menuId === folder.id}
              onClick={() => { setMenuId((current) => (current === folder.id ? null : folder.id)); }}
            >
              ⋯
            </button>
          )}
          {menuId === folder.id && (
            <span className="folder-chip-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuId(null);
                  setRenamingId(folder.id);
                }}
              >
                Rename
              </button>
              <button
                type="button"
                role="menuitem"
                className="danger-text"
                onClick={() => {
                  setMenuId(null);
                  onDelete(folder);
                }}
              >
                Delete folder…
              </button>
            </span>
          )}
        </span>
      ))}
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
        : (
            <button type="button" className="folder-chip folder-new" onClick={() => { setCreating(true); }}>
              + New folder
            </button>
          )}
    </nav>
  );
}
