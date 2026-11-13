/*
 * Where the canvas fetches what a design draws. The editor uses the signed-in
 * routes; the share viewer (screens/SharedView) points everything inside its
 * link, /s/<token>/..., so a visitor never touches the rest of MyCanvas.
 */

let assetBase = "/assets/";
let eventsUrl = "/api/events";
let customFontsUrls = { list: "/api/fonts/custom", css: "/api/fonts/custom.css" };

/** The URL of an uploaded image. */
export function assetUrl(asset: string): string {
  return `${assetBase}${asset}`;
}

export function liveEventsUrl(): string {
  return eventsUrl;
}

export function customFontsEndpoints(): { list: string; css: string } {
  return customFontsUrls;
}

/** Serves everything from a share link instead (call before anything loads). */
export function switchToShareEndpoints(token: string): void {
  const base = `/s/${token}`;
  assetBase = `${base}/assets/`;
  eventsUrl = `${base}/events`;
  customFontsUrls = { list: `${base}/fonts.json`, css: `${base}/fonts.css` };
}

/** The share token when this page is a share link (/s/<token>), else null. */
export function shareTokenFromPath(pathname = window.location.pathname): string | null {
  return /^\/s\/([a-f0-9]{32})\/?$/.exec(pathname)?.[1] ?? null;
}
