import { useEffect, useRef, useState } from "react";
import { type Design, type DesignSummary, type DocumentSource } from "@mycanvas/shared";
import { api } from "../../api";
import { useEditorStore } from "../../store/editorStore";
import { CONTENT_SYNTAX, layoutDocument, parseContent } from "../../utils/document-format";
import { generateImageAsset, illustrationPrompt, illustrationSize, insertImages, planIllustrations, tidyContent } from "../../utils/ai-content";
import { IMPORT_ACCEPT, importContentFile } from "../../utils/import";
import { relativeTime } from "../../utils/relative-time";
import { useAssetLibrary } from "../uploads/library";
import { type FormatStatus } from "./useFormatStatus";

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
    formatStatus: FormatStatus;
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

/** Which version of the format the document used, and whether it changed since. */
function FormatVersionNote({ source, status }: { source: DocumentSource; status: FormatStatus }) {
  const made = relativeTime(source.generatedAt);
  switch (status.state) {
    case "changed":
      return (
        <p className="format-version-note changed">
          {`The format has changed since this document was laid out (${made}; format saved ${relativeTime(status.formatUpdatedAt)}). Re-flow to apply it.`}
        </p>
      );
    case "current":
      return <p className="format-version-note">{`Laid out ${made} with the format's current version.`}</p>;
    case "missing":
      return <p className="format-version-note changed">The format was deleted, so this document can't be re-flowed. Its pages stay as they are.</p>;
    default:
      return null;
  }
}

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
  const [importing, setImporting] = useState(false);
  /** After an import: what was found, problems, and the text it replaced. */
  const [imported, setImported] = useState<{ summary: string; warnings: string[]; previous: string } | null>(null);
  const [pagePerSourcePage, setPagePerSourcePage] = useState(false);
  /** Which AI jobs are set up (null while checking). */
  const [aiReady, setAiReady] = useState<{ text: boolean; image: boolean } | null>(null);
  /** Progress of a running AI action. */
  const [aiBusy, setAiBusy] = useState<string | null>(null);
  const [illustrationCount, setIllustrationCount] = useState(3);

  useEffect(() => {
    void api.aiStatus().then(setAiReady).catch(() => { setAiReady({ text: false, image: false }); });
  }, []);
  const fileRef = useRef<HTMLInputElement>(null);
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

  const importFile = async (file: File) => {
    setImporting(true);
    setError(null);
    try {
      const result = await importContentFile(
        file,
        async (blob, imageName) => (await api.uploadAsset(new File([blob], imageName, { type: blob.type }))).asset,
        { pagePerSourcePage },
      );
      if (!result.markdown.trim()) {
        setError(result.warnings[0] ?? `No text found in ${file.name}.`);
        return;
      }
      // Imported images are new uploads: refresh the library everywhere.
      useEditorStore.getState().bumpAssetsVersion();
      setImported({ summary: result.summary, warnings: result.warnings, previous: markdown });
      setMarkdown(result.markdown);
      if (props.mode === "create" && !name.trim() && !/^# /m.test(result.markdown)) {
        setName(file.name.replace(/\.[^.]+$/, ""));
      }
    } catch (reason) {
      setError(reason instanceof Error ? `Couldn't import ${file.name}: ${reason.message}` : `Couldn't import ${file.name}`);
    } finally {
      setImporting(false);
    }
  };

  const loadFormat = async (): Promise<Design> => {
    try {
      return await api.getDesign(formatId);
    } catch {
      throw new Error("The format couldn't be loaded. Was it deleted?");
    }
  };

  const tidy = async () => {
    setError(null);
    setAiBusy("Tidying…");
    try {
      const format = await loadFormat();
      const before = markdown;
      const result = await tidyContent(before, format, setAiBusy);
      const share = result.total > 0 ? result.changed / result.total : 0;
      setMarkdown(result.markdown);
      setImported({
        summary: result.changed === 0
          ? "Tidied with AI: structure only, every word kept"
          : `Tidied with AI, but ${String(result.changed)} of ${String(result.total)} words changed (${result.examples.join(", ")})`,
        warnings: share > 0.02 ? ["The model changed the wording more than it should. Check the text, or restore the previous version."] : [],
        previous: before,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Tidying failed");
    } finally {
      setAiBusy(null);
    }
  };

  const illustrate = async () => {
    setError(null);
    setAiBusy("Choosing where pictures help…");
    try {
      const format = await loadFormat();
      const before = markdown;
      const plan = await planIllustrations(before, format, illustrationCount);
      if (plan.length === 0) {
        throw new Error("The text model didn't find places for illustrations.");
      }
      const size = illustrationSize(format);
      const placed: { after: number; line: string }[] = [];
      const failures: string[] = [];
      for (const [index, item] of plan.entries()) {
        setAiBusy(`Drawing illustration ${String(index + 1)} of ${String(plan.length)}…`);
        try {
          const asset = await generateImageAsset(illustrationPrompt(item.subject, format), size, item.subject);
          placed.push({ after: item.after, line: `![${item.subject.replace(/[[\]]/g, "")}](${asset})` });
        } catch (reason) {
          failures.push(reason instanceof Error ? reason.message : "An illustration failed");
          // The same problem would hit every image (no model, refused key…): stop.
          if (index === 0) {
            break;
          }
        }
      }
      if (placed.length === 0) {
        throw new Error(failures[0] ?? "No illustrations were made.");
      }
      useEditorStore.getState().bumpAssetsVersion();
      setMarkdown(insertImages(before, placed));
      setImported({
        summary: `Added ${String(placed.length)} ${placed.length === 1 ? "illustration" : "illustrations"} (saved in your Uploads)`,
        warnings: failures,
        previous: before,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Illustrating failed");
    } finally {
      setAiBusy(null);
    }
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
        formatUpdatedAt: format.updatedAt,
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
              <>
                <p className="muted">
                  Laid out again with the latest version of
                  {" "}
                  <strong>{props.source.formatName || "its format"}</strong>
                  . This replaces every page, including edits made by hand; Undo brings them back.
                </p>
                <FormatVersionNote source={props.source} status={props.formatStatus} />
              </>
            )}
        <div className="content-editor">
          <label className="field field-wide content-text">
            <span>
              Content
              <span className="content-tools">
                <button
                  type="button"
                  className="link-button"
                  disabled={importing}
                  title="Word, PowerPoint, PDF or Markdown: its text and images become the content below"
                  onClick={(e) => {
                    e.preventDefault();
                    fileRef.current?.click();
                  }}
                >
                  {importing ? "Importing…" : "Import file…"}
                </button>
                <label className="content-option" title="PowerPoint and PDF: each slide or page starts a new page">
                  <input type="checkbox" checked={pagePerSourcePage} onChange={(e) => { setPagePerSourcePage(e.target.checked); }} />
                  Page per slide
                </label>
                <button type="button" className="link-button" onClick={(e) => { e.preventDefault(); setPickingImage((open) => !open); }}>
                  {pickingImage ? "Close images" : "Insert image…"}
                </button>
              </span>
              <input
                ref={fileRef}
                type="file"
                accept={IMPORT_ACCEPT}
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) {
                    void importFile(file);
                  }
                }}
              />
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
        {imported && (
          <div className="content-imported" role="status">
            <span>
              {`Imported ${imported.summary}. Check the text, then lay it out.`}
              {imported.previous.trim() && (
                <button
                  type="button"
                  className="link-button"
                  onClick={() => {
                    setMarkdown(imported.previous);
                    setImported(null);
                  }}
                >
                  Restore previous text
                </button>
              )}
            </span>
            {imported.warnings.length > 0 && (
              <ul>
                {imported.warnings.map((warning) => <li key={warning}>{warning}</li>)}
              </ul>
            )}
          </div>
        )}
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
          <div className="content-ai" aria-label="AI tools">
            {aiBusy
              ? <span className="content-ai-busy" role="status">{aiBusy}</span>
              : (
                  <>
                    <button
                      type="button"
                      className="secondary"
                      disabled={!aiReady?.text || !markdown.trim() || busy}
                      title={aiReady?.text ? "Fix headings, callouts and broken lines with your text model; the words stay the same" : "Set up a text model in AI settings (your avatar menu)"}
                      onClick={() => { void tidy(); }}
                    >
                      Tidy with AI
                    </button>
                    <span className="content-ai-group">
                      <button
                        type="button"
                        className="secondary"
                        disabled={!aiReady?.text || !aiReady.image || !markdown.trim() || busy}
                        title={aiReady?.text && aiReady.image ? "Your text model picks the spots; your image model draws them in the format's style" : "Needs both a text and an image model in AI settings (your avatar menu)"}
                        onClick={() => { void illustrate(); }}
                      >
                        Add illustrations
                      </button>
                      <select
                        aria-label="How many illustrations"
                        value={illustrationCount}
                        disabled={!aiReady?.text || !aiReady.image || busy}
                        onChange={(e) => { setIllustrationCount(Number(e.target.value)); }}
                      >
                        {[1, 2, 3, 4, 5, 6].map((count) => <option key={count} value={count}>{count}</option>)}
                      </select>
                    </span>
                  </>
                )}
          </div>
          <button type="button" className="secondary" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy || aiBusy !== null || !formatId || markdown.trim() === ""}
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
