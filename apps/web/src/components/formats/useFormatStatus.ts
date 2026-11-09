import { useEffect, useState } from "react";
import { type DocumentSource } from "@mycanvas/shared";
import { ApiError, api } from "../../api";

export type FormatStatus =
  | { state: "loading" }
  /** The document was laid out with the format's current version. */
  | { state: "current" }
  /** The format was saved after this document was laid out. */
  | { state: "changed"; formatUpdatedAt: string }
  | { state: "missing" }
  /** Couldn't check (offline, server error). */
  | { state: "unknown" };

/**
 * Whether a generated document's format has changed since the layout was
 * made. The format's updatedAt is its version; documents from before
 * versioning compare against their generation time.
 */
export function useFormatStatus(source: DocumentSource | undefined): FormatStatus {
  const [status, setStatus] = useState<FormatStatus>({ state: "loading" });
  const formatId = source?.formatId;
  const usedVersion = source ? (source.formatUpdatedAt ?? source.generatedAt) : undefined;

  useEffect(() => {
    if (!formatId || !usedVersion) {
      return;
    }
    let cancelled = false;
    setStatus({ state: "loading" });
    api
      .getDesign(formatId)
      .then((format) => {
        if (!cancelled) {
          setStatus(format.updatedAt > usedVersion ? { state: "changed", formatUpdatedAt: format.updatedAt } : { state: "current" });
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setStatus({ state: reason instanceof ApiError && reason.status === 404 ? "missing" : "unknown" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [formatId, usedVersion]);

  return status;
}
