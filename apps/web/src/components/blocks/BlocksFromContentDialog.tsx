import { useEffect, useRef, useState } from "react";
import { type BlockTheme, type DesignSummary } from "@mycanvas/shared";
import { api } from "../../api";
import { useEditorStore } from "../../store/editorStore";
import { ensureFontLoaded } from "../../utils/fonts";
import { IMPORT_ACCEPT, importContentFile } from "../../utils/import";
import { DEFAULT_PICTURE_STYLE } from "../../utils/blocks/catalog";
import { THEMES, themeFromFormat } from "../../utils/blocks/themes";

export const BLOCK_PAGE_SIZES = [
  { id: "square", label: "Square · 1080 × 1080", width: 1080, height: 1080 },
  { id: "portrait", label: "Portrait 4:5 · 1080 × 1350", width: 1080, height: 1350 },
  { id: "story", label: "Story 9:16 · 1080 × 1920", width: 1080, height: 1920 },
  { id: "slides", label: "Slides 16:9 · 1920 × 1080", width: 1920, height: 1080 },
] as const;

export function ThemeSwatch({ theme }: { theme: BlockTheme }) {
  const { colors, fonts } = theme;
  return (
    <span className="theme-swatch" style={{ background: colors.background, color: colors.text }} aria-hidden="true">
      <span style={{ fontFamily: `"${fonts.heading.family}"`, fontWeight: Number.parseInt(fonts.heading.style, 10) || (fonts.heading.style.includes("bold") ? 700 : 400) }}>Aa</span>
      <span className="theme-swatch-dots">
        <i style={{ background: colors.primary }} />
        <i style={{ background: colors.surface }} />
        <i style={{ background: colors.text }} />
      </span>
    </span>
  );
}

/**
 * New design from content alone: the content is split into parts, each
 * drawn as a visual block (cover, steps, cards…) in one theme. The AI picks
 * the blocks when a text model is set up; otherwise the content's own
 * structure (headings, lists, callouts) decides.
 */
