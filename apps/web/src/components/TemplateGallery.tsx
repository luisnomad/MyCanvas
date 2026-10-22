import { type TemplateSummary } from "@mycanvas/shared";

interface TemplateGalleryProps {
  templates: TemplateSummary[];
  /** Template id currently being turned into a design (shows a busy state). */
  busyId: string | null;
  onUse: (template: TemplateSummary) => void;
  onDelete: (template: TemplateSummary) => void;
}

export function TemplateGallery({ templates, busyId, onUse, onDelete }: TemplateGalleryProps) {
  return (
    <div className="template-strip">
      {templates.map((template) => (
        <div
          key={template.id}
          className={busyId === template.id ? "template-card busy" : "template-card"}
          role="button"
          tabIndex={0}
          title={`Start a design from "${template.name}"`}
          onClick={() => {
            onUse(template);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              onUse(template);
            }
          }}
        >
          <div className="template-thumb">
            {template.thumbnail
              ? <img src={template.thumbnail} alt="" />
              : (
                  <span className="thumb-placeholder">
                    {`${String(template.width)} × ${String(template.height)}`}
                  </span>
                )}
            {!template.builtIn && (
              <button
                type="button"
                className="template-delete"
                aria-label={`Delete template ${template.name}`}
                title="Delete template"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(template);
                }}
              >
                ×
              </button>
            )}
          </div>
          <div className="design-meta">
            <strong>{template.name}</strong>
            <span className="muted">
              {`${String(template.width)} × ${String(template.height)} · ${template.builtIn ? "Starter" : "Yours"}`}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
