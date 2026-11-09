import { useEffect, useRef, useState } from "react";
import { useEditorStore } from "../../store/editorStore";
import { canSeeImages } from "../../utils/ai-client";
import type { ReviewResult, Suggestion, Verdict } from "../../utils/format-review/review";

const VERDICTS: Record<Verdict, string> = {
  closer: "Checked: closer",
  measured: "Measured",
  judgment: "Your call",
  dropped: "Left out",
};

/**
 * AI review of a format against its example page. The model suggests edits;
 * each is measured and tested before it's listed, and only the ticked ones
 * are applied (as one undo step).
 */
export function FormatReviewDialog({ onClose }: { onClose: () => void }) {
  const showToast = useEditorStore((state) => state.showToast);
  const [stage, setStage] = useState<"checking" | "running" | "done" | "applying">("checking");
  const [blind, setBlind] = useState(false);
  const [progress, setProgress] = useState("Checking whether the AI model can see pictures…");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ReviewResult | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const started = useRef(false);

  useEffect(() => {
    if (started.current) {
      return;
    }
    started.current = true;
    void (async () => {
      try {
        const sees = await canSeeImages();
        setBlind(!sees);
        setStage("running");
        const { reviewFormat } = await import("../../utils/format-review/review");
        const review = await reviewFormat(setProgress, { ai: sees });
        setResult(review);
        // Only checked changes start ticked; judgment calls wait for the person.
        setTicked(new Set(review.suggestions.filter((suggestion) => suggestion.verdict === "closer" || suggestion.verdict === "measured").map((suggestion) => suggestion.id)));
        setStage("done");
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "The review failed");
        setStage("done");
      }
    })();
  }, []);

  const busy = stage === "checking" || stage === "running" || stage === "applying";
  const kept = result?.suggestions.filter((suggestion) => suggestion.verdict !== "dropped") ?? [];
  const left = result?.suggestions.filter((suggestion) => suggestion.verdict === "dropped") ?? [];
  const pages = new Set(result?.suggestions.map((suggestion) => suggestion.pageNumber));

  const apply = async () => {
    if (!result) {
      return;
    }
    const accepted = result.suggestions.filter((suggestion) => ticked.has(suggestion.id));
    setStage("applying");
    setProgress("Applying…");
    try {
      const { applySuggestions } = await import("../../utils/format-review/review");
      await applySuggestions(accepted, setProgress);
      showToast(`Applied ${String(accepted.length)} change${accepted.length === 1 ? "" : "s"}. Undo brings the format back as it was.`);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Couldn't apply the changes");
      setStage("done");
    }
  };

  const row = (suggestion: Suggestion) => (
    <li key={suggestion.id} className={`review-item review-${suggestion.verdict}`}>
      <label>
        <input
          type="checkbox"
          checked={ticked.has(suggestion.id)}
          disabled={suggestion.verdict === "dropped" || busy}
          onChange={(e) => {
            const next = new Set(ticked);
            if (e.target.checked) {
              next.add(suggestion.id);
            } else {
              next.delete(suggestion.id);
            }
            setTicked(next);
          }}
        />
        <span className="review-body">
          <span className="review-title">
            {pages.size > 1 && <span className="review-page">{`Page ${String(suggestion.pageNumber)}`}</span>}
            {suggestion.title}
          </span>
          {suggestion.why && <span className="review-why">{`AI: ${suggestion.why}`}</span>}
          <span className="review-note">
            <span className={`review-verdict verdict-${suggestion.verdict}`}>{VERDICTS[suggestion.verdict]}</span>
            {suggestion.note}
          </span>
        </span>
      </label>
    </li>
  );

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) { onClose(); } }}>
      <div className="dialog review-dialog" role="dialog" aria-modal="true" aria-labelledby="review-title">
        <h2 id="review-title">Review against the example</h2>
        <p className="muted format-fonts-intro">
          Compares this format with the example page it was made from. Text positions, sizes and colours are measured against the example; an AI model that can see pictures also looks for block kinds, boxes and callouts. Every fix is tried on the page first and listed only if it brings it closer to the example, or needs your judgment.
        </p>
        {busy && <p className="content-ai-busy" role="status">{progress}</p>}
        {blind && stage !== "checking" && (
          <p className="content-warnings">
            Only measured fixes (position, size, colour): the text model in your AI settings can&apos;t see pictures, so the AI part was skipped. A vision model (Gemini, Gemma 4, Qwen-VL…) also checks block kinds, boxes and callouts.
          </p>
        )}
        {error && <p className="form-error">{error}</p>}
        {result && (
          <>
            {kept.length > 0
              ? <ul className="review-list">{kept.map(row)}</ul>
              : <p>Nothing to change: the AI&apos;s suggestions didn&apos;t survive the checks, or it found the format already matches.</p>}
            {left.length > 0 && (
              <details className="review-left">
                <summary>{`Tried and left out (${String(left.length)})`}</summary>
                <ul className="review-list">{left.map(row)}</ul>
              </details>
            )}
            {result.notes.length > 0 && (
              <ul className="review-notes muted">{result.notes.map((note) => <li key={note}>{note}</li>)}</ul>
            )}
          </>
        )}
        <div className="dialog-actions">
          <button type="button" className="secondary" disabled={stage === "applying"} onClick={onClose}>
            {result && kept.length > 0 ? "Cancel" : "Close"}
          </button>
          {result && kept.length > 0 && (
            <button type="button" className="primary" disabled={busy || ticked.size === 0} onClick={() => { void apply(); }}>
              {ticked.size === 0 ? "Apply" : `Apply ${String(ticked.size)} change${ticked.size === 1 ? "" : "s"}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
