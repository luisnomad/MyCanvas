import { useEffect } from "react";
import { BLOCK_KINDS, type BlockKind, type TextLayer, parseFontStyle } from "@mycanvas/shared";
import { allDesignLayers, useEditorStore } from "../../store/editorStore";
import { ensureFontsLoaded } from "../../utils/fonts";
import { FontPicker } from "../FontPicker";
import { FontWeightSelect } from "../FontWeightSelect";

const TEXT_KINDS = BLOCK_KINDS.filter((kind) => kind.id !== "image");

/** What a block kind without its own sample is laid out with (mirrors the layout engine). */
const FALLBACK_LABEL: Partial<Record<BlockKind, string>> = {
  title: "Heading, else Lead, else Body text",
  lead: "Body text",
  heading: "Lead, else Body text",
  body: "Lead",
  callout: "Body text",
};

/**
 * One place to decide which font goes where in a format: a row per block
 * kind, editing that kind's sample text (wherever it is in the format).
 */
export function FormatFontsDialog({ onClose }: { onClose: () => void }) {
  const design = useEditorStore((state) => state.design);
  const activePageId = useEditorStore((state) => state.activePageId);
  const updateLayersOnAnyPage = useEditorStore((state) => state.updateLayersOnAnyPage);

  // The first sample of each kind wins, as in the layout engine.
  const samples = new Map<BlockKind, TextLayer>();
  if (design) {
    for (const layer of allDesignLayers(design, activePageId)) {
      const role = layer.formatRole;
      if (layer.type === "text" && role?.kind === "sample" && !samples.has(role.block)) {
        samples.set(role.block, layer);
      }
    }
  }
  const sampleList = [...samples.values()];

  // Load the faces so each row's label previews its font.
  const fontKey = sampleList.map((layer) => `${layer.fontFamily}|${layer.fontStyle}`).join(",");
  useEffect(() => {
    // fontKey captures every family/style the rows show.
    void ensureFontsLoaded(sampleList);
  }, [fontKey]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  if (!design) {
    return null;
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) { onClose(); } }}>
      <div className="dialog format-fonts-dialog" role="dialog" aria-modal="true" aria-labelledby="format-fonts-title">
        <h2 id="format-fonts-title">Fonts</h2>
        <p className="muted format-fonts-intro">
          Which font each kind of block uses. Changes apply to the samples in this format, so new documents and re-flowed ones pick them up.
        </p>
        <div className="format-fonts-rows">
          {TEXT_KINDS.map(({ id, label }) => {
            const sample = samples.get(id);
            if (!sample) {
              return (
                <div key={id} className="format-fonts-row missing">
                  <span className="format-fonts-label">{label}</span>
                  <span className="muted format-fonts-missing">
                    {`No sample: uses ${FALLBACK_LABEL[id] ?? "Body text"}. To set one, select a text and choose "Sample: ${label}" in the inspector.`}
                  </span>
                </div>
              );
            }
            const { weight, italic } = parseFontStyle(sample.fontStyle);
            return (
              <div key={id} className="format-fonts-row">
                <span
                  className="format-fonts-label"
                  style={{ fontFamily: `"${sample.fontFamily}"`, fontWeight: weight, fontStyle: italic ? "italic" : "normal" }}
                >
                  {label}
                </span>
                <FontPicker
                  value={sample.fontFamily}
                  onApply={(fontFamily) => {
                    updateLayersOnAnyPage([{ id: sample.id, patch: { fontFamily } }]);
                  }}
                />
                <FontWeightSelect
                  fontFamily={sample.fontFamily}
                  fontStyle={sample.fontStyle}
                  onChange={(fontStyle) => {
                    updateLayersOnAnyPage([{ id: sample.id, patch: { fontStyle } }]);
                  }}
                />
              </div>
            );
          })}
        </div>
        <div className="dialog-actions">
          <button type="button" className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
