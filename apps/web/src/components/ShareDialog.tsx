import { useCallback, useEffect, useState } from "react";
import { type ShareDownload, type ShareInfo, type ShareReview, type ShareState, api } from "../api";
import { useEditorStore } from "../store/editorStore";
import { onLive } from "../utils/live";
import { ShareActivityLog } from "./ShareActivity";

/*
 * Share a read-only, live view of the design (e.g. with a customer): anyone
 * with the link sees the design and its changes as they happen, but can't
 * edit. An optional PIN adds a second check. "New link" throws the old one
 * away; changing the PIN shuts out everyone let in with the old one.
 *
 * "Request approval" turns the link into the customer's sign-off: viewers
 * approve or ask for changes with their name. A review counts for the
 * revision it was given on; editing the design afterwards makes it out of
 * date, and the viewer is asked again. Approving means ticking a sign-off
 * text; the viewer then downloads the approved PDF, and each download is
 * logged (name, text, revision, PDF SHA-256, IP, browser) as proof.
 *
 * The public page is in Spanish unless the link is set to English.
 */

const PIN_PATTERN = /^[0-9]{4,8}$/;
const LANGUAGE_CHOICES: { label: string; value: "es" | "en" }[] = [
  { label: "Spanish", value: "es" },
  { label: "English", value: "en" },
];

const EXPIRY_CHOICES: { label: string; days: number | null }[] = [
  { label: "Never", days: null },
  { label: "In 1 day", days: 1 },
  { label: "In 7 days", days: 7 },
  { label: "In 30 days", days: 30 },
];

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** "5 minutes ago", "yesterday"… */
function ago(iso: string, now = Date.now()): string {
  const minutes = Math.round((now - Date.parse(iso)) / 60_000);
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (minutes < 60) {
    return format.format(-Math.max(0, minutes), "minute");
  }
  if (minutes < 60 * 24) {
    return format.format(-Math.round(minutes / 60), "hour");
  }
  return format.format(-Math.round(minutes / (60 * 24)), "day");
}

function expiryText(share: ShareInfo): string {
  if (!share.expiresAt) {
    return "Never expires";
  }
  return share.expired ? `Expired on ${when(share.expiresAt)}` : `Expires ${when(share.expiresAt)}`;
}

/** The design's share state, kept fresh from live events. */
function useShareState(designId: string): [ShareState | null, (state: ShareState) => void, boolean] {
  const [state, setState] = useState<ShareState | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => {
    api.getShare(designId).then((next) => { setState(next); setFailed(false); }).catch(() => { setFailed(true); });
  }, [designId]);
  useEffect(() => {
    load();
    return onLive((event) => {
      if ((event.type === "share.changed" && event.id === designId) || event.type === "reconnected") {
        load();
      }
    });
  }, [designId, load]);
  return [state, setState, failed];
}

type ApprovalState = "approved" | "changes" | "waiting" | "outdated";

/** Where the approval stands for the design's current revision. */
function approvalState(share: ShareInfo, revision: number): { state: ApprovalState; review: ShareReview | null } {
  const latest = share.reviews.at(-1) ?? null;
  if (!latest) {
    return { state: "waiting", review: null };
  }
  if (latest.revision < revision) {
    return { state: latest.decision === "approved" ? "outdated" : "waiting", review: latest };
  }
  return { state: latest.decision, review: latest };
}

const APPROVAL_LABEL: Record<ApprovalState, string> = {
  approved: "Approved",
  changes: "Changes requested",
  waiting: "Awaiting approval",
  outdated: "Approved an older version",
};

/** The top-bar pill: shown while the design's link asks for approval. */
export function ApprovalStatus({ designId, onOpen }: { designId: string; onOpen: () => void }) {
  const [state] = useShareState(designId);
  const revision = useEditorStore((s) => s.design?.revision ?? 0);
  const share = state?.share;
  if (!share?.approvalRequested) {
    return null;
  }
  const { state: where, review } = approvalState(share, revision);
  const by = review && (where === "approved" || where === "changes") ? ` · ${review.name}` : "";
  return (
    <button type="button" className={`approval-pill approval-${where}`} title="Open sharing and reviews" onClick={onOpen}>
      {APPROVAL_LABEL[where]}
      {by}
    </button>
  );
}

function shortSha(sha: string): string {
  return `${sha.slice(0, 12)}…`;
}

function DownloadLine({ download }: { download: ShareDownload }) {
  return (
    <li className="review-download" title={`SHA-256 ${download.sha256}\nIP ${download.ip ?? "unknown"}\n${download.userAgent ?? ""}\n${download.acknowledgement.text}`}>
      Downloaded by
      {" "}
      {download.name}
      {" · "}
      {when(download.at)}
      {" · PDF sha "}
      <code>{shortSha(download.sha256)}</code>
      {download.ip ? ` · ${download.ip}` : ""}
    </li>
  );
}

