import { useCallback, useEffect, useRef, useState } from "react";
import { type Design } from "@mycanvas/shared";
import { CanvasStage } from "../components/CanvasStage";
import { setHeadlessMode, useEditorStore } from "../store/editorStore";
import { useViewSettings } from "../store/viewSettings";
import { loadCustomFonts } from "../utils/custom-fonts";
import { onLive } from "../utils/live";

/*
 * A share link (/s/<token>): the design alone, read-only, for someone
 * outside MyCanvas. It draws with the editor's own canvas (so it is the
 * real design, not a render) and follows changes live.
 *
 * When the link asks for approval, a bar lets the viewer approve the design
 * or ask for changes, signing with their name (remembered on this device).
 */

type Status = "loading" | "pin" | "ready" | "gone" | "expired" | "error";

interface Review { name: string; decision: "approved" | "changes"; comment: string; at: string; revision: number }
interface Approval { requested: boolean; revision: number; latest: Review | null }

const NAME_KEY = "mycanvas.reviewerName";

function savedName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

function rememberName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // Private window: the name just isn't remembered.
  }
}

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** The approval bar under the design. */
function ApprovalBar({ base, approval, onDone }: { base: string; approval: Approval; onDone: (approval: Approval) => void }) {
  const [decision, setDecision] = useState<Review["decision"] | null>(null);
  const [name, setName] = useState(savedName);
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const latest = approval.latest;
  const current = latest?.revision === approval.revision ? latest : null;

  const send = async () => {
    if (!decision) {
      return;
    }
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`${base}/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), decision, comment: comment.trim(), revision: approval.revision }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; approval?: Approval | null };
      if (!res.ok) {
        setError(body.error ?? "That didn't work. Try again.");
        return;
      }
      rememberName(name.trim());
      setDecision(null);
      setComment("");
      if (body.approval) {
        onDone(body.approval);
      }
    } catch {
      setError("Couldn't send it. Check your connection and try again.");
    } finally {
      setSending(false);
    }
  };

  if (decision) {
    const needsComment = decision === "changes";
    return (
      <form
        className="shared-approval shared-approval-form"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <strong>{decision === "approved" ? "Approve this design" : "Request changes"}</strong>
        <input
          type="text"
          aria-label="Your name"
          placeholder="Your name"
          autoComplete="name"
          maxLength={80}
          value={name}
          onChange={(e) => { setName(e.target.value); }}
        />
        <textarea
          aria-label={needsComment ? "What should change" : "Comment (optional)"}
          placeholder={needsComment ? "What should change?" : "Comment (optional)"}
          maxLength={2000}
          rows={needsComment ? 4 : 2}
          value={comment}
          onChange={(e) => { setComment(e.target.value); }}
        />
        {error && <p className="shared-error" role="alert">{error}</p>}
        <div className="shared-approval-actions">
          <button type="button" className="secondary" onClick={() => { setDecision(null); setError(null); }}>Cancel</button>
          <button type="submit" className="primary" disabled={sending || !name.trim() || (needsComment && !comment.trim())}>
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
      </form>
    );
  }

  return (
    <div className="shared-approval">
      <span className="shared-approval-status">
        {current
          ? current.decision === "approved"
            ? `Approved by ${current.name} · ${when(current.at)}`
            : `Changes requested by ${current.name} · ${when(current.at)}`
          : latest
            ? "Updated since the last review. Please take another look."
            : "Your approval is requested."}
      </span>
      <div className="shared-approval-actions">
        <button type="button" className="secondary" onClick={() => { setDecision("changes"); }}>Request changes</button>
        <button type="button" className="primary" onClick={() => { setDecision("approved"); }}>Approve</button>
      </div>
    </div>
  );
}

export function SharedView({ token }: { token: string }) {
  const base = `/s/${token}`;
  const design = useEditorStore((state) => state.design);
  const activePageId = useEditorStore((state) => state.activePageId);
  const [status, setStatus] = useState<Status>("loading");
  const [fit, setFit] = useState(1);
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [approval, setApproval] = useState<Approval | null>(null);
  const loadingRef = useRef(false);
  const againRef = useRef(false);

  /** Fetches the design (again); one request at a time, the latest wins. */
  const refresh = useCallback(async () => {
    if (loadingRef.current) {
      againRef.current = true;
      return;
    }
    loadingRef.current = true;
    try {
      const res = await fetch(`${base}/design`, { cache: "no-store" });
      if (res.status === 401) {
        setStatus("pin");
      } else if (res.status === 404) {
        setStatus("gone");
      } else if (res.status === 410) {
        setStatus("expired");
      } else if (!res.ok) {
        setStatus("error");
      } else {
        const body = (await res.json()) as { design: Design; approval?: Approval };
        useEditorStore.getState().presentDesign(body.design);
        setApproval(body.approval ?? null);
        document.title = body.design.name || "Shared design";
        setStatus("ready");
      }
    } catch {
      // Offline for a moment: keep showing what we have.
      setStatus((current) => (current === "loading" ? "error" : current));
    } finally {
      loadingRef.current = false;
      if (againRef.current) {
        againRef.current = false;
        void refresh();
      }
    }
  }, [base]);

  useEffect(() => {
    setHeadlessMode(true);
    // A visitor's own grid/ruler settings never show on someone else's design.
    useViewSettings.setState({ showGrid: false, showRulers: false });
    void loadCustomFonts();
    void refresh();
  }, [refresh]);

  // Live: the stream only carries this design's changes (and font changes).
  useEffect(() => {
    if (status !== "ready") {
      return;
    }
    return onLive((event) => {
      if (event.type === "fonts.changed") {
        void loadCustomFonts();
      } else if (event.type === "design.deleted") {
        setStatus("gone");
      } else if (event.type === "design.updated" || event.type === "share.changed" || event.type === "reconnected") {
        void refresh();
      }
    });
  }, [status, refresh]);

  const pages = design?.pages ?? [];
  const pageIndex = Math.max(0, pages.findIndex((page) => page.id === activePageId));
  const goToPage = useCallback((index: number) => {
    const page = useEditorStore.getState().design?.pages[index];
    if (page) {
      useEditorStore.getState().setActivePage(page.id);
    }
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === "PageDown") {
        goToPage(pageIndex + 1);
      } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
        goToPage(pageIndex - 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [goToPage, pageIndex]);

  const unlock = async () => {
    setChecking(true);
    setPinError(null);
    try {
      const res = await fetch(`${base}/unlock`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pin: pin.trim() }),
      });
      if (res.ok) {
        setPin("");
        await refresh();
        return;
      }
      if (res.status === 410) {
        setStatus("expired");
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setPinError(body.error ?? "That PIN isn't right");
    } catch {
      setPinError("Couldn't check the PIN. Try again.");
    } finally {
      setChecking(false);
    }
  };

  if (status === "pin") {
    return (
      <div className="shared-view shared-message">
        <form
          className="shared-pin"
          onSubmit={(e) => {
            e.preventDefault();
            void unlock();
          }}
        >
          <h1>This design is protected</h1>
          <p>Enter the PIN you were given to see it.</p>
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            autoFocus
            aria-label="PIN"
            maxLength={8}
            value={pin}
            onChange={(e) => {
              setPin(e.target.value.replace(/\D/g, ""));
            }}
          />
          {pinError && <p className="shared-error" role="alert">{pinError}</p>}
          <button type="submit" className="primary" disabled={checking || pin.length < 4}>
            {checking ? "Checking…" : "View design"}
          </button>
        </form>
      </div>
    );
  }

  if (status === "gone" || status === "expired" || status === "error" || status === "loading" || !design) {
    return (
      <div className="shared-view shared-message">
        <p>
          {status === "gone"
            ? "This design isn't shared any more."
            : status === "expired"
              ? "This link has expired. Ask the person who shared it for a new one."
              : status === "error"
                ? "The design couldn't be loaded. Check your connection and reload the page."
                : "Loading…"}
        </p>
      </div>
    );
  }

  return (
    <div className="shared-view">
      {/* The page switcher sits at the bottom of the design area, above the approval bar. */}
      <div className="shared-stage">
        <div className="shared-canvas" inert>
          <CanvasStage design={design} scale={fit} onFitScale={setFit} />
        </div>
        {pages.length > 1 && (
          <nav className="shared-pages" aria-label="Pages">
            <button type="button" disabled={pageIndex === 0} aria-label="Previous page" onClick={() => { goToPage(pageIndex - 1); }}>‹</button>
            <span>
              {pageIndex + 1}
              {" "}
              /
              {" "}
              {pages.length}
            </span>
            <button type="button" disabled={pageIndex >= pages.length - 1} aria-label="Next page" onClick={() => { goToPage(pageIndex + 1); }}>›</button>
          </nav>
        )}
      </div>
      {approval?.requested && <ApprovalBar base={base} approval={approval} onDone={setApproval} />}
    </div>
  );
}
