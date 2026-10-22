import { useEffect, useRef, useState } from "react";
import { type AssetInfo } from "@mycanvas/shared";
import { ASSET_DRAG_MIME, setCurrentAssetDrag } from "../../utils/frames";
import { usageOf } from "./library";

export interface TileAction {
  label: string;
  onClick: () => void;
  danger?: boolean;
}

interface AssetTileProps {
  info: AssetInfo;
  /** Primary click (add to page in the drawer, focus in the manager). */
  onActivate: () => void;
  actions: TileAction[];
  onRename: (name: string) => Promise<void>;
  /** Manager only: checkbox multi-select. */
  selection?: { selected: boolean; onToggle: (additive: boolean) => void };
  focused?: boolean;
  /** Drawer tiles can be dragged onto the canvas / into frames. */
  draggableToCanvas?: boolean;
}

/** Thumbnail with name, in-use badge, a ⋯ menu and inline rename. */
export function AssetTile({ info, onActivate, actions, onRename, selection, focused = false, draggableToCanvas = false }: AssetTileProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(info.name);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const uses = usageOf(info).length;

  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && e.target instanceof Node && !rootRef.current.contains(e.target)) {
        setMenuOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [menuOpen]);

  const commitRename = () => {
    setRenaming(false);
    const name = draft.trim();
    if (name && name !== info.name) {
      void onRename(name).catch(() => {
        setDraft(info.name);
      });
    } else {
      setDraft(info.name);
    }
  };

  const renderAction = (action: TileAction) => (
    <button
      key={action.label}
      type="button"
      role="menuitem"
      className={action.danger ? "danger-text" : undefined}
      onClick={() => {
        setMenuOpen(false);
        action.onClick();
      }}
    >
      {action.label}
    </button>
  );

  const classes = ["asset-tile"];
  if (selection?.selected) {
    classes.push("selected");
  }
  if (focused) {
    classes.push("focused");
  }

  return (
    <div className={classes.join(" ")} ref={rootRef}>
      <button
        type="button"
        className="asset-thumb"
        title={info.name}
        draggable={draggableToCanvas}
        onDragStart={(e) => {
          e.dataTransfer.setData(ASSET_DRAG_MIME, info.asset);
          e.dataTransfer.effectAllowed = "copy";
          setCurrentAssetDrag(info.asset);
        }}
        onDragEnd={() => {
          setCurrentAssetDrag(null);
        }}
        onClick={(e) => {
          if (selection && (e.metaKey || e.ctrlKey || e.shiftKey)) {
            selection.onToggle(true);
            return;
          }
          onActivate();
        }}
      >
        <img src={`/assets/${info.asset}`} alt={info.name} loading="lazy" draggable={false} />
        {!renaming && <span className="asset-name">{info.name}</span>}
      </button>
      {renaming && (
        <input
          className="asset-rename"
          value={draft}
          autoFocus
          aria-label="Image name"
          onChange={(e) => { setDraft(e.target.value); }}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              commitRename();
            } else if (e.key === "Escape") {
              e.stopPropagation();
              setDraft(info.name);
              setRenaming(false);
            }
          }}
        />
      )}
      {selection && (
        <label className="asset-check" title="Select">
          <input
            type="checkbox"
            checked={selection.selected}
            onChange={() => { selection.onToggle(true); }}
            aria-label={`Select ${info.name}`}
          />
        </label>
      )}
      {uses > 0 && (
        <span className="asset-badge" title={`Used in ${String(uses)} ${uses === 1 ? "place" : "places"}`}>
          {uses}
        </span>
      )}
      <button
        type="button"
        className="asset-menu-button"
        aria-label={`Actions for ${info.name}`}
        aria-expanded={menuOpen}
        onClick={() => { setMenuOpen((prev) => !prev); }}
      >
        ⋯
      </button>
      {menuOpen && (
        <div className="asset-menu" role="menu">
          {actions.filter((action) => !action.danger).map(renderAction)}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              setDraft(info.name);
              setRenaming(true);
            }}
          >
            Rename
          </button>
          {actions.filter((action) => action.danger).map(renderAction)}
        </div>
      )}
    </div>
  );
}
