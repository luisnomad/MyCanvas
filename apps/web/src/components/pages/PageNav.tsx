import { useEditorStore } from "../../store/editorStore";

interface PageNavProps {
  stripOpen: boolean;
  onToggleStrip: () => void;
}

/** Bottom-bar page position ("2 / 5"), previous/next and the strip toggle. */
export function PageNav({ stripOpen, onToggleStrip }: PageNavProps) {
  const pages = useEditorStore((state) => state.design?.pages);
  const activePageId = useEditorStore((state) => state.activePageId);
  const setActivePage = useEditorStore((state) => state.setActivePage);
  if (!pages) {
    return null;
  }
  const index = pages.findIndex((page) => page.id === activePageId);
  const go = (offset: number) => {
    const target = pages[index + offset];
    if (target) {
      setActivePage(target.id);
    }
  };

  return (
    <div className="page-nav">
      <button
        type="button"
        className={stripOpen ? "secondary active" : "secondary"}
        aria-expanded={stripOpen}
        title="Show or hide page thumbnails"
        onClick={onToggleStrip}
      >
        Pages
      </button>
      <button type="button" className="secondary" aria-label="Previous page" title="Previous page (PageUp)" disabled={index <= 0} onClick={() => { go(-1); }}>
        ‹
      </button>
      <span className="page-position" aria-live="polite">
        {`${String(index + 1)} / ${String(pages.length)}`}
      </span>
      <button type="button" className="secondary" aria-label="Next page" title="Next page (PageDown)" disabled={index >= pages.length - 1} onClick={() => { go(1); }}>
        ›
      </button>
    </div>
  );
}
