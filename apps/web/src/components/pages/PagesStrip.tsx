import { type DragEvent, useState } from "react";
import { type DesignPage } from "@mycanvas/shared";
import { useEditorStore } from "../../store/editorStore";

const PAGE_DRAG_MIME = "application/x-mycanvas-page";

function PageThumb({ page, width, height }: { page: DesignPage; width: number; height: number }) {
  if (page.thumbnail) {
    return <img src={page.thumbnail} alt="" draggable={false} />;
  }
  // Not rendered yet (e.g. a new page): show its background.
  return (
    <span
      className="page-thumb-blank"
      style={{
        aspectRatio: `${String(width)} / ${String(height)}`,
        background: page.background === "transparent" ? undefined : page.background,
      }}
    />
  );
}

/**
 * Thumbnail strip of every page (Canva-style overview): click to open,
 * drag to reorder, hover for duplicate/delete, "+" to add after the last.
 */
export function PagesStrip() {
  const design = useEditorStore((state) => state.design);
  const activePageId = useEditorStore((state) => state.activePageId);
  const setActivePage = useEditorStore((state) => state.setActivePage);
  const addPage = useEditorStore((state) => state.addPage);
  const deletePage = useEditorStore((state) => state.deletePage);
  const movePage = useEditorStore((state) => state.movePage);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  if (!design) {
    return null;
  }
  const pages = design.pages;

  const dropAt = (e: DragEvent, index: number) => {
    const pageId = e.dataTransfer.getData(PAGE_DRAG_MIME);
    setDropIndex(null);
    if (!pageId) {
      return;
    }
    e.preventDefault();
    const from = pages.findIndex((page) => page.id === pageId);
    // Dropping before the page right after itself is a no-op; account for removal.
    movePage(pageId, from < index ? index - 1 : index);
  };

  return (
    <div className="pages-strip" role="list" aria-label="Pages">
      {pages.map((page, index) => {
        const active = page.id === activePageId;
        const classes = ["page-card"];
        if (active) {
          classes.push("active");
        }
        if (dropIndex === index) {
          classes.push("drop-before");
        }
        if (dropIndex === index + 1 && index === pages.length - 1) {
          classes.push("drop-after");
        }
        return (
          <div
            key={page.id}
            role="listitem"
            className={classes.join(" ")}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(PAGE_DRAG_MIME, page.id);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => {
              if ([...e.dataTransfer.types].includes(PAGE_DRAG_MIME)) {
                e.preventDefault();
                const rect = e.currentTarget.getBoundingClientRect();
                setDropIndex(e.clientX < rect.left + rect.width / 2 ? index : index + 1);
              }
            }}
            onDragLeave={() => { setDropIndex(null); }}
            onDrop={(e) => { dropAt(e, dropIndex ?? index); }}
            onDragEnd={() => { setDropIndex(null); }}
          >
            <button
              type="button"
              className="page-card-open"
              aria-current={active ? "page" : undefined}
              aria-label={`Page ${String(index + 1)}`}
              onClick={() => { setActivePage(page.id); }}
            >
              <PageThumb page={page} width={design.width} height={design.height} />
            </button>
            <span className="page-card-number">{index + 1}</span>
            <span className="page-card-actions">
              <button
                type="button"
                title="Duplicate page"
                aria-label={`Duplicate page ${String(index + 1)}`}
                onClick={() => {
                  setActivePage(page.id);
                  addPage({ duplicate: true });
                }}
              >
                ⧉
              </button>
              <button
                type="button"
                title={pages.length > 1 ? "Delete page" : "A design needs at least one page"}
                aria-label={`Delete page ${String(index + 1)}`}
                disabled={pages.length <= 1}
                onClick={() => { deletePage(page.id); }}
              >
                ×
              </button>
            </span>
          </div>
        );
      })}
      <button
        type="button"
        className="page-card page-add"
        title="Add page (⌘/Ctrl+Enter)"
        aria-label="Add page"
        onClick={() => {
          const last = pages[pages.length - 1];
          if (last) {
            setActivePage(last.id);
          }
          addPage();
        }}
      >
        +
      </button>
    </div>
  );
}
