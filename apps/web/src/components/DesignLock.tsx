import { useState } from "react";
import { useEditorStore } from "../store/editorStore";

/*
 * The design lock in the editor (docs/AGENT_API.md, "Lock model"): who is
 * editing, Take over, Unlock, and the question asked when leaving a design
 * that is still locked to you.
 */

/** Top-bar status: "Locked by you" with Unlock, or "Claude is editing". */
export function LockStatus() {
  const lock = useEditorStore((state) => state.lock);
  const unlock = useEditorStore((state) => state.unlock);
  const [busy, setBusy] = useState(false);
  if (!lock) {
    return null;
  }
  if (lock.holder === "agent") {
    return (
      <span className="lock-pill agent" title={`${lock.label} has this design locked. Take over to edit it yourself.`}>
        <span className="lock-dot" aria-hidden="true" />
        {`${lock.label} is editing`}
      </span>
    );
  }
  return (
    <span className="lock-status">
      <span className="lock-pill mine" title="Your first edit locked this design. Claude can't change it until you unlock it.">
        <LockIcon />
        Locked by you
      </span>
      <button
        type="button"
        className="secondary"
        disabled={busy}
        title="Unlock the design so Claude can edit it"
        onClick={() => {
          setBusy(true);
          void unlock().finally(() => {
            setBusy(false);
          });
        }}
      >
        {busy ? "Unlocking…" : "Unlock"}
      </button>
    </span>
  );
}

/** Banner over the canvas while Claude holds the lock (the editor is view-only). */
export function AgentEditingBanner() {
  const lock = useEditorStore((state) => state.lock);
  const takeOver = useEditorStore((state) => state.takeOver);
  const [busy, setBusy] = useState(false);
  if (lock?.holder !== "agent") {
    return null;
  }
  return (
    <div className="agent-banner" role="status">
      <span className="agent-banner-pulse" aria-hidden="true" />
      <span>
        <strong>{`${lock.label} is editing.`}</strong>
        {" Changes appear here live. The design is view-only until you take over."}
      </span>
      <button
        type="button"
        className="primary"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void takeOver().finally(() => {
            setBusy(false);
          });
        }}
      >
        {busy ? "Taking over…" : "Take over"}
      </button>
    </div>
  );
}

interface LeaveDialogProps {
  onUnlockAndLeave: () => Promise<void>;
  onKeepAndLeave: () => void;
  onStay: () => void;
}

/** Asked when leaving a design that is still locked to you. */
export function LeaveLockedDialog({ onUnlockAndLeave, onKeepAndLeave, onStay }: LeaveDialogProps) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="dialog-backdrop" onClick={onStay}>
      <div
        className="dialog leave-locked-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="leave-locked-title"
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        <h2 id="leave-locked-title">This design is still locked to you</h2>
        <p className="muted">Claude can&apos;t edit it until you unlock it. You can unlock it later from the project list too.</p>
        <div className="dialog-actions">
          <button type="button" className="secondary" disabled={busy} onClick={onStay}>
            Stay
          </button>
          <button type="button" className="secondary" disabled={busy} onClick={onKeepAndLeave}>
            Keep locked and leave
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy}
            autoFocus
            onClick={() => {
              setBusy(true);
              void onUnlockAndLeave().finally(() => {
                setBusy(false);
              });
            }}
          >
            {busy ? "Unlocking…" : "Unlock and leave"}
          </button>
        </div>
      </div>
    </div>
  );
}

function LockIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}
