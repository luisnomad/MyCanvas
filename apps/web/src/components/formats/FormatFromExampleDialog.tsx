import { useEffect, useRef, useState } from "react";
import { type FormatAiInstructions } from "@mycanvas/shared";
import { api } from "../../api";
import { useEditorStore } from "../../store/editorStore";

interface Built {
  roles: { kind: string; label: string; font: string; exactFont: boolean; color: string; text: string }[];
  warnings: string[];
  designId: string;
}

/**
 * Learns a format from an example PDF: its masters, fonts, colours, spacing
 * and callout boxes, and (optionally) AI instructions for content and
 * illustrations. The result opens in the editor to check and adjust.
 */
export function FormatFromExampleDialog({ folderId, onClose }: { folderId?: string; onClose: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [useAi, setUseAi] = useState(true);
  const [aiReady, setAiReady] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [built, setBuilt] = useState<Built | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void api.aiStatus().then((status) => { setAiReady(status.text); }).catch(() => undefined);
  }, []);

  const run = async () => {
    if (!file) {
      return;
    }
    setError(null);
    try {
      setProgress("Reading the example…");
      const { analyzePdf } = await import("../../utils/format-from-example/analyze-pdf");
      const { buildFormat } = await import("../../utils/format-from-example/build-format");
      const analysis = await analyzePdf(file, 2);
      if (analysis.pages.every((page) => page.blocks.length === 0)) {
        throw new Error("This PDF has no real text (it's scanned, or its text was turned into pictures), so there's nothing to learn fonts and styles from yet.");
      }
      const baseName = name.trim() || file.name.replace(/\.[^.]+$/, "");
      const result = await buildFormat(analysis.pages, baseName, setProgress);
      let formatAi: FormatAiInstructions | undefined;
      const warnings = [...result.warnings];
      if (useAi && aiReady) {
        setProgress("Writing AI instructions…");
        try {
          const { describeExample } = await import("../../utils/format-from-example/describe");
          formatAi = await describeExample(analysis.pages);
        } catch (reason) {
          warnings.push(`AI instructions weren't written: ${reason instanceof Error ? reason.message : "the model failed"}. Add them later from Format → AI instructions.`);
        }
      }
      setProgress("Saving the format…");
      const design = await api.createDesign({ name: baseName, width: result.width, height: result.height, pages: result.pages, folderId });
      await api.updateDesign(design.id, { ...design, kind: "format", ...(formatAi ? { formatAi } : {}) });
      useEditorStore.getState().bumpAssetsVersion();
      setBuilt({ roles: result.roles, warnings, designId: design.id });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Couldn't learn from that file");
    } finally {
      setProgress(null);
    }
  };

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget && !progress) { onClose(); } }}>
      <div className="dialog example-dialog" role="dialog" aria-modal="true" aria-labelledby="example-title">
        <h2 id="example-title">New format from an example</h2>
        {built
          ? (
              <>
                <p className="muted">The format is ready. These are the looks it learned:</p>
                <ul className="example-roles">
                  {built.roles.map((role) => (
                    <li key={role.kind}>
                      <span className="example-swatch" style={{ background: role.color }} aria-hidden="true" />
                      <strong>{role.label}</strong>
                      <span>
                        {role.font}
                        {role.exactFont ? "" : " (stand-in)"}
                      </span>
                      <span className="muted example-text">{role.text}</span>
                    </li>
                  ))}
                </ul>
                {built.warnings.length > 0 && (
                  <div className="content-warnings">
                    <ul>{built.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
                  </div>
                )}
                <p className="muted example-next">
                  Check the background art: anything from the example&apos;s own content that should not repeat can be erased or deleted. The original page is kept as a hidden reference layer.
                </p>
                <div className="dialog-actions">
                  <button type="button" className="secondary" onClick={onClose}>Close</button>
                  <button type="button" className="primary" onClick={() => { window.location.hash = `#/edit/${built.designId}`; }}>Open the format</button>
                </div>
              </>
            )
          : (
              <>
                <p className="muted">
                  Give MyCanvas a PDF in the look you want (a brochure, a report, a carousel). It learns the page size, fonts, colours, spacing, callout boxes and background art, and makes a format you can fill with any content.
                </p>
                <div className="example-file">
                  <button type="button" className="secondary" disabled={progress !== null} onClick={() => { fileRef.current?.click(); }}>
                    {file ? "Choose another PDF…" : "Choose a PDF…"}
                  </button>
                  <span className="muted">{file ? file.name : "PDFs with real text work best (not scans)."}</span>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="application/pdf,.pdf"
                    hidden
                    onChange={(e) => {
                      const chosen = e.target.files?.[0] ?? null;
                      e.target.value = "";
                      setFile(chosen);
                      if (chosen && !name) {
                        setName(chosen.name.replace(/\.[^.]+$/, ""));
                      }
                    }}
                  />
                </div>
                <label className="field field-wide">
                  <span>Format name</span>
                  <input value={name} maxLength={120} onChange={(e) => { setName(e.target.value); }} />
                </label>
                <label className="ai-check">
                  <input type="checkbox" checked={useAi && aiReady} disabled={!aiReady} onChange={(e) => { setUseAi(e.target.checked); }} />
                  {aiReady ? "Write AI instructions too (content rules and illustration style, from the example)" : "AI instructions need a text model (AI settings, in your avatar menu)"}
                </label>
                {progress && <p className="content-ai-busy" role="status">{progress}</p>}
                {error && <p className="form-error">{error}</p>}
                <div className="dialog-actions">
                  <button type="button" className="secondary" disabled={progress !== null} onClick={onClose}>Cancel</button>
                  <button type="button" className="primary" disabled={!file || progress !== null} onClick={() => { void run(); }}>
                    {progress ? "Learning…" : "Make format"}
                  </button>
                </div>
              </>
            )}
      </div>
    </div>
  );
}
