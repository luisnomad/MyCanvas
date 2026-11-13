import { type DesignPage, type FormatAiInstructions } from "@mycanvas/shared";
import { type Browser, type Page, chromium } from "playwright-core";

/*
 * The headless renderer (docs/AGENT_API.md): one Chromium with the web app
 * open at #/headless, reused for every job (one at a time) and closed after
 * a quiet spell. The page calls the API as the owner, through the server
 * itself (or the Vite dev server in development).
 */

const IDLE_CLOSE_MS = 10 * 60 * 1000;
const JOB_TIMEOUT_MS = 120_000;

export class RendererUnavailable extends Error {}

/** Where the headless page loads the app from. */
function appUrl(): string {
  const configured = process.env.MYCANVAS_RENDER_URL?.trim();
  const base = configured !== undefined && configured !== "" ? configured : `http://127.0.0.1:${process.env.PORT ?? "3001"}`;
  return `${base.replace(/\/+$/, "")}/#/headless`;
}

let browser: Browser | null = null;
let page: Page | null = null;
let starting: Promise<Page> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let queue: Promise<unknown> = Promise.resolve();
/** Returns true while the renderer should stay warm (e.g. Claude holds a lock). */
let keepWarm: () => Promise<boolean> = () => Promise.resolve(false);

export function setKeepWarm(check: () => Promise<boolean>): void {
  keepWarm = check;
}

async function start(): Promise<Page> {
  try {
    browser = await chromium.launch({
      headless: true,
      ...(process.env.MYCANVAS_CHROMIUM ? { executablePath: process.env.MYCANVAS_CHROMIUM } : {}),
      // Keep memory modest on a shared server.
      args: ["--disable-dev-shm-usage", "--js-flags=--max-old-space-size=1024"],
    });
  } catch (error) {
    throw new RendererUnavailable(`Chromium couldn't start: ${error instanceof Error ? error.message.split("\n")[0] ?? "" : String(error)}`);
  }
  browser.on("disconnected", () => {
    browser = null;
    page = null;
  });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
  const opened = await context.newPage();
  opened.on("pageerror", (error) => {
    console.error("renderer page error:", error.message);
  });
  try {
    await opened.goto(appUrl(), { waitUntil: "load", timeout: 30_000 });
    await opened.waitForFunction(() => typeof window.mycanvasHeadless === "object", undefined, { timeout: 30_000 });
  } catch (error) {
    await browser.close().catch(() => undefined);
    browser = null;
    throw new RendererUnavailable(`The app didn't load in the renderer (${appUrl()}): ${error instanceof Error ? error.message.split("\n")[0] ?? "" : String(error)}`);
  }
  page = opened;
  return opened;
}

async function ready(): Promise<Page> {
  if (page && !page.isClosed() && browser?.isConnected()) {
    return page;
  }
  starting ??= start().finally(() => {
    starting = null;
  });
  return starting;
}

function armIdleClose(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
  }
  idleTimer = setTimeout(() => {
    void keepWarm().then((warm) => {
      if (warm) {
        armIdleClose();
        return;
      }
      void closeRenderer();
    });
  }, IDLE_CLOSE_MS);
  idleTimer.unref();
}

export async function closeRenderer(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const open = browser;
  browser = null;
  page = null;
  await open?.close().catch(() => undefined);
}

type Headless = NonNullable<Window["mycanvasHeadless"]>;
type Method = keyof Headless;

/**
 * Calls a window.mycanvasHeadless method in the warm page. Jobs run one at
 * a time; a job that hangs is abandoned (and the page reloaded) after 2 min.
 */
export function runHeadless<M extends Method>(method: M, ...args: Parameters<Headless[M]>): Promise<Awaited<ReturnType<Headless[M]>>> {
  const job = async () => {
    const target = await ready();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`The renderer took longer than ${String(JOB_TIMEOUT_MS / 1000)} s`));
      }, JOB_TIMEOUT_MS);
    });
    try {
      return await Promise.race([
        target.evaluate(
          async ({ name, values }) => {
            const api = window.mycanvasHeadless as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
            const fn = api[name];
            if (!fn) {
              throw new Error(`Unknown renderer call ${name}`);
            }
            return fn(...values);
          },
          { name: method, values: args },
        ),
        timeout,
      ]);
    } catch (error) {
      if (error instanceof Error && error.message.includes("took longer")) {
        await closeRenderer();
      }
      // Playwright wraps page errors; keep the page's own message.
      const message = error instanceof Error ? error.message.replace(/^page\.evaluate: (Error: )?/, "").split("\n")[0] ?? error.message : String(error);
      throw error instanceof RendererUnavailable ? error : new Error(message);
    } finally {
      clearTimeout(timer);
      armIdleClose();
    }
  };
  const run = queue.then(job, job);
  queue = run.catch(() => undefined);
  return run as Promise<Awaited<ReturnType<Headless[M]>>>;
}

// Types of the headless page's API, mirrored from apps/web/src/screens/Headless.tsx
// (the server can't import web code).
declare global {
  interface Window {
    mycanvasHeadless?: {
      renderPage: (designId: string, pageIndex: number, options: { format: "png" | "jpeg"; scale: number; quality: number }) => Promise<{ dataUrl: string; missingFonts: string[] }>;
      layout: (designId: string, pageIndex: number) => Promise<{
        width: number;
        height: number;
        layers: { id: string; name: string; type: string; x: number; y: number; width: number; height: number; outside: boolean }[];
        missingFonts: string[];
      }>;
      thumbnails: (designId: string, pageIndexes: number[]) => Promise<Record<number, string>>;
      exportPdf: (designId: string, scale: number) => Promise<string>;
      layoutDocument: (formatId: string, markdown: string) => Promise<{
        pages: DesignPage[];
        warnings: string[];
        format: { id: string; name: string; width: number; height: number; updatedAt: string };
        title: string | null;
      }>;
      importContent: (sourceUrl: string, fileName: string, pagePerSourcePage: boolean) => Promise<{ markdown: string; summary: string; warnings: string[] }>;
      formatFromExample: (sourceUrl: string, fileName: string, name: string, describe: boolean) => Promise<{
        width: number;
        height: number;
        pages: DesignPage[];
        roles: unknown;
        warnings: string[];
        formatAi?: FormatAiInstructions;
      }>;
    };
  }
}
