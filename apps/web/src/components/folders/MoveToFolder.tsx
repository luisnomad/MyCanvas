import { useEffect, useRef, useState } from "react";
import { type Folder } from "@mycanvas/shared";

interface MoveToFolderProps {
  folders: Folder[];
  currentFolderId: string | undefined;
  /** null = unfiled. */
  onMove: (folderId: string | null) => void;
}

/** "Move" button on a design card with the list of folders to file it under. */
export function MoveToFolder({ folders, currentFolderId, onMove }: MoveToFolderProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && e.target instanceof Node && !rootRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  const item = (folderId: string | null, label: string) => {
    const current = (folderId ?? undefined) === currentFolderId;
    return (
      <button
        key={folderId ?? "unfiled"}
        type="button"
        role="menuitemradio"
        aria-checked={current}
        disabled={current}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(false);
          onMove(folderId);
        }}
      >
        <span className="move-check" aria-hidden="true">{current ? "✓" : ""}</span>
        {label}
      </button>
    );
  };

  return (
    <span className="move-to-folder" ref={rootRef}>
      <button
        type="button"
        className="secondary"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((prev) => !prev);
        }}
      >
        Move
      </button>
      {open && (
        <span
          className="move-menu"
          role="menu"
          onClick={(e) => { e.stopPropagation(); }}
          onKeyDown={(e) => { e.stopPropagation(); }}
        >
          {item(null, "Unfiled")}
          {folders.map((folder) => item(folder.id, folder.name))}
          {folders.length === 0 && <span className="muted move-empty">No folders yet</span>}
        </span>
      )}
    </span>
  );
}