function ReviewList({ share, revision, downloads }: { share: ShareInfo; revision: number; downloads: ShareDownload[] }) {
  if (share.reviews.length === 0 && downloads.length === 0) {
    return <p className="muted">No answer yet. Viewers see Approve and Request changes buttons.</p>;
  }
  const byReview = new Map<string, ShareDownload[]>();
  for (const download of downloads) {
    byReview.set(download.reviewId, [...(byReview.get(download.reviewId) ?? []), download]);
  }
  const shown = new Set(share.reviews.map((review) => review.id));
  // Downloads whose approval isn't in the list (an older link, or a repeat folded away).
  const loose = downloads.filter((download) => !shown.has(download.reviewId));
  return (
    <ol className="review-list">
      {[...share.reviews].reverse().map((review) => {
        const taken = byReview.get(review.id) ?? [];
        const first = taken[0];
        return (
          <li key={review.id} className={`review review-${review.decision}`}>
            <div className="review-head">
              <strong>
                {review.decision === "approved" ? (first ? "Approved and downloaded" : "Approved") : "Changes requested"}
              </strong>
              {" · "}
              {review.name}
              <span className="muted">
                {" · "}
                {when(review.at)}
                {review.revision < revision ? " · on an older version" : ""}
                {` · v${String(review.revision)}`}
              </span>
            </div>
            {review.comment && <p className="review-comment">{review.comment}</p>}
            {review.acknowledgement && (
              <p className="review-ack muted" title={review.acknowledgement.text}>
                Signed off
                {review.ip ? ` from ${review.ip}` : ""}
              </p>
            )}
            {taken.length > 0 && (
              <ul className="review-downloads">
                {[...taken].reverse().map((download) => <DownloadLine key={download.id} download={download} />)}
              </ul>
            )}
          </li>
        );
      })}
      {loose.length > 0 && (
        <li className="review review-approved">
          <div className="review-head"><strong>Downloads</strong></div>
          <ul className="review-downloads">
            {[...loose].reverse().map((download) => <DownloadLine key={download.id} download={download} />)}
          </ul>
        </li>
      )}
    </ol>
  );
}

