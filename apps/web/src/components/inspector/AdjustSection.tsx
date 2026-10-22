import { type FrameLayer, type ImageAdjustments, type ImageLayer } from "@mycanvas/shared";
import { FILTER_PRESETS, hasAdjustments } from "../../utils/image-filters";
import { type SectionProps, SliderField } from "./fields";
import { Panel } from "./Panel";

const SLIDERS: { key: Exclude<keyof ImageAdjustments, "preset">; label: string; min: number; max: number }[] = [
  { key: "brightness", label: "Brightness", min: -100, max: 100 },
  { key: "contrast", label: "Contrast", min: -100, max: 100 },
  { key: "saturation", label: "Saturation", min: -100, max: 100 },
  { key: "hue", label: "Hue", min: -180, max: 180 },
  { key: "blur", label: "Blur", min: 0, max: 50 },
];

/**
 * Non-destructive filters, adjustments and flips for image layers and
 * filled frames. Rendered through canvas filters (see image-filters.ts), so
 * the original asset is untouched and everything is undoable.
 */
export function AdjustSection({ layer, patch, commit }: SectionProps<ImageLayer | FrameLayer>) {
  const asset = layer.type === "image" ? layer.asset : layer.content?.asset;
  if (!asset) {
    return null;
  }
  const adjust = layer.adjust ?? {};
  const setAdjust = (next: ImageAdjustments, transient: boolean) => {
    patch({ adjust: next }, transient);
  };

  return (
    <Panel title="Adjust">
      <div className="filter-presets">
        {FILTER_PRESETS.map((preset) => {
          const active = (adjust.preset ?? "none") === preset.id;
          return (
            <button
              key={preset.id}
              type="button"
              className={active ? "filter-tile active" : "filter-tile"}
              aria-pressed={active}
              onClick={() => { setAdjust({ ...adjust, preset: preset.id }, false); }}
            >
              <img
                src={`/assets/${asset}`}
                alt=""
                draggable={false}
                style={{ filter: preset.css || "none" }}
              />
              <span>{preset.label}</span>
            </button>
          );
        })}
      </div>
      {SLIDERS.map((slider) => (
        <SliderField
          key={slider.key}
          label={slider.label}
          value={adjust[slider.key] ?? 0}
          min={slider.min}
          max={slider.max}
          step={1}
          onChange={(value) => { setAdjust({ ...adjust, [slider.key]: value }, true); }}
          onCommit={commit}
        />
      ))}
      <div className="button-row">
        <button
          type="button"
          className={layer.flipX ? "secondary active" : "secondary"}
          aria-pressed={layer.flipX === true}
          onClick={() => { patch({ flipX: !layer.flipX }); }}
        >
          ⇋ Flip horizontal
        </button>
        <button
          type="button"
          className={layer.flipY ? "secondary active" : "secondary"}
          aria-pressed={layer.flipY === true}
          onClick={() => { patch({ flipY: !layer.flipY }); }}
        >
          ⇵ Flip vertical
        </button>
      </div>
      <button
        type="button"
        className="secondary"
        disabled={!hasAdjustments(layer.adjust)}
        onClick={() => { patch({ adjust: undefined }); }}
      >
        Reset adjustments
      </button>
    </Panel>
  );
}
