import { useState } from "react";
import { useEditorStore } from "../../store/editorStore";

/** A format's instructions for the AI tools, in the person's own words. */
export function FormatAiDialog({ onClose }: { onClose: () => void }) {
  const formatAi = useEditorStore((state) => state.design?.formatAi);
  const setFormatAi = useEditorStore((state) => state.setFormatAi);
  const [contentRules, setContentRules] = useState(formatAi?.contentRules ?? "");
  const [illustrationStyle, setIllustrationStyle] = useState(formatAi?.illustrationStyle ?? "");

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) { onClose(); } }}>
      <div className="dialog format-ai-dialog" role="dialog" aria-modal="true" aria-labelledby="format-ai-title">
        <h2 id="format-ai-title">AI instructions</h2>
        <p className="muted format-fonts-intro">
          How the AI tools treat content for this format. Write them like a note to a colleague.
        </p>
        <label className="field field-wide">
          <span>Content rules (used by &quot;Tidy with AI&quot;)</span>
          <textarea
            rows={4}
            value={contentRules}
            maxLength={4000}
            placeholder={"Lines starting with IDEA CLAVE, SEÑAL CLAVE or ERROR FRECUENTE are callouts.\nThe question under each heading is a lead."}
            onChange={(e) => { setContentRules(e.target.value); }}
          />
        </label>
        <label className="field field-wide">
          <span>Illustration style (added to every picture)</span>
          <textarea
            rows={3}
            value={illustrationStyle}
            maxLength={4000}
            placeholder="Soft 3D clay illustration, pastel blue and warm yellow, isolated objects on a plain royal blue (#424DDB) background, friendly, isometric"
            onChange={(e) => { setIllustrationStyle(e.target.value); }}
          />
        </label>
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="primary"
            onClick={() => {
              setFormatAi({ contentRules: contentRules.trim(), illustrationStyle: illustrationStyle.trim() });
              onClose();
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
