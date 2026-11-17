/*
 * Rules of the share page's approval panel (screens/SharedView) that don't
 * need the DOM.
 */

/** A notice from the viewer's last action ("PDF downloaded…", "Approved. You can download…"). */
export interface ActionNotice {
  text: string;
  /** The design revision it was shown for. */
  revision: number;
}

/**
 * Such a notice only holds while the design is still the revision it was
 * shown for and that revision can still be downloaded. A new revision (or a
 * later change request) blocks the download, so the notice must go.
 */
export function noticeStillValid(notice: ActionNotice | null, current: { revision: number; downloadable: boolean }): notice is ActionNotice {
  return notice !== null && notice.revision === current.revision && current.downloadable;
}
