/*
 * Words of the public share page (screens/SharedView), in Spanish (the
 * default for share links) and English. The editor itself stays in English.
 * The sign-off text is not here: the server sends it, so what the customer
 * ticks is exactly what gets recorded.
 */

export type ShareLanguage = "es" | "en";
export const SHARE_LANGUAGES: readonly ShareLanguage[] = ["es", "en"];

export function isShareLanguage(value: unknown): value is ShareLanguage {
  return (SHARE_LANGUAGES as readonly unknown[]).includes(value);
}

const es = {
  languageName: "Español",
  language: "Idioma",
  loading: "Cargando…",
  gone: "Este diseño ya no está compartido.",
  expired: "Este enlace ha caducado. Pide uno nuevo a quien te lo envió.",
  loadError: "No se ha podido cargar el diseño. Revisa tu conexión y vuelve a cargar la página.",
  sharedDesign: "Diseño compartido",
  pinTitle: "Este diseño está protegido",
  pinHelp: "Escribe el PIN que te han dado para verlo.",
  pinLabel: "PIN",
  pinSubmit: "Ver el diseño",
  pinChecking: "Comprobando…",
  pinWrong: "El PIN no es correcto",
  pinLocked: "Demasiados PIN incorrectos. Vuelve a intentarlo en unos minutos.",
  pinNetwork: "No se ha podido comprobar el PIN. Inténtalo de nuevo.",
  pages: "Páginas",
  previousPage: "Página anterior",
  nextPage: "Página siguiente",
  pageOf: (page: number, total: number) => `${String(page)} / ${String(total)}`,
  pageOfLong: (page: number, total: number) => `Página ${String(page)} de ${String(total)}`,
  approvalRequested: "Se solicita tu aprobación.",
  updatedSinceReview: "El diseño ha cambiado desde la última revisión. Échale otro vistazo, por favor.",
  approvedBy: (name: string, at: string) => `Aprobado por ${name} · ${at}`,
  changesBy: (name: string, at: string) => `Cambios pedidos por ${name} · ${at}`,
  approve: "Aprobar",
  requestChanges: "Pedir cambios",
  download: "Descargar PDF",
  downloading: "Preparando el PDF…",
  downloaded: "PDF descargado. Puedes volver a descargarlo cuando quieras.",
  approveTitle: "Aprobar este diseño",
  changesTitle: "Pedir cambios",
  downloadTitle: "Descargar el PDF aprobado",
  yourName: "Tu nombre",
  whatShouldChange: "¿Qué hay que cambiar?",
  commentOptional: "Comentario (opcional)",
  cancel: "Cancelar",
  send: "Enviar",
  sending: "Enviando…",
  approveAndDownload: "Aprobar y descargar",
  ackNeeded: "Marca la casilla para continuar.",
  approvedNowDownload: "Aprobado. Ya puedes descargar el PDF.",
  stale: "El diseño ha cambiado mientras lo mirabas. Revisa la nueva versión primero.",
  notApproved: "Aprueba esta versión antes de descargarla.",
  notRequested: "Este enlace no solicita aprobación.",
  tooMany: "Este enlace no admite más respuestas.",
  exportFailed: "Ahora mismo no se ha podido generar el PDF. Inténtalo de nuevo en un momento.",
  genericError: "No ha funcionado. Inténtalo de nuevo.",
  networkError: "No se ha podido enviar. Revisa tu conexión e inténtalo de nuevo.",
  menu: "Opciones",
  close: "Cerrar",
  fileHint: "El PDF es la versión aprobada, igual que la que ves.",
};

type Strings = typeof es;

const en: Strings = {
  languageName: "English",
  language: "Language",
  loading: "Loading…",
  gone: "This design isn't shared any more.",
  expired: "This link has expired. Ask the person who shared it for a new one.",
  loadError: "The design couldn't be loaded. Check your connection and reload the page.",
  sharedDesign: "Shared design",
  pinTitle: "This design is protected",
  pinHelp: "Enter the PIN you were given to see it.",
  pinLabel: "PIN",
  pinSubmit: "View design",
  pinChecking: "Checking…",
  pinWrong: "That PIN isn't right",
  pinLocked: "Too many wrong PINs. Try again in a few minutes.",
  pinNetwork: "Couldn't check the PIN. Try again.",
  pages: "Pages",
  previousPage: "Previous page",
  nextPage: "Next page",
  pageOf: (page, total) => `${String(page)} / ${String(total)}`,
  pageOfLong: (page, total) => `Page ${String(page)} of ${String(total)}`,
  approvalRequested: "Your approval is requested.",
  updatedSinceReview: "Updated since the last review. Please take another look.",
  approvedBy: (name, at) => `Approved by ${name} · ${at}`,
  changesBy: (name, at) => `Changes requested by ${name} · ${at}`,
  approve: "Approve",
  requestChanges: "Request changes",
  download: "Download PDF",
  downloading: "Preparing the PDF…",
  downloaded: "PDF downloaded. You can download it again any time.",
  approveTitle: "Approve this design",
  changesTitle: "Request changes",
  downloadTitle: "Download the approved PDF",
  yourName: "Your name",
  whatShouldChange: "What should change?",
  commentOptional: "Comment (optional)",
  cancel: "Cancel",
  send: "Send",
  sending: "Sending…",
  approveAndDownload: "Approve and download",
  ackNeeded: "Tick the box to continue.",
  approvedNowDownload: "Approved. You can download the PDF now.",
  stale: "The design changed while you were looking. Check the new version first.",
  notApproved: "Approve this version before downloading it.",
  notRequested: "This link doesn't ask for approval.",
  tooMany: "This link can't take more answers.",
  exportFailed: "The PDF couldn't be made right now. Try again in a moment.",
  genericError: "That didn't work. Try again.",
  networkError: "Couldn't send it. Check your connection and try again.",
  menu: "Options",
  close: "Close",
  fileHint: "The PDF is the approved version, the same as you see here.",
};

const TABLE: Record<ShareLanguage, Strings> = { es, en };

export function shareStrings(language: ShareLanguage): Strings {
  return TABLE[language];
}

/** The page text for a server error `code` (share-routes.ts), or a fallback. */
export function errorText(t: Strings, code: unknown, status: number): string {
  switch (code) {
    case "stale": return t.stale;
    case "not-approved": return t.notApproved;
    case "not-requested": return t.notRequested;
    case "acknowledgement": return t.ackNeeded;
    case "full": return t.tooMany;
    case "export": return t.exportFailed;
    case "pin-wrong": return t.pinWrong;
    case "pin-locked": return t.pinLocked;
    default: return status === 409 ? t.stale : t.genericError;
  }
}

export function formatWhen(iso: string, language: ShareLanguage): string {
  return new Date(iso).toLocaleString(language === "es" ? "es-ES" : "en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
