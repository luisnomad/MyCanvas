import { useCallback, useEffect, useRef, useState } from "react";
import { type Design } from "@mycanvas/shared";
import { CanvasStage } from "../components/CanvasStage";
import { setHeadlessMode, useEditorStore } from "../store/editorStore";
import { useViewSettings } from "../store/viewSettings";
import { loadCustomFonts } from "../utils/custom-fonts";
import { onLive } from "../utils/live";
import { type ActionNotice, noticeStillValid } from "../utils/share-approval";
import { type ShareLanguage, SHARE_LANGUAGES, errorText, formatWhen, isShareLanguage, shareStrings } from "../utils/share-i18n";

/*
 * A share link (/s/<token>): the design alone, read-only, for someone
 * outside MyCanvas. It draws with the editor's own canvas (so it is the
 * real design, not a render) and follows changes live.
 *
 * When the link asks for approval, the viewer can approve the design or
 * ask for changes, signing with their name (remembered on this device).
 * Approving is a formal sign-off: they tick the sign-off text the server
 * sends, and then download the approved PDF. Every download is logged on
 * the server as proof of delivery.
 *
 * The page speaks the link's language (Spanish unless Luis picks English);
 * the viewer can switch. On phones the design fills the screen and the
 * controls live in a sheet behind one button.
 */

type Status = "loading" | "pin" | "ready" | "gone" | "expired" | "error";

interface Review { name: string; decision: "approved" | "changes"; comment: string; at: string; revision: number }
interface Acknowledgement { version: string; language: ShareLanguage; text: string }
interface Approval {
  requested: boolean;
  revision: number;
  language?: ShareLanguage;
  latest: Review | null;
  acknowledgement?: Acknowledgement;
  acknowledgements?: Partial<Record<ShareLanguage, Acknowledgement>>;
  downloadable?: boolean;
}

type T = ReturnType<typeof shareStrings>;

const NAME_KEY = "mycanvas.reviewerName";
const MOBILE_QUERY = "(max-width: 640px)";

function stored(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private window: it just isn't remembered.
  }
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const onChange = () => { setMatches(list.matches); };
    onChange();
    list.addEventListener("change", onChange);
    return () => { list.removeEventListener("change", onChange); };
  }, [query]);
  return matches;
}

/** The file name the server picked (Content-Disposition, UTF-8 form first). */
function fileNameFrom(res: Response, fallback: string): string {
  const header = res.headers.get("content-disposition") ?? "";
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (utf8?.[1]) {
    try {
      return decodeURIComponent(utf8[1]);
    } catch {
      // Fall through to the plain name.
    }
  }
  return /filename="([^"]+)"/i.exec(header)?.[1] ?? fallback;
}

type Outcome = { ok: true } | { ok: false; error: string };

/** Asks for the approved PDF and saves it. */
async function downloadPdf(base: string, t: T, body: Record<string, unknown>): Promise<Outcome> {
  try {
    const res = await fetch(`${base}/download`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const json = (await res.json().catch(() => ({}))) as { code?: string };
      return { ok: false, error: errorText(t, json.code, res.status) };
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileNameFrom(res, "design.pdf");
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => { URL.revokeObjectURL(url); }, 60_000);
    return { ok: true };
  } catch {
    return { ok: false, error: t.networkError };
  }
}

type Mode = "approve" | "changes" | "download";