export function BlocksFromContentDialog({ formats, folderId, onClose }: { formats: DesignSummary[]; folderId?: string; onClose: () => void }) {
  const [name, setName] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [sizeId, setSizeId] = useState<(typeof BLOCK_PAGE_SIZES)[number]["id"]>("portrait");
  const [themeId, setThemeId] = useState(THEMES[0]?.id ?? "clear");
  const [formatThemes, setFormatThemes] = useState<BlockTheme[]>([]);
  const [aiReady, setAiReady] = useState(false);
  const [useAi, setUseAi] = useState(true);
  const [imageReady, setImageReady] = useState(false);
  const [usePictures, setUsePictures] = useState(true);
  const [pictureStyle, setPictureStyle] = useState("");
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ id: string; warnings: string[] } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void api.aiStatus().then((status) => {
      setAiReady(status.text);
      setImageReady(status.image);
    }).catch(() => undefined);
  }, []);

  // Themes from the person's formats: their fonts and colours.
  useEffect(() => {
    let cancelled = false;
    void Promise.all(formats.slice(0, 12).map((format) => api.getDesign(format.id).then(themeFromFormat).catch(() => null))).then((themes) => {
      if (!cancelled) {
        setFormatThemes(themes.filter((theme): theme is BlockTheme => theme !== null));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [formats]);

  const themes = [...THEMES, ...formatThemes];

  // The swatches show each theme's heading font.
  const fontKey = themes.map((entry) => `${entry.fonts.heading.family}|${entry.fonts.heading.style}`).join(",");
  useEffect(() => {
    for (const key of fontKey.split(",")) {
      const [family = "", style = "normal"] = key.split("|");
      void ensureFontLoaded(family, style);
    }
  }, [fontKey]);
  const theme = themes.find((entry) => entry.id === themeId) ?? THEMES[0];

  const importFile = async (file: File) => {
    setError(null);
    setProgress(`Importing ${file.name}…`);
    try {
      const imported = await importContentFile(
        file,
        async (blob, imageName) => (await api.uploadAsset(new File([blob], imageName, { type: blob.type }))).asset,
        { pagePerSourcePage: false },
      );
      if (!imported.markdown.trim()) {
        setError(imported.warnings[0] ?? `No text found in ${file.name}.`);
        return;
      }
      useEditorStore.getState().bumpAssetsVersion();
      setMarkdown(imported.markdown);
      if (!name.trim()) {
        setName(file.name.replace(/\.[^.]+$/, ""));
      }
    } catch (reason) {
      setError(reason instanceof Error ? `Couldn't import ${file.name}: ${reason.message}` : `Couldn't import ${file.name}`);
    } finally {
      setProgress(null);
    }
  };

  const run = async () => {
    if (!theme || !markdown.trim()) {
      return;
    }
    setError(null);
    try {
      const size = BLOCK_PAGE_SIZES.find((entry) => entry.id === sizeId) ?? BLOCK_PAGE_SIZES[1];
      const { planWithRules } = await import("../../utils/blocks/rules");
      const { repairPlan } = await import("../../utils/blocks/plan");
      const { drawParts, partsFromPlan } = await import("../../utils/blocks/build");
      const warnings: string[] = [];
      const pictures = usePictures && imageReady;
      let planned;
      if (useAi && aiReady) {
        const { planWithAi } = await import("../../utils/blocks/ai");
        try {
          const ai = await planWithAi(markdown, setProgress, { pictures });
          planned = ai.parts;
          warnings.push(...ai.warnings);
        } catch (reason) {
          warnings.push(`The AI couldn't plan the pages (${reason instanceof Error ? reason.message : "it failed"}), so they follow the content's structure instead.`);
          planned = planWithRules(markdown);
        }
      } else {
        setProgress("Choosing blocks…");
        planned = planWithRules(markdown);
      }
      const repaired = repairPlan(planned);
      if (repaired.length === 0) {
        throw new Error("No content to lay out. Add some text first.");
      }
      let parts = partsFromPlan(repaired);
      const style = pictureStyle.trim() || undefined;
      if (pictures) {
        const { makePictures } = await import("../../utils/blocks/pictures");
        // Without the AI's suggestions, the cover gets a picture of the title.
        if (!(useAi && aiReady)) {
          parts = parts.map((part, index) => (index === 0 && part.block === "cover" && !part.slots.image && part.slots.title ? { ...part, slots: { ...part.slots, imageQuery: [part.slots.title, part.slots.subtitle].filter(Boolean).join(". ") } } : part));
        }
        const made = await makePictures(parts, size.width, size.height, style, setProgress);
        parts = made.parts;
        if (made.failed.length > 0) {
          warnings.push(`${String(made.failed.length)} picture${made.failed.length === 1 ? "" : "s"} couldn't be made (${made.failed[0] ?? ""}). Those frames are empty: make one from the page's block panel, or drop an image in.`);
        }
        if (made.skipped > 0) {
          warnings.push(`${String(made.skipped)} more page${made.skipped === 1 ? "" : "s"} could have a picture. Make them from each page's block panel.`);
        }
        useEditorStore.getState().bumpAssetsVersion();
      }
      setProgress("Drawing pages…");
      const drawn = await drawParts(parts, theme, size.width, size.height);
      if (drawn.overflowing.length > 0) {
        warnings.push(`Text is long for its block on page ${drawn.overflowing.join(", ")}: it was drawn smaller. Shorten it there, or switch the page to another block.`);
      }
      const title = (/^#\s+(.+)$/m.exec(markdown)?.[1] ?? "").trim();
      setProgress("Saving…");
      const design = await api.createDesign({
        name: name.trim() || title || "Untitled carousel",
        width: size.width,
        height: size.height,
        pages: drawn.pages,
        folderId,
        blocks: { theme, parts: drawn.parts, markdown, generatedAt: new Date().toISOString(), ...(style ? { pictureStyle: style } : {}) },
      });
      if (warnings.length === 0) {
        window.location.hash = `#/edit/${design.id}`;
        return;
      }
      setResult({ id: design.id, warnings });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Couldn't make the design");
    } finally {
      setProgress(null);
    }
  };

  const busy = progress !== null;
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) { onClose(); } }}>
      <div className="dialog blocks-dialog" role="dialog" aria-modal="true" aria-labelledby="blocks-dialog-title">
        <h2 id="blocks-dialog-title">New design from content</h2>
        {result
          ? (
              <>
                <p>The design is ready. A few things to check:</p>
                <div className="content-warnings">
                  <ul>{result.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
                </div>
                <div className="dialog-actions">
                  <button type="button" className="secondary" onClick={onClose}>Close</button>
                  <button type="button" className="primary" onClick={() => { window.location.hash = `#/edit/${result.id}`; }}>Open the design</button>
                </div>
              </>
            )
          : (
              <>
                <p className="muted">
                  Paste or import your content. Each part becomes a page built from a visual block (cover, steps, cards, big numbers, quote…) in the theme you pick. You can switch any page&apos;s block, layout and colours afterwards.
                </p>
                <label className="field field-wide">
                  <span>Name</span>
                  <input value={name} maxLength={120} placeholder="Taken from the content's # title" onChange={(e) => { setName(e.target.value); }} />
                </label>
                <label className="field field-wide blocks-content">
                  <span>
                    Content
                    <button
                      type="button"
                      className="link-button"
                      disabled={busy}
                      title="Word, PowerPoint, PDF or Markdown"
                      onClick={(e) => {
                        e.preventDefault();
                        fileRef.current?.click();
                      }}
                    >
                      Import file…
                    </button>
                  </span>
                  <textarea
                    value={markdown}
                    rows={12}
                    spellCheck
                    placeholder={"# Title\n**A one-line promise**\n\n## A part\n1. First step: what to do\n2. Second step: and then\n\n> “A quote.” — Someone\n\nPlain paragraphs work too."}
                    onChange={(e) => { setMarkdown(e.target.value); }}
                  />
                </label>
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
                <div className="field-row">
                  <label className="field">
                    <span>Page size</span>
                    <select value={sizeId} onChange={(e) => { setSizeId(e.target.value as typeof sizeId); }}>
                      {BLOCK_PAGE_SIZES.map((size) => <option key={size.id} value={size.id}>{size.label}</option>)}
                    </select>
                  </label>
                </div>
                <fieldset className="blocks-themes">
                  <legend>Theme</legend>
                  {themes.map((entry) => (
                    <label key={entry.id} className={entry.id === themeId ? "blocks-theme selected" : "blocks-theme"} title={`${entry.fonts.heading.family} / ${entry.fonts.body.family}`}>
                      <input type="radio" name="blocks-theme" value={entry.id} checked={entry.id === themeId} onChange={() => { setThemeId(entry.id); }} />
                      <ThemeSwatch theme={entry} />
                      <span>{entry.id.startsWith("format:") ? `From “${entry.name}”` : entry.name}</span>
                    </label>
                  ))}
                </fieldset>
                <label className="ai-check">
                  <input type="checkbox" checked={useAi && aiReady} disabled={!aiReady} onChange={(e) => { setUseAi(e.target.checked); }} />
                  {aiReady
                    ? "Let the AI split the content and choose the blocks (it keeps your words, shortening only to fit)"
                    : "Without an AI text model, the content's headings, lists and quotes decide the blocks (AI settings are in your avatar menu)"}
                </label>
                {imageReady && (
                  <>
                    <label className="ai-check">
                      <input type="checkbox" checked={usePictures} onChange={(e) => { setUsePictures(e.target.checked); }} />
                      {useAi && aiReady
                        ? "Make pictures with the image model for the pages that suit one (the cover and a few others; each takes a while)"
                        : "Make a cover picture with the image model"}
                    </label>
                    {usePictures && (
                      <label className="field field-wide">
                        <span>Picture style</span>
                        <input value={pictureStyle} maxLength={300} placeholder={DEFAULT_PICTURE_STYLE} onChange={(e) => { setPictureStyle(e.target.value); }} />
                      </label>
                    )}
                  </>
                )}
                {progress && <p className="content-ai-busy" role="status">{progress}</p>}
                {error && <p className="form-error">{error}</p>}
                <div className="dialog-actions">
                  <button type="button" className="secondary" disabled={busy} onClick={onClose}>Cancel</button>
                  <button type="button" className="primary" disabled={busy || !markdown.trim()} onClick={() => { void run(); }}>
                    {busy ? "Working…" : "Make design"}
                  </button>
                </div>
              </>
            )}
      </div>
    </div>
  );
}