export function ShareDialog({ designId, onClose }: { designId: string; onClose: () => void }) {
  const [state, setState, failed] = useShareState(designId);
  const revision = useEditorStore((s) => s.design?.revision ?? 0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pin, setPin] = useState("");
  const [editingPin, setEditingPin] = useState(false);
  const [copied, setCopied] = useState(false);
  const [expiresInDays, setExpiresInDays] = useState<number | null>(null);
  const [askApproval, setAskApproval] = useState(false);
  const [language, setLanguage] = useState<"es" | "en">("es");

  const share = state?.share ?? null;
  const url = share ? `${(state?.publicUrl ?? window.location.origin).replace(/\/+$/, "")}${share.path}` : "";

  const run = async (action: () => Promise<ShareState>) => {
    setBusy(true);
    setError(null);
    try {
      setState(await action());
      setPin("");
      setEditingPin(false);
      setCopied(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const pinValid = PIN_PATTERN.test(pin);
  const pinField = (
    <input
      type="text"
      inputMode="numeric"
      autoComplete="off"
      className="share-pin-input"
      placeholder="4–8 digits"
      aria-label="PIN"
      maxLength={8}
      value={pin}
      onChange={(e) => {
        setPin(e.target.value.replace(/\D/g, ""));
      }}
    />
  );

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog share-dialog"
        role="dialog"
        aria-label="Share design"
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        <h2>Share</h2>
        <p className="muted">
          A read-only, live view of this design. People with the link see it, and your changes as you make them, but can't edit it.
        </p>

        {!state && !error && !failed && <p className="muted">Loading…</p>}
        {failed && !state && <p className="form-error">Couldn't load the sharing settings.</p>}

        {state && !share && (
          <>
            <label className="field field-wide">
              <span>PIN (optional)</span>
              {pinField}
            </label>
            <label className="field field-wide">
              <span>Link expires</span>
              <select
                value={String(expiresInDays)}
                onChange={(e) => {
                  setExpiresInDays(e.target.value === "null" ? null : Number(e.target.value));
                }}
              >
                {EXPIRY_CHOICES.map((choice) => (
                  <option key={choice.label} value={String(choice.days)}>{choice.label}</option>
                ))}
              </select>
            </label>
            <label className="field field-wide">
              <span>Page language for the viewer</span>
              <select value={language} onChange={(e) => { setLanguage(e.target.value === "en" ? "en" : "es"); }}>
                {LANGUAGE_CHOICES.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
              </select>
            </label>
            <label className="share-check">
              <input type="checkbox" checked={askApproval} onChange={(e) => { setAskApproval(e.target.checked); }} />
              <span>Request approval: viewers can approve (and then download the PDF) or ask for changes, with their name</span>
            </label>
            <div className="dialog-actions">
              <button type="button" className="secondary" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                disabled={busy || (pin !== "" && !pinValid)}
                onClick={() => {
                  void run(() => api.saveShare(designId, { ...(pin ? { pin } : {}), expiresInDays, approvalRequested: askApproval, language }));
                }}
              >
                {busy ? "Creating…" : "Create link"}
              </button>
            </div>
          </>
        )}

        {share && (
          <>
            <div className="share-link-row">
              <input type="text" readOnly value={url} aria-label="Share link" onFocus={(e) => { e.target.select(); }} />
              <button
                type="button"
                className="primary"
                onClick={() => {
                  void navigator.clipboard.writeText(url).then(() => { setCopied(true); }, () => { setError("Couldn't copy. Select the link and copy it."); });
                }}
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>

            <div className="share-pin-row">
              {editingPin
                ? (
                    <>
                      {pinField}
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy || !pinValid}
                        onClick={() => {
                          void run(() => api.saveShare(designId, { pin }));
                        }}
                      >
                        Save PIN
                      </button>
                      <button type="button" className="secondary" onClick={() => { setEditingPin(false); setPin(""); }}>
                        Cancel
                      </button>
                    </>
                  )
                : (
                    <>
                      <span>{share.hasPin ? "Protected with a PIN" : "No PIN: the link is enough"}</span>
                      <button type="button" className="secondary" disabled={busy} onClick={() => { setEditingPin(true); }}>
                        {share.hasPin ? "Change PIN" : "Add PIN"}
                      </button>
                      {share.hasPin && (
                        <button
                          type="button"
                          className="secondary"
                          disabled={busy}
                          onClick={() => {
                            void run(() => api.saveShare(designId, { pin: null }));
                          }}
                        >
                          Remove PIN
                        </button>
                      )}
                    </>
                  )}
            </div>
            {share.hasPin && !editingPin && (
              <p className="muted">Send the PIN separately from the link. Changing it signs out everyone who entered the old one.</p>
            )}

            <div className={share.expired ? "share-pin-row share-expired" : "share-pin-row"}>
              <span>{expiryText(share)}</span>
              <select
                aria-label="Change when the link expires"
                value=""
                disabled={busy}
                onChange={(e) => {
                  const days = e.target.value === "null" ? null : Number(e.target.value);
                  void run(() => api.saveShare(designId, { expiresInDays: days }));
                }}
              >
                <option value="" disabled>{share.expired ? "Extend…" : "Change…"}</option>
                {EXPIRY_CHOICES.map((choice) => (
                  <option key={choice.label} value={String(choice.days)}>{choice.days === null ? "Never expire" : `Expire ${choice.label.toLowerCase()}`}</option>
                ))}
              </select>
            </div>
            <div className="share-pin-row">
              <span>Viewer page in</span>
              <select
                aria-label="Language of the viewer page"
                value={share.language}
                disabled={busy}
                onChange={(e) => {
                  const next = e.target.value === "en" ? "en" : "es";
                  void run(() => api.saveShare(designId, { language: next }));
                }}
              >
                {LANGUAGE_CHOICES.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
              </select>
            </div>
            <label className="share-check">
              <input
                type="checkbox"
                checked={share.approvalRequested}
                disabled={busy}
                onChange={(e) => {
                  const on = e.target.checked;
                  void run(() => api.saveShare(designId, { approvalRequested: on }));
                }}
              />
              <span>Request approval</span>
            </label>
            {(share.approvalRequested || share.reviews.length > 0 || (state?.downloads?.length ?? 0) > 0) && (
              <ReviewList share={share} revision={revision} downloads={state?.downloads ?? []} />
            )}

            <ShareActivityLog designId={designId} />

            <p className="muted share-viewed">
              {share.lastViewedAt ? `Last viewed ${ago(share.lastViewedAt)}` : "Not viewed yet"}
            </p>

            <div className="dialog-actions share-actions">
              <button
                type="button"
                className="danger"
                disabled={busy}
                onClick={() => {
                  void run(() => api.stopShare(designId));
                }}
              >
                Stop sharing
              </button>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                title="The old link stops working"
                aria-label="New link (the old link stops working)"
                onClick={() => {
                  void run(() => api.saveShare(designId, { newLink: true }));
                }}
              >
                New link
              </button>
              <span className="share-actions-spacer" />
              <button type="button" className="primary" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        )}

        {error && <p className="form-error">{error}</p>}
      </div>
    </div>
  );
}
