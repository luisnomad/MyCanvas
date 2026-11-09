import { useEffect, useRef, useState } from "react";
import { type DesignSummary } from "@mycanvas/shared";
import { useEditorStore } from "../../store/editorStore";
import { ContentDialog } from "./ContentDialog";

/**
 * Top-bar entry for document formats. On a format: what the pages mean,
 * "create a document" and "stop using as a format". On a document made from
 * a format: edit the content and re-flow it. Otherwise: "use as a format".
 */
export function FormatMenu() {
  const design = useEditorStore((state) => state.design);
  const setDesignKind = useEditorStore((state) => state.setDesignKind);
  const saveNow = useEditorStore((state) => state.saveNow);
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<"create" | "reflow" | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (e: PointerEvent) => {
      if (e.target instanceof Node && !rootRef.current?.contains(e.target)) {
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  if (!design) {
    return null;
  }
  const isFormat = design.kind === "format";
  const source = design.source;

  if (source && !isFormat) {
    return (
      <>
        <button
          type="button"
          className="secondary"
          title={`Edit the text and lay it out again with "${source.formatName}"`}
          onClick={() => { setDialog("reflow"); }}
        >
          Edit content
        </button>
        {dialog === "reflow" && <ContentDialog mode="reflow" source={source} onClose={() => { setDialog(null); }} />}
      </>
    );
  }

  const thisFormat: DesignSummary = {
    id: design.id,
    name: design.name,
    width: design.width,
    height: design.height,
    pageCount: design.pages.length,
    kind: "format",
    createdAt: design.createdAt,
    updatedAt: design.updatedAt,
  };

  return (
    <div className="format-menu" ref={rootRef}>
      <button
        type="button"
        className={isFormat ? "secondary active" : "secondary"}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => { setOpen((value) => !value); }}
      >
        {isFormat ? "Format ▾" : "Format"}
      </button>
      {open && (
        <div className="format-menu-pop" role="menu">
          {isFormat
            ? (
                <>
                  <p className="format-menu-help">
                    <strong>This design is a document format.</strong>
                    {" "}
                    Page 1 is the master for a document&apos;s first page; page 2 (if any) for the pages after it.
                    Select a layer and set its role in the inspector: a
                    {" "}
                    <em>Flow area</em>
                    {" "}
                    rectangle, a
                    {" "}
                    <em>Sample</em>
                    {" "}
                    text per block kind, an optional
                    {" "}
                    <em>Box</em>
                    {" "}
                    behind a sample. Everything else repeats as decoration.
                  </p>
                  <button
                    type="button"
                    role="menuitem"
                    className="primary"
                    onClick={() => {
                      setOpen(false);
                      // The dialog reads the format from the server.
                      void saveNow().then(() => { setDialog("create"); });
                    }}
                  >
                    New document from this format…
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="secondary"
                    onClick={() => {
                      setOpen(false);
                      setDesignKind(undefined);
                    }}
                  >
                    Stop using as a format
                  </button>
                </>
              )
            : (
                <>
                  <p className="format-menu-help">
                    A format turns written content into finished multi-page documents in this design&apos;s look.
                    Your pages become masters; mark where text flows and how each kind of block looks.
                  </p>
                  <button
                    type="button"
                    role="menuitem"
                    className="primary"
                    onClick={() => {
                      setOpen(false);
                      setDesignKind("format");
                    }}
                  >
                    Use this design as a format
                  </button>
                </>
              )}
        </div>
      )}
      {dialog === "create" && (
        <ContentDialog mode="create" formats={[thisFormat]} initialFormatId={design.id} folderId={design.folderId} onClose={() => { setDialog(null); }} />
      )}
    </div>
  );
}
