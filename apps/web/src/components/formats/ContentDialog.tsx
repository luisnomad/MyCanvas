import { useEffect, useRef, useState } from "react";
import { type Design, type DesignSummary, type DocumentSource } from "@mycanvas/shared";
import { api } from "../../api";
import { useEditorStore } from "../../store/editorStore";
import { CONTENT_SYNTAX, layoutDocument, parseContent } from "../../utils/document-format";
import { useAssetLibrary } from "../uploads/library";

type ContentDialogProps =
  | {
    /** Make a new document; the format list comes from the project list. */
    mode: "create";
    formats: DesignSummary[];
    initialFormatId?: string;
    folderId?: string;
    onClose: () => void;
  }
  | {
    /** Edit the open document's content and lay it out again. */
    mode: "reflow";
    source: DocumentSource;
    onClose: () => void;
  };

const EXAMPLE = `# Finance from
# day one

**You don't need a CFO on day one. You need to think about finance from day one.**

Finance is the language of business: it tells you whether your model works.

## 1. Comply

Bookkeeping, taxes and filings up to date.

> KEY SIGNAL · Close every month: catching mistakes early avoids surprises at year end.
`;

/** Thumbnail picker that inserts an image line at the cursor. */
function ImagePicker({ onPick }: { onPick: (asset: string, name: string) => void }) {
  const { assets } = useAssetLibrary();
  if (!assets) {
    return <p className="muted">Loading uploads…</p>;
  }
  if (assets.length === 0) {
    return <p className="muted">No uploads yet. Upload images from the editor&apos;s Uploads panel.</p>;
  }
  return (
    <div className="content-image-picker">
      {assets.map((info) => (
        <button key={info.asset} type="button" title={info.name} onClick={() => { onPick(info.asset, info.name); }}>
          <img src={`/assets/${info.asset}`} alt={info.name} loading="lazy" />
        </button>
      ))}
    </div>
  );
}

/**
 * Write or paste content and lay it out with a format. The same dialog makes
 * new documents and re-flows existing ones (with the format's latest version).
 */
export function ContentDialog(props: ContentDialogProps) {
  const [formatId, setFormatId] = useState(
    props.mode === "create" ? (props.initialFormatId ?? props.formats[0]?.id ?? "") : props.source.formatId,
  );
  const [name, setName] = useState("");
  const [markdown, setMarkdown] = useState(props.mode === "reflow" ? props.source.markdown : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Shown after a layout with problems; the next click goes ahead anyway. */
  const [warnings, setWarnings] = useState<string[] | null>(null);
  const [pickingImage, setPickingImage] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { onClose } = props;

  useEffect(() => {
    setWarnings(null);
  }, [markdown, formatId]);

  const insertAtCursor = (snippet: string) => {
    const area = textareaRef.current;
    const start = area?.selectionStart ?? markdown.length;
    const end = area?.selectionEnd ?? markdown.length;
    const before = markdown.slice(0, start);
    const glue = before === "" || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
    const next = `${before}${glue}${snippet}\n\n${markdown.slice(end).replace(/^\n+/, "")}`;
    setMarkdown(next);
    requestAnimationFrame(() => {
      const caret = before.length + glue.length + snippet.length + 2;
      area?.focus();
      area?.setSelectionRange(caret, caret);
    });
  };

  const run = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let format: Design;
      try {
        format = await api.getDesign(formatId);
      } catch {
        throw new Error("The format couldn't be loaded. Was it deleted?");
      }
      const result = await layoutDocument(format, parseContent(markdown));
      if (result.warnings.length > 0 && warnings === null) {
        setWarnings(result.warnings);
        return;
      }
      const source: DocumentSource = {
        formatId: format.id,
        formatName: format.name,
        markdown,
        generatedAt: new Date().toISOString(),
      };
      if (props.mode === "reflow") {
        const store = useEditorStore.getState();
        store.replacePages(result.pages, source);
        store.showToast(`Re-flowed into ${String(result.pages.length)} ${result.pages.length === 1 ? "page" : "pages"}`);
        onClose();
        return;
      }
      const firstTitle = parseContent(markdown).find((item) => item.kind === "title");
      const design = await api.createDesign({
        name: name.trim() || (firstTitle && "text" in firstTitle ? firstTitle.text.replace(/\n/g, " ") : `${format.name} document`),
        width: format.width,
        height: format.height,
        pages: result.pages,
        source,
        folderId: props.folderId,
      });
      window.location.hash = `#/edit/${design.id}`;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Couldn't lay out the content");
    } finally {
      setBusy(false);
    }
  };

  const actionLabel = props.mode === "create" ? "Create document" : "Re-flow";
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) { onClose(); } }}>
      <div className="dialog content-dialog" role="dialog" aria-modal="true" aria-labelledby="content-dialog-title">
        <h2 id="content-dialog-title">{props.mode === "create" ? "New document from a format" : "Edit content"}</h2>
        {props.mode === "create"
          ? (
              <div className="field-row">
                <label className="field field-wide">
                  <span>Format</span>
                  <select value={formatId} onChange={(e) => { setFormatId(e.target.value); }}>
                    {props.formats.map((format) => (
                      <option key={format.id} value={format.id}>{format.name}</option>
                    ))}
                  </select>
                </label>
                <label className="field field-wide">
                  <span>Name</span>
                  <input value={name} placeholder="From the title" maxLength={120} onChange={(e) => { setName(e.target.value); }} />
                </label>
              </div>
            )
          : (
              <p className="muted">
                Laid out again with the latest version of
                {" "}
                <strong>{props.source.formatName || "its format"}</strong>
                . This replaces every page, including edits made by hand; Undo brings them back.
              </p>
            )}
        <div className="content-editor">
          <label className="field field-wide content-text">
            <span>
              Content
              <button type="button" className="link-button" onClick={() => { setPickingImage((open) => !open); }}>
                {pickingImage ? "Close images" : "Insert image…"}
              </button>
            </span>
            <textarea
              ref={textareaRef}
              value={markdown}
              spellCheck
              placeholder={EXAMPLE}
              onChange={(e) => { setMarkdown(e.target.value); }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void run();
                }
              }}
            />
          </label>
          <aside className="content-syntax" aria-label="Content syntax">
            {pickingImage
              ? (
                  <ImagePicker
                    onPick={(asset, imageName) => {
                      insertAtCursor(`![${imageName.replace(/[[\]]/g, "")}](${asset})`);
                      setPickingImage(false);
                    }}
                  />
                )
              : (
                  <dl>
                    {CONTENT_SYNTAX.map((entry) => (
                      <div key={entry.syntax}>
                        <dt><code>{entry.syntax}</code></dt>
                        <dd>{entry.meaning}</dd>
                      </div>
                    ))}
                  </dl>
                )}
          </aside>
        </div>
        {warnings && (
          <div className="content-warnings" role="alert">
            <strong>Check before continuing:</strong>
            <ul>
              {warnings.map((warning) => <li key={warning}>{warning}</li>)}
            </ul>
          </div>
        )}
        {error && <p className="form-error">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="secondary" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy || !formatId || markdown.trim() === ""}
            title="⌘/Ctrl+Enter"
            onClick={() => { void run(); }}
          >
            {busy ? "Laying out…" : warnings ? `${actionLabel} anyway` : actionLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
