import { useEffect, useState } from "react";
import { type ShareInfo, type ShareState, api } from "../api";

/*
 * Share a read-only, live view of the design (e.g. with a customer): anyone
 * with the link sees the design and its changes as they happen, but can't
 * edit. An optional PIN adds a second check. "New link" throws the old one
 * away; changing the PIN shuts out everyone let in with the old one.
 */

const PIN_PATTERN = /^[0-9]{4,8}$/;
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

export function ShareDialog({ designId, onClose }: { designId: string; onClose: () => void }) {
  const [state, setState] = useState<ShareState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pin, setPin] = useState("");
  const [editingPin, setEditingPin] = useState(false);
  const [copied, setCopied] = useState(false);
  const [expiresInDays, setExpiresInDays] = useState<number | null>(null);

  useEffect(() => {
    api.getShare(designId).then(setState).catch(() => {
      setError("Couldn't load the sharing settings.");
    });
  }, [designId]);

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

        {!state && !error && <p className="muted">Loading…</p>}

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
            <div className="dialog-actions">
              <button type="button" className="secondary" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                disabled={busy || (pin !== "" && !pinValid)}
                onClick={() => {
                  void run(() => api.saveShare(designId, { ...(pin ? { pin } : {}), expiresInDays }));
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
