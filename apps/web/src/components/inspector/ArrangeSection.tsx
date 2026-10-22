import { useEditorStore } from "../../store/editorStore";
import { type AlignMode, type Axis, alignSelection, distributeSelection } from "../../utils/arrange";
import { Panel } from "./Panel";

/** 16px glyph: a guide line plus two bars aligned (or spaced) against it. */
function AlignIcon({ axis, mode }: { axis: Axis; mode: AlignMode | "distribute" }) {
  const bars = mode === "distribute"
    ? [{ at: 2, len: 6 }, { at: 7, len: 10 }, { at: 12, len: 4 }]
    : [{ at: 4, len: 10 }, { at: 10, len: 6 }];
  const lineAt = mode === "min" ? 1.5 : mode === "max" ? 14.5 : 8;
  const start = (len: number) => (mode === "min" ? 3 : mode === "max" ? 13 - len : 8 - len / 2);
  const rects = bars.map((bar) => (mode === "distribute"
    ? { x: bar.at, y: 8 - bar.len / 2, w: 2.5, h: bar.len }
    : { x: start(bar.len), y: bar.at - 1.5, w: bar.len, h: 3 }));
  const transform = axis === "y" ? "rotate(90 8 8)" : undefined;
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <g transform={transform} fill="currentColor">
        {mode !== "distribute" && <rect x={lineAt - 0.5} y={1} width={1} height={14} opacity={0.55} />}
        {rects.map((r, i) => <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} rx={0.8} />)}
      </g>
    </svg>
  );
}

const ALIGN_BUTTONS: { axis: Axis; mode: AlignMode; label: string }[] = [
  { axis: "x", mode: "min", label: "Align left" },
  { axis: "x", mode: "center", label: "Align centers horizontally" },
  { axis: "x", mode: "max", label: "Align right" },
  { axis: "y", mode: "min", label: "Align top" },
  { axis: "y", mode: "center", label: "Align middles vertically" },
  { axis: "y", mode: "max", label: "Align bottom" },
];

/** Align the selected items to each other and space them evenly. */
export function ArrangeSection() {
  // Items, not layers: a group that isn't entered counts once.
  const count = useEditorStore((state) => {
    const keys = new Set(state.selectedLayerIds.map((id) => {
      const groupId = state.design?.layers.find((layer) => layer.id === id)?.groupId;
      return groupId && groupId !== state.editingGroupId ? `group:${groupId}` : id;
    }));
    return keys.size;
  });
  if (count < 2) {
    return null;
  }
  return (
    <Panel title="Arrange">
      <div className="arrange-grid">
        {ALIGN_BUTTONS.map((button) => (
          <button
            key={`${button.axis}-${button.mode}`}
            type="button"
            className="icon-tile"
            title={button.label}
            aria-label={button.label}
            onClick={() => { alignSelection(button.axis, button.mode); }}
          >
            <AlignIcon axis={button.axis} mode={button.mode} />
          </button>
        ))}
      </div>
      <div className="button-row">
        <button
          type="button"
          className="secondary"
          disabled={count < 3}
          title={count < 3 ? "Select 3 or more items" : "Equal horizontal gaps"}
          onClick={() => { distributeSelection("x"); }}
        >
          <AlignIcon axis="x" mode="distribute" />
          {" "}
          Space horizontally
        </button>
        <button
          type="button"
          className="secondary"
          disabled={count < 3}
          title={count < 3 ? "Select 3 or more items" : "Equal vertical gaps"}
          onClick={() => { distributeSelection("y"); }}
        >
          <AlignIcon axis="y" mode="distribute" />
          {" "}
          Space vertically
        </button>
      </div>
    </Panel>
  );
}