/** Approve / request changes / download: the status line, the buttons and the forms. */
function ApprovalPanel({ base, approval, language, onDone, inSheet }: {
  base: string;
  approval: Approval;
  language: ShareLanguage;
  onDone: (approval: Approval) => void;
  inSheet: boolean;
}) {
  const t = shareStrings(language);
  const [mode, setMode] = useState<Mode | null>(null);
  const [name, setName] = useState(() => stored(NAME_KEY));
  const [comment, setComment] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionNotice, setNotice] = useState<ActionNotice | null>(null);
  const [busy, setBusy] = useState<"sending" | "downloading" | null>(null);
  const latest = approval.latest;
  const current = latest?.revision === approval.revision ? latest : null;
  const ack = approval.acknowledgements?.[language] ?? approval.acknowledgement ?? null;
  const downloadable = approval.downloadable === true;
  // A new revision (or a change request) blocks the download: "downloaded,
  // download again any time" must not linger then.
  const notice = noticeStillValid(actionNotice, { revision: approval.revision, downloadable }) ? actionNotice.text : null;
  const downloadOpen = mode === "download";
  useEffect(() => {
    if (downloadOpen && !downloadable) {
      setMode(null);
    }
  }, [downloadOpen, downloadable]);

  const open = (next: Mode) => {
    setMode(next);
    setAgreed(false);
    setError(null);
    setNotice(null);
  };

  const signOff = () => ({ name: name.trim(), revision: approval.revision, acknowledged: agreed, ackVersion: ack?.version, language });

  const download = async () => {
    setBusy("downloading");
    const result = await downloadPdf(base, t, signOff());
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    setNotice({ text: t.downloaded, revision: approval.revision });
    return true;
  };

  const submit = async () => {
    if (!mode) {
      return;
    }
    setError(null);
    setNotice(null);
    rememberName();
    if (mode === "download") {
      if (await download()) {
        setMode(null);
      }
      return;
    }
    setBusy("sending");
    try {
      const res = await fetch(`${base}/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...signOff(), decision: mode === "approve" ? "approved" : "changes", comment: comment.trim() }),
      });
      const body = (await res.json().catch(() => ({}))) as { code?: string; approval?: Approval | null };
      if (!res.ok) {
        setError(errorText(t, body.code, res.status));
        return;
      }
      setComment("");
      if (body.approval) {
        onDone(body.approval);
      }
    } catch {
      setError(t.networkError);
      return;
    } finally {
      setBusy(null);
    }
    if (mode === "approve") {
      // Approving and downloading go together: the file follows at once.
      if (await download()) {
        setMode(null);
      } else {
        // The approval stands; the download can be tried again from here.
        setMode("download");
        setNotice({ text: t.approvedNowDownload, revision: approval.revision });
      }
      return;
    }
    setMode(null);
  };

  function rememberName() {
    store(NAME_KEY, name.trim());
  }

  const wrap = inSheet ? "shared-approval shared-approval-sheet" : "shared-approval";

  if (mode) {
    const needsComment = mode === "changes";
    const needsAck = mode !== "changes";
    const title = mode === "approve" ? t.approveTitle : mode === "changes" ? t.changesTitle : t.downloadTitle;
    const submitLabel = busy === "downloading"
      ? t.downloading
      : busy === "sending" ? t.sending : mode === "approve" ? t.approveAndDownload : mode === "download" ? t.download : t.send;
    return (
      <form
        className={`${wrap} shared-approval-form`}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <strong>{title}</strong>
        {notice && <p className="shared-notice" role="status">{notice}</p>}
        <input
          type="text"
          aria-label={t.yourName}
          placeholder={t.yourName}
          autoComplete="name"
          maxLength={80}
          value={name}
          onChange={(e) => { setName(e.target.value); }}
        />
        {mode !== "download" && (
          <textarea
            aria-label={needsComment ? t.whatShouldChange : t.commentOptional}
            placeholder={needsComment ? t.whatShouldChange : t.commentOptional}
            maxLength={2000}
            rows={needsComment ? 4 : 2}
            value={comment}
            onChange={(e) => { setComment(e.target.value); }}
          />
        )}
        {needsAck && ack && (
          <label className="shared-ack">
            <input type="checkbox" checked={agreed} onChange={(e) => { setAgreed(e.target.checked); }} />
            <span>{ack.text}</span>
          </label>
        )}
        {mode === "download" && <p className="shared-hint">{t.fileHint}</p>}
        {error && <p className="shared-error" role="alert">{error}</p>}
        <div className="shared-approval-actions">
          <button type="button" className="secondary" onClick={() => { setMode(null); setError(null); setNotice(null); }}>{t.cancel}</button>
          <button
            type="submit"
            className="primary"
            disabled={busy !== null || !name.trim() || (needsComment && !comment.trim()) || (needsAck && (!agreed || !ack))}
          >
            {submitLabel}
          </button>
        </div>
      </form>
    );
  }

  return (
    <div className={wrap}>
      <span className="shared-approval-status">
        {current
          ? current.decision === "approved"
            ? t.approvedBy(current.name, formatWhen(current.at, language))
            : t.changesBy(current.name, formatWhen(current.at, language))
          : latest
            ? t.updatedSinceReview
            : t.approvalRequested}
      </span>
      {notice && <span className="shared-notice" role="status">{notice}</span>}
      <div className="shared-approval-actions">
        <button type="button" className="secondary" onClick={() => { open("changes"); }}>{t.requestChanges}</button>
        {downloadable
          ? <button type="button" className="primary" onClick={() => { open("download"); }}>{t.download}</button>
          : <button type="button" className="primary" onClick={() => { open("approve"); }}>{t.approve}</button>}
      </div>
    </div>
  );
}

function LanguageSwitch({ language, onChange, t }: { language: ShareLanguage; onChange: (language: ShareLanguage) => void; t: T }) {
  return (
    <div className="shared-language" role="group" aria-label={t.language}>
      {SHARE_LANGUAGES.map((lang) => (
        <button
          key={lang}
          type="button"
          aria-pressed={lang === language}
          lang={lang}
          title={shareStrings(lang).languageName}
          onClick={() => { onChange(lang); }}
        >
          {lang.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

function PageSwitcher({ index, total, onGo, t }: { index: number; total: number; onGo: (index: number) => void; t: T }) {
  return (
    <nav className="shared-pages" aria-label={t.pages}>
      <button type="button" disabled={index === 0} aria-label={t.previousPage} onClick={() => { onGo(index - 1); }}>‹</button>
      <span aria-label={t.pageOfLong(index + 1, total)}>{t.pageOf(index + 1, total)}</span>
      <button type="button" disabled={index >= total - 1} aria-label={t.nextPage} onClick={() => { onGo(index + 1); }}>›</button>
    </nav>
  );
}

export function SharedView({ token }: { token: string }) {
  const base = `/s/${token}`;
  const languageKey = `mycanvas.shareLanguage.${token}`;
  const design = useEditorStore((state) => state.design);
  const activePageId = useEditorStore((state) => state.activePageId);
  const [status, setStatus] = useState<Status>("loading");
  const [fit, setFit] = useState(1);
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [linkLanguage, setLinkLanguage] = useState<ShareLanguage>("es");
  const [chosenLanguage, setChosenLanguage] = useState<ShareLanguage | null>(() => {
    const saved = stored(languageKey);
    return isShareLanguage(saved) ? saved : null;
  });
  const [sheetOpen, setSheetOpen] = useState(false);
  const mobile = useMediaQuery(MOBILE_QUERY);
  const loadingRef = useRef(false);
  const againRef = useRef(false);
  const swipeRef = useRef<{ x: number; y: number } | null>(null);
  const language = chosenLanguage ?? linkLanguage;
  const t = shareStrings(language);

  const chooseLanguage = (next: ShareLanguage) => {
    setChosenLanguage(next);
    store(languageKey, next);
  };

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  /** Fetches the design (again); one request at a time, the latest wins. */
  const refresh = useCallback(async () => {
    if (loadingRef.current) {
      againRef.current = true;
      return;
    }
    loadingRef.current = true;
    try {
      const res = await fetch(`${base}/design`, { cache: "no-store" });
      if (res.ok) {
        const body = (await res.json()) as { design: Design; approval?: Approval };
        useEditorStore.getState().presentDesign(body.design);
        setApproval(body.approval ?? null);
        if (isShareLanguage(body.approval?.language)) {
          setLinkLanguage(body.approval.language);
        }
        document.title = body.design.name || "MyCanvas";
        setStatus("ready");
      } else {
        const body = (await res.json().catch(() => ({}))) as { language?: unknown };
        if (isShareLanguage(body.language)) {
          setLinkLanguage(body.language);
        }
        setStatus(res.status === 401 ? "pin" : res.status === 404 ? "gone" : res.status === 410 ? "expired" : "error");
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
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }
      if (e.key === "ArrowRight" || e.key === "PageDown") {
        goToPage(pageIndex + 1);
      } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
        goToPage(pageIndex - 1);
      } else if (e.key === "Escape") {
        setSheetOpen(false);
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
      const body = (await res.json().catch(() => ({}))) as { code?: string };
      setPinError(errorText(t, body.code ?? (res.status === 429 ? "pin-locked" : "pin-wrong"), res.status));
    } catch {
      setPinError(t.pinNetwork);
    } finally {
      setChecking(false);
    }
  };

  const languageCorner = (
    <div className="shared-message-language">
      <LanguageSwitch language={language} onChange={chooseLanguage} t={t} />
    </div>
  );

  if (status === "pin") {
    return (
      <div className="shared-view shared-message">
        {languageCorner}
        <form
          className="shared-pin"
          onSubmit={(e) => {
            e.preventDefault();
            void unlock();
          }}
        >
          <h1>{t.pinTitle}</h1>
          <p>{t.pinHelp}</p>
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            autoFocus
            aria-label={t.pinLabel}
            maxLength={8}
            value={pin}
            onChange={(e) => {
              setPin(e.target.value.replace(/\D/g, ""));
            }}
          />
          {pinError && <p className="shared-error" role="alert">{pinError}</p>}
          <button type="submit" className="primary" disabled={checking || pin.length < 4}>
            {checking ? t.pinChecking : t.pinSubmit}
          </button>
        </form>
      </div>
    );
  }

  if (status === "gone" || status === "expired" || status === "error" || status === "loading" || !design) {
    return (
      <div className="shared-view shared-message">
        {status !== "loading" && languageCorner}
        <p>
          {status === "gone"
            ? t.gone
            : status === "expired"
              ? t.expired
              : status === "error"
                ? t.loadError
                : t.loading}
        </p>
      </div>
    );
  }

  const approvalPanel = approval?.requested
    ? (
        <ApprovalPanel
          base={base}
          approval={approval}
          language={language}
          onDone={setApproval}
          inSheet={mobile}
        />
      )
    : null;

  const canvas = (
    <div className="shared-canvas" inert>
      <CanvasStage design={design} scale={fit} onFitScale={setFit} fitMargin={mobile ? 16 : 48} />
    </div>
  );

  if (mobile) {
    // Waiting on the viewer: a dot on the button says there's something to do.
    const pending = approval?.requested === true && !(approval.latest?.revision === approval.revision);
    return (
      <div className="shared-view shared-mobile">
        <div
          className="shared-stage"
          onTouchStart={(e) => {
            const touch = e.touches[0];
            swipeRef.current = touch && e.touches.length === 1 ? { x: touch.clientX, y: touch.clientY } : null;
          }}
          onTouchEnd={(e) => {
            const start = swipeRef.current;
            const touch = e.changedTouches[0];
            swipeRef.current = null;
            if (!start || !touch) {
              return;
            }
            const dx = touch.clientX - start.x;
            const dy = touch.clientY - start.y;
            if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
              goToPage(pageIndex + (dx < 0 ? 1 : -1));
            }
          }}
        >
          {canvas}
        </div>
        <button
          type="button"
          className="shared-fab"
          aria-label={t.menu}
          aria-expanded={sheetOpen}
          aria-controls="shared-sheet"
          onClick={() => { setSheetOpen(true); }}
        >
          {pages.length > 1 && <span className="shared-fab-pages">{t.pageOf(pageIndex + 1, pages.length)}</span>}
          <span aria-hidden="true" className="shared-fab-icon">☰</span>
          {pending && <span className="shared-fab-dot" aria-hidden="true" />}
        </button>
        {sheetOpen && (
          <div className="shared-sheet-backdrop" onClick={() => { setSheetOpen(false); }}>
            <div
              id="shared-sheet"
              className="shared-sheet"
              role="dialog"
              aria-modal="true"
              aria-label={t.menu}
              onClick={(e) => { e.stopPropagation(); }}
            >
              <div className="shared-sheet-head">
                <strong className="shared-sheet-title">{design.name || t.sharedDesign}</strong>
                <button type="button" className="shared-sheet-close" aria-label={t.close} onClick={() => { setSheetOpen(false); }}>×</button>
              </div>
              {pages.length > 1 && <PageSwitcher index={pageIndex} total={pages.length} onGo={goToPage} t={t} />}
              {approvalPanel}
              <div className="shared-sheet-row">
                <span>{t.language}</span>
                <LanguageSwitch language={language} onChange={chooseLanguage} t={t} />
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="shared-view">
      {/* Page switcher and language sit in their own row under the design, so they never cover the page. */}
      <div className="shared-stage">
        {canvas}
        <div className="shared-toolbar">
          <span />
          {pages.length > 1 ? <PageSwitcher index={pageIndex} total={pages.length} onGo={goToPage} t={t} /> : <span />}
          <LanguageSwitch language={language} onChange={chooseLanguage} t={t} />
        </div>
      </div>
      {approvalPanel}
    </div>
  );
}
