import { useEffect, useRef, useState } from "react";
import { usePopoverPlacement } from "../hooks/usePopoverPlacement";
import { useViewSettings } from "../store/viewSettings";

const GRID_SIZES = [10, 20, 40, 50, 80, 100];

/** Bottom-bar popover: grid, grid size, snap to grid, smart guides. */
export function ViewMenu() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const popover = usePopoverPlacement(open);
  const { showGrid, gridSize, snapToGrid, smartGuides, showRulers, setView } = useViewSettings();

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && e.target instanceof Node && !rootRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="view-menu" ref={rootRef}>
      <button
        type="button"
        className={open ? "secondary active" : "secondary"}
        aria-expanded={open}
        onClick={() => { setOpen((prev) => !prev); }}
      >
        View
      </button>
      {open && (
        <div className="view-menu-popover" ref={popover.ref} style={popover.style}>
          <label className="checkbox-label">
            <input type="checkbox" checked={showGrid} onChange={(e) => { setView({ showGrid: e.target.checked }); }} />
            Show grid
            <kbd>'</kbd>
          </label>
          <label className="checkbox-label">
            <input type="checkbox" checked={showRulers} onChange={(e) => { setView({ showRulers: e.target.checked }); }} />
            Show rulers
            <kbd>⇧ R</kbd>
          </label>
          <label className="checkbox-label">
            <input type="checkbox" checked={snapToGrid} onChange={(e) => { setView({ snapToGrid: e.target.checked }); }} />
            Snap to grid
          </label>
          <label className="field field-wide">
            <span>Grid size</span>
            <select value={gridSize} onChange={(e) => { setView({ gridSize: Number(e.target.value) }); }}>
              {GRID_SIZES.map((size) => (
                <option key={size} value={size}>{`${String(size)} px`}</option>
              ))}
            </select>
          </label>
          <label className="checkbox-label">
            <input type="checkbox" checked={smartGuides} onChange={(e) => { setView({ smartGuides: e.target.checked }); }} />
            Smart guides
          </label>
        </div>
      )}
    </div>
  );
}
