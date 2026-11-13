import { type LineLayer, type RectLayer, type ShapeLayer, controlForMidpoint } from "@mycanvas/shared";
import { ColorField, NumberField, type SectionProps } from "./fields";
import { FillField } from "./FillField";
import { Panel } from "./Panel";

/** Rectangle: size, fill, corner radius. */
export function RectSection({ layer, patch, commit }: SectionProps<RectLayer>) {
  return (
    <Panel title="Rectangle">
      <div className="field-grid">
        <NumberField
          label="Width"
          value={layer.width}
          min={1}
          onChange={(width) => {
            patch({ width }, true);
          }}
          onCommit={commit}
        />
        <NumberField
          label="Height"
          value={layer.height}
          min={1}
          onChange={(height) => {
            patch({ height }, true);
          }}
          onCommit={commit}
        />
        <NumberField
          label="Corner radius"
          value={layer.cornerRadius}
          min={0}
          onChange={(cornerRadius) => {
            patch({ cornerRadius }, true);
          }}
          onCommit={commit}
        />
      </div>
      <FillField
        label="Fill"
        color={layer.fill}
        gradient={layer.gradient}
        onColor={(fill, transient) => { patch({ fill }, transient); }}
        onGradient={(gradient, transient) => { patch({ gradient }, transient); }}
        onCommit={commit}
      />
    </Panel>
  );
}

/** Shape (triangle/hexagon/circle/semicircle/star): size, fill, corner radius (not circle). */
export function ShapeSection({ layer, patch, commit }: SectionProps<ShapeLayer>) {
  return (
    <Panel title="Shape">
      <div className="field-grid">
        <NumberField
          label="Width"
          value={layer.width}
          min={1}
          onChange={(width) => {
            patch({ width }, true);
          }}
          onCommit={commit}
        />
        <NumberField
          label="Height"
          value={layer.height}
          min={1}
          onChange={(height) => {
            patch({ height }, true);
          }}
          onCommit={commit}
        />
        {layer.shape !== "circle" && (
          <NumberField
            label="Corner radius"
            value={layer.cornerRadius ?? 0}
            min={0}
            onChange={(cornerRadius) => {
              patch({ cornerRadius }, true);
            }}
            onCommit={commit}
          />
        )}
      </div>
      <FillField
        label="Fill"
        color={layer.fill}
        gradient={layer.gradient}
        onColor={(fill, transient) => { patch({ fill }, transient); }}
        onGradient={(gradient, transient) => { patch({ gradient }, transient); }}
        onCommit={commit}
      />
    </Panel>
  );
}

/** Line: color, width, cap. */
/** A gentle arc to start from: the middle lifted by a quarter of the length. */
function bentControl(points: LineLayer["points"]): [number, number] {
  const [x1, y1, x2, y2] = points;
  const length = Math.hypot(x2 - x1, y2 - y1) || 1;
  // Lift perpendicular to the line (upwards for a left-to-right line).
  const lift = length / 4;
  const mid: [number, number] = [(x1 + x2) / 2 + ((y2 - y1) / length) * lift, (y1 + y2) / 2 - ((x2 - x1) / length) * lift];
  return controlForMidpoint(points, mid);
}

export function LineSection({ layer, patch, commit }: SectionProps<LineLayer>) {
  return (
    <Panel title="Line">
      <div className="field-grid">
        <ColorField
          label="Color"
          value={layer.strokeColor}
          onChange={(strokeColor) => {
            patch({ strokeColor }, true);
          }}
          onCommit={commit}
        />
        <NumberField
          label="Width"
          value={layer.strokeWidth}
          min={1}
          onChange={(strokeWidth) => {
            patch({ strokeWidth }, true);
          }}
          onCommit={commit}
        />
      </div>
      <label className="field field-wide">
        <span>Line cap</span>
        <select
          value={layer.lineCap}
          onChange={(e) => {
            patch({ lineCap: e.target.value as LineLayer["lineCap"] });
          }}
        >
          <option value="butt">Butt</option>
          <option value="round">Round</option>
          <option value="square">Square</option>
        </select>
      </label>
      <button
        type="button"
        className="secondary block"
        onClick={() => {
          patch({ control: layer.control ? undefined : bentControl(layer.points) });
        }}
      >
        {layer.control ? "Straighten" : "Bend into a curve"}
      </button>
      <p className="muted field-note">Drag the round handle in the middle of the line to bend it; double-click the handle to straighten.</p>
    </Panel>
  );
}
