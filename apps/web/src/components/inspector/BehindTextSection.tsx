import { type ImageLayer } from "@mycanvas/shared";
import { DEFAULT_OUTLINE_WIDTH } from "../../utils/bg-removal";
import { type SectionProps, SliderField } from "./fields";
import { Panel } from "./Panel";

/**
 * On a subject cutout: what happens to text layers beneath it where the
 * subject covers them — hidden (classic) or drawn over it as outlines.
 */
export function BehindTextSection({ layer, patch, commit }: SectionProps<ImageLayer>) {
  if (!layer.cutout) {
    return null;
  }
  const behind = layer.behindText;
  return (
    <Panel title="Text behind subject">
      <div className="fill-field-head">
        <span>Covered letters</span>
        <div className="segmented" role="radiogroup" aria-label="Covered letters">
          <button
            type="button"
            role="radio"
            aria-checked={!behind}
            className={behind ? "" : "active"}
            onClick={() => { patch({ behindText: undefined }); }}
          >
            Hidden
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={Boolean(behind)}
            className={behind ? "active" : ""}
            onClick={() => {
              if (!behind) {
                patch({ behindText: { mode: "outline", width: DEFAULT_OUTLINE_WIDTH } });
              }
            }}
          >
            Outlined
          </button>
        </div>
      </div>
      {behind && (
        <SliderField
          label="Outline thickness"
          value={behind.width}
          min={1}
          max={20}
          step={0.5}
          onChange={(width) => { patch({ behindText: { ...behind, width } }, true); }}
          onCommit={commit}
        />
      )}
      <p className="muted panel-hint">
        Applies to text layers below this cutout. The outline uses each text&apos;s own font and color.
      </p>
    </Panel>
  );
}
