import { type GradientFill } from "@mycanvas/shared";
import { GRADIENT_PRESETS, gradientCss } from "../../utils/gradients";
import { ColorInput } from "../ColorInput";
import { SliderField } from "./fields";

interface FillFieldProps {
  label: string;
  color: string;
  gradient: GradientFill | undefined;
  onColor: (color: string, transient: boolean) => void;
  /** undefined switches back to the solid color. */
  onGradient: (gradient: GradientFill | undefined, transient: boolean) => void;
  onCommit: () => void;
  disabled?: boolean;
}

const MAX_STOPS = 4;

/**
 * Solid/gradient fill control: a Solid | Gradient toggle, then either the
 * usual color input or gradient presets, type, angle and editable stops.
 */
export function FillField({ label, color, gradient, onColor, onGradient, onCommit, disabled = false }: FillFieldProps) {
  const setStop = (index: number, patch: Partial<GradientFill["stops"][number]>, transient: boolean) => {
    if (!gradient) {
      return;
    }
    const stops = gradient.stops.map((stop, i) => (i === index ? { ...stop, ...patch } : stop));
    onGradient({ ...gradient, stops }, transient);
  };

  return (
    <div className={disabled ? "fill-field disabled" : "fill-field"}>
      <div className="fill-field-head">
        <span>{label}</span>
        <div className="segmented" role="radiogroup" aria-label={`${label} type`}>
          <button
            type="button"
            role="radio"
            aria-checked={!gradient}
            className={gradient ? "" : "active"}
            disabled={disabled}
            onClick={() => { onGradient(undefined, false); }}
          >
            Solid
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={Boolean(gradient)}
            className={gradient ? "active" : ""}
            disabled={disabled}
            onClick={() => {
              if (!gradient) {
                // Start from the current color so the switch isn't jarring.
                onGradient({ type: "linear", angle: 90, stops: [{ offset: 0, color }, { offset: 1, color: "#1e1b4b" }] }, false);
              }
            }}
          >
            Gradient
          </button>
        </div>
      </div>
      {!gradient && (
        <ColorInput
          value={color}
          disabled={disabled}
          onChange={(next) => { onColor(next, true); }}
          onCommit={onCommit}
        />
      )}
      {gradient && (
        <>
          <div className="gradient-presets">
            {GRADIENT_PRESETS.map((preset, index) => (
              <button
                key={index}
                type="button"
                className="gradient-swatch"
                title="Apply gradient"
                style={{ background: gradientCss(preset) }}
                onClick={() => { onGradient(structuredClone(preset), false); }}
              />
            ))}
          </div>
          <div className="gradient-preview" style={{ background: gradientCss(gradient) }} />
          <label className="field field-wide">
            <span>Style</span>
            <select
              value={gradient.type}
              onChange={(e) => { onGradient({ ...gradient, type: e.target.value as GradientFill["type"] }, false); }}
            >
              <option value="linear">Linear</option>
              <option value="radial">Radial</option>
            </select>
          </label>
          {gradient.type === "linear" && (
            <SliderField
              label="Angle"
              value={gradient.angle}
              min={0}
              max={360}
              step={1}
              onChange={(angle) => { onGradient({ ...gradient, angle }, true); }}
              onCommit={onCommit}
            />
          )}
          {gradient.stops.map((stop, index) => (
            <div key={index} className="gradient-stop">
              <ColorInput
                compact
                label={`Stop ${String(index + 1)} color`}
                value={stop.color}
                onChange={(next) => { setStop(index, { color: next }, true); }}
                onCommit={onCommit}
              />
              <SliderField
                label={`Stop ${String(index + 1)}`}
                value={Math.round(stop.offset * 100)}
                min={0}
                max={100}
                step={1}
                onChange={(v) => { setStop(index, { offset: v / 100 }, true); }}
                onCommit={() => {
                  // Keep stops ascending (canvas gradients require it).
                  onGradient({ ...gradient, stops: [...gradient.stops].sort((a, b) => a.offset - b.offset) }, true);
                  onCommit();
                }}
              />
              {gradient.stops.length > 2 && (
                <button
                  type="button"
                  className="gradient-stop-remove"
                  title="Remove stop"
                  aria-label={`Remove stop ${String(index + 1)}`}
                  onClick={() => { onGradient({ ...gradient, stops: gradient.stops.filter((_, i) => i !== index) }, false); }}
                >
                  ×
                </button>
              )}
            </div>
          ))}
          {gradient.stops.length < MAX_STOPS && (
            <button
              type="button"
              className="secondary"
              onClick={() => {
                const last = gradient.stops[gradient.stops.length - 1];
                const before = gradient.stops[gradient.stops.length - 2];
                const offset = before && last ? (before.offset + last.offset) / 2 : 0.5;
                const stops = [...gradient.stops, { offset, color: last?.color ?? "#ffffff" }]
                  .sort((a, b) => a.offset - b.offset);
                onGradient({ ...gradient, stops }, false);
              }}
            >
              Add color stop
            </button>
          )}
        </>
      )}
    </div>
  );
}
