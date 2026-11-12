# MyCanvas agent API — v1 spec

Status: **decisions settled (2026-11-12). Steps 1 (core) and 2 (editor live
mode) built on branch `agent-api`; steps 3–7 to do.** See
"Decisions" at the end.

## Goal

Claude, running on Luis's Mac, creates and edits designs in the MyCanvas instance
on nmd-srvr. Luis keeps editing the same designs by hand in the browser and sees
Claude's changes appear live. This is a v1: one owner workspace, simple locks
instead of real-time co-editing, internal access only (no public OAuth).

Out of scope for v1: share links and client comments, more than one agent at a
time, agents in other people's workspaces, real-time co-editing (CRDT/OT).

## How it fits the current code (what drives the design)

- **Designs are JSON files** in `/data/users/<owner>/designs/<id>.json`. The
  editor loads one with `GET /api/designs/:id` and autosaves the **whole design**
  with a debounced `PUT` (`editorStore.saveNow`). There is no version check today:
  the last save wins. An open editor would overwrite Claude's changes with its
  stale copy on its next autosave. **Revisions + locks fix this (below).**
- **All rendering happens in the browser**: Konva draws the canvas, PNG/JPG and
  PDF export run in the page (`canvas-bridge.ts`, `pdf-export.ts`), and
  "document from Markdown" measures text with Konva (`document-format.ts`).
  The server cannot render anything today. So render, export and Markdown
  documents need a **headless browser running the real editor code** (below).
  Reusing the editor code means Claude's render is exactly what Luis sees.
- **Fonts** come from two places: the curated Google Fonts list (stylesheets
  from Google; TTF files for PDF via `/api/fonts/file`) and fonts installed on
  the viewer's computer (Local Font Access API). There is no way to add a font
  to the instance. A headless browser on the server has none of Luis's Mac
  fonts, so custom font upload is needed for faithful renders too.
- **Auth**: `identify()` in `auth.ts`. Requests from the LAN route
  (`https://canva.local`, Traefik IP allowlist 192.168.0.0/24) and requests
  without a route header act as the owner. Public requests
  (`mycanvas.luisserrano.es`) need a Cloudflare Access JWT.

## Transport

**A plain HTTP API inside the existing server, under `/api/agent/v1/`, reached
from the Mac at `https://canva.local` (the existing LAN-only route). No new
tunnel.** A thin MCP wrapper comes second, as an optional convenience.

`canva.local` is **Claude's bridge only**. Luis keeps using MyCanvas from
either address (`canva.local` at home, `mycanvas.luisserrano.es` anywhere);
both open the same owner workspace, get the same live updates and see the
same locks. Agent calls are accepted only on the LAN route.

Why:

- **Fastest to build and to test.** Same Hono app, same storage code, same
  vitest setup as `workspaces.test.ts`. Every endpoint can be tried with `curl`.
- **Already private.** `canva.local` only answers the LAN (Traefik allowlist)
  and is not in public DNS. This Mac is on the LAN (192.168.0.248) and Node
  already reaches `https://canva.local` (checked: `/healthz` answers). Luis
  reaches Claude through Remote Control, so the Mac stays home and on the LAN.
- **Belt and braces:** agent routes need a bearer token **and** are refused
  when the request came through the public route (`X-MyCanvas-Route: public`),
  so a leaked token is useless from the internet.
- **MCP wrapper (phase 3):** a ~200-line stdio MCP server in `tools/mcp/` that
  maps each tool 1:1 onto the HTTP API. Its value: tools show up in any Claude
  session without reading this doc, and `render` returns the PNG as an image
  Claude sees directly. Without it, Claude uses `curl`, saves the PNG and opens
  it with Read, which works fine for the pilot.

Fallback when the Mac is off the LAN (not needed now): `ops/agent-tunnel.sh`
looks up the container's IP over SSH and runs
`ssh -N -L 127.0.0.1:3901:<container-ip>:3001 nmd-srvr`; the client then uses
`http://127.0.0.1:3901`. Tailscale is installed on the Mac and would be the
cleaner long-term option, but it isn't set up on nmd-srvr.

## Auth and identity

- New Coolify env var **`MYCANVAS_AGENT_TOKEN`** (random, ≥ 32 chars). Unset =
  agent API disabled (404).
- Mac side: token in `~/.config/mycanvas/agent.env` (chmod 600) as
  `MYCANVAS_URL=https://canva.local` and `MYCANVAS_AGENT_TOKEN=…`.
- Requests send `Authorization: Bearer <token>` and an optional
  `X-MyCanvas-Agent: Claude` (the name shown to Luis in the editor).
- Agent requests act in the **owner's workspace** (`MYCANVAS_LOCAL_USER`) as
  actor `agent`. Everything else (the editor) is actor `human`.
- Agent routes return 403 on the public route even with a valid token.
- Known and unchanged: anyone on the LAN can already use the normal (non-agent)
  API as the owner. Not made worse by this work.

## Revisions (conflict safety)

- Every design gets an integer `revision`, incremented on every write (editor
  save, agent op, duplicate, move). Missing on old files = 0.
- Editor `PUT /api/designs/:id` sends `baseRevision`. If the stored revision is
  newer, the server answers **409** with the current revision instead of
  overwriting. (Old editor builds without `baseRevision` keep working.)
- Agent writes may send `baseRevision` too (optional optimistic check).

## Lock model

**Locking is automatic; unlocking is intentional.** The first edit locks a
design, and the lock stays until someone releases it on purpose. There are no
timeouts. Because locks can last for days, they are stored on disk
(`locks.json` in the workspace) and survive restarts and deploys.

```ts
interface DesignLock {
  designId: string;
  holder: "agent" | "human";
  label: string;        // "Claude" or the person's email
  email: string;        // the person the lock belongs to (the owner, for Claude)
  since: string;        // ISO time
}
```

Rules:

1. **Viewing never locks.** Luis can keep a design open and watch Claude work.
2. **Claude's lock.** Claude's first write to a free design locks it to Claude
   (so do creating and duplicating). The lock stays until Claude releases it
   with `DELETE …/lock` when it's done, or Luis takes it over. Claude releases
   at the end of each task and says so in its report.
3. **Luis's lock.** Luis's first edit locks the design to him (opening it does
   not). It belongs to him as a person, not to one tab: reopening the design
   later, in any tab or browser, he simply keeps editing. It stays until he
   unlocks it with the **Unlock** button in the editor's top bar (or on the
   design's card in the project list).
4. **Leaving with the design still locked is allowed, but never silent.**
   Going back to the project list or opening another design shows a dialog:
   "This design is still locked to you. Claude can't edit it until you unlock
   it." with **Unlock and leave** / **Keep locked and leave** / **Stay**.
   Closing or reloading the tab triggers the browser's own "Leave site?"
   prompt (browsers don't allow custom text there); the design stays locked.
5. **While Claude holds the lock**, the editor is view-only: a banner says
   "Claude is editing — changes appear live", tools are disabled, and
   **"Take over"** moves the lock to Luis at once (`POST …/lock/takeover`).
   Claude's next write then gets `423 { error: "lock_lost" }`; Claude stops,
   reports, and does not write again until the lock is free. Take over is
   also Luis's way out if Claude ever leaves a design locked.
6. **While Luis holds the lock**, agent writes get
   `423 { error: "locked", holder, since }`. Claude never takes or releases
   Luis's lock on its own. **When Luis asks it to** ("unlock the Bonilista
   design"), Claude releases it with `POST …/lock/release-human`; the editor
   then shows "Unlocked at your request" and switches to view-only if it's
   open. If an open tab still had unsaved edits, they are saved first if the
   design hasn't changed since; otherwise the 409 path below shows them as
   not saved.
7. Server-side checks are the source of truth; the editor's view-only state is
   just UX. An editor `PUT` while Claude holds the lock gets 423 and is not
   saved.
8. The project list shows the lock on each card ("Claude editing" or "Locked
   by you", with Unlock), so forgotten locks are easy to spot.

## Live updates (event stream)

**Server-Sent Events**, one stream per browser tab: `GET /api/events` (normal
auth, so it works on canva.local and on the public route). SSE fits: events
only go server → browser, it is a plain HTTP response, the browser reconnects
by itself, and Hono has `streamSSE`. A heartbeat comment every 25 s keeps
proxies from closing it.

Events (all in the caller's workspace):

| event | data | editor reaction |
|---|---|---|
| `design.updated` | `{ id, revision, by: "agent"\|"human", clientId, pageIds }` | if it's the open design and not from this tab: fetch and apply |
| `design.created` / `design.deleted` | `{ id, folderId? }` | project list refreshes |
| `lock.changed` | `{ id, lock: DesignLock \| null }` | banner, view-only on/off |
| `assets.changed` / `fonts.changed` | `{}` | Uploads drawer / font picker refresh |

Events carry ids, not design JSON (designs hold data-URL thumbnails and can be
large); the editor refetches the design, which is quick. Applying a remote
update keeps the open page and the selection (where those ids still exist) and
**clears undo history** (undoing past Claude's changes would fight the lock).
Each editor tab sends a random `X-MyCanvas-Client` header so it ignores its own
echoes. Agents can listen too: `GET /api/agent/v1/events`.

## The headless renderer

A server-side **headless Chromium** (`playwright-core`) loads the built web app
in a render-only mode, `#/headless`, from `http://127.0.0.1:3001` inside the
container. That page uses the real editor code and exposes:

```ts
window.mycanvasHeadless = {
  renderPage(designId, pageIndex, { format, scale, quality }) → dataURL,
  exportPdf(designId) → base64 PDF,
  layoutDocument(formatId, markdown) → DesignPage[],
  importContent(asset, { pagePerPage }) → { markdown, warnings },   // PDF/DOCX/PPTX/MD
  formatFromExample(asset, { name, describe }) → Design,            // PDF
  layerBoxes(designId, pageIndex) → { id, x, y, width, height }[],
  missingFonts(designId) → string[],
};
```

- It waits for fonts and images before drawing, never autosaves, and runs one
  job at a time (queue).
- **Kept warm for speed.** Chromium and the `#/headless` page stay loaded
  while Claude holds any lock and for 10 min after the last job, and each
  job reuses that page (it loads the design through an in-page call; no new
  page and no app reload per render). Only the first render after a quiet
  spell pays the start-up (about 1–2 s, estimate); later renders only
  wait for drawing, fonts and images. Images and fonts it has loaded once
  stay in the page's cache.
- After agent writes, the server also re-renders the page-1 thumbnail
  (debounced 3 s) so the project list shows Claude's work.
- Docker: the runtime image gains Chromium (`npx playwright install --with-deps
  chromium`, about +400 MB). nmd-srvr has room (371 GB disk free, 15 GiB RAM
  available). In local dev the server uses the Chromium Playwright already
  installed on the Mac.
- **Runs inside the app container** (decided: the faster option). The
  renderer and the server share one container and talk over 127.0.0.1, so
  no extra network hop and no second service to start or keep in sync.
  Chromium's memory is capped by its own flags and the 10 min idle close.

Font caveat: server-side Chromium has no Mac system fonts. A design using e.g.
Avenir renders with a fallback font there. `render` reports such fonts in an
`X-MyCanvas-Missing-Fonts` header so Claude notices; the fix is uploading the
font (below) or choosing a Google font.

## Endpoints

Base: `/api/agent/v1`. JSON in and out unless noted. Errors are
`{ error: string, ... }` with 400 (bad input), 403, 404, 409 (stale revision),
423 (locked).

### Designs

| method | path | what |
|---|---|---|
| GET | `/designs?folderId=&q=` | summaries (no thumbnails) |
| GET | `/designs/:id` | full design; thumbnails stripped unless `?thumbnails=1` |
| POST | `/designs` | create: `{ name, width, height \| aspectRatioId, background?, folderId?, templateId? }` → design, locked to Claude |
| POST | `/designs/:id/duplicate` | variation: `{ name?, folderId? }` → new design, locked to Claude |
| PATCH | `/designs/:id` | `{ name?, width?, height? }` |
| POST | `/designs/:id/move` | `{ folderId \| null }` |
| GET | `/folders`, POST `/folders` | design folders (same as editor) |

Deleting designs is **not** in the agent API in v1 (Luis deletes by hand).

### Layer and page operations (batched)

`POST /designs/:id/ops` with `{ baseRevision?, ops: Op[] }`. The batch is
applied **atomically**: all ops or none, one revision, one `design.updated`
event (so Luis sees one clean change, not twenty flickers). Returns
`{ revision, created: string[] }`: the ids of the layers and pages added, in
op order.

```ts
type PageRef = number | string;          // 0-based index or page id; default 0

type Op =
  | { op: "addLayer"; page?: PageRef; layer: NewLayer; at?: Position }
  | { op: "updateLayer"; page?: PageRef; id: string; set: Partial<Layer> }
  | { op: "deleteLayer"; page?: PageRef; id: string }
  | { op: "moveLayer"; page?: PageRef; id: string; to: Position }
  | { op: "addPage"; after?: PageRef; background?: string; copyOf?: PageRef }
  | { op: "updatePage"; page: PageRef; background?: string; backgroundGradient?: GradientFill | null }
  | { op: "deletePage"; page: PageRef }
  | { op: "movePage"; page: PageRef; to: number };

type Position = "top" | "bottom" | number | { above: string } | { below: string };
```

- `NewLayer` is a **partial** layer: `type` plus what matters (e.g.
  `{ type: "text", text, x, y, fontFamily, fontSize, fill }`). The server fills
  every other field with the editor's defaults. The layer factories move from
  the web app into `packages/shared` so editor and API make identical layers.
- Layer ids: Claude may pass readable ids (`"headline"`); they must be unique
  in the design. Otherwise the server generates one.
- Image layers: `{ type: "image", asset, x, y, width?, height?, fit? }`. The
  server reads the image's size; with only `width` (or `height`) it keeps the
  aspect ratio; `fit: "cover" | "contain"` fits it into the given box (cover
  crops via `crop`). Frames take `content: { asset }` and get a cover fit.
- `updateLayer.set` merges shallowly; nested objects (`effect`, `crop`,
  `gradient`) are replaced whole. The server validates against the layer
  types and rejects unknown fields, wrong types or `type` changes.
- Groups: `groupId` can be set like any field; a helper op is not in v1.
- For bulk work, `PUT /designs/:id` (whole design, `baseRevision` required)
  is also available, with the same locks.

### Render, layout and export

| method | path | what |
|---|---|---|
| GET | `/designs/:id/render?page=0&format=png\|jpg&scale=1&quality=0.9` | page image bytes |
| GET | `/designs/:id/layout?page=0` | each layer's rendered box (text bounds, overflow checks) |
| GET | `/designs/:id/export.pdf` | every page, same PDF export as the editor |
| GET | `/designs/:id/export.zip?format=png&scale=2` | every page as images |

`scale` is 0.25–3 as in the export dialog. Typical render time is about
0.5–2 s once Chromium is warm (estimate, measured during the build).

### Documents from Markdown

| method | path | what |
|---|---|---|
| GET | `/formats` | formats (designs with `kind: "format"`) |
| POST | `/documents` | `{ formatId, markdown, name?, folderId? }` → new design laid out like "New document", with `source` set so Luis can use "Edit content" later |

Markdown is the same dialect as the editor (`#`, `**lead**`, `##`, `>`,
`![name](upload)`, `---`). The AI tidy and illustration steps are not part of
this endpoint (Claude writes the content itself).

### Pages from PDFs (content and style)

PDFs are sources, not pictures to place: their **style** becomes a format and
their **content** becomes pages. Both reuse the editor's existing code
(`format-from-example/` and `import/`) in the headless renderer, so results
match "Format from example…" and "Import a file" in the editor.

| method | path | what |
|---|---|---|
| POST | `/formats/from-example` | `{ asset, name?, folderId?, describe? }` → new format from the PDF's first pages: page size, background art, fonts and weights, text colours, spacing, callout boxes, image sample. `describe: true` also writes the format's AI instructions (needs the text model, which may be offline; then it's skipped and said so). Returns the format and its warnings (e.g. fonts with stand-ins) |
| POST | `/content/import` | `{ asset, pagePerPage? }` → `{ markdown, warnings, stats }` from a PDF, DOCX, PPTX or Markdown upload: headings, leads, lists, quotes, tables; embedded images go to Uploads. Claude reviews or edits the Markdown before laying it out |
| POST | `/documents` | as above, with that Markdown and any format |

So a full flow is: upload the client's PDF → `formats/from-example` (style) →
`content/import` (content) → Claude edits the Markdown → `documents` → render
and check → Luis finishes by hand. Content and style may come from different
PDFs.

Fonts named by the example that MyCanvas doesn't have are flagged as
stand-ins, as in the editor. Uploading the real font (below) and re-running
fixes them. Fonts embedded in the PDF are not extracted: they are usually
subsets missing most characters.

### Uploads (files and attachments)

| method | path | what |
|---|---|---|
| GET | `/assets?folderId=` | uploads (same info as the Uploads manager) |
| POST | `/assets` | multipart: `file`, `folderId?`, `name?` → `{ asset, name, width, height }` |
| GET/POST | `/asset-folders` | upload folders (find or create a folder, e.g. "CEEI") |
| POST | `/assets/move` | `{ assets, folderId }` |

- Images: png, jpg, webp, gif, svg, up to 25 MB, as today.
- **Source files: PDF, DOCX, PPTX, Markdown** (up to 50 MB). Stored in
  Uploads as attachments (a file card in the drawer, not placeable on the
  canvas) for the "Pages from PDFs" endpoints above. They are not split into
  page images. In the editor, "Format from example…" and "Import a file" can
  pick them from Uploads as well as from disk.
- Uploads from the agent appear in Luis's Uploads drawer at once
  (`assets.changed`).

### Fonts (custom font upload)

The hardest part, so here is the whole flow.

**Storage.** Per workspace: `/data/users/<owner>/fonts/<id>.<ttf|otf>` plus
`fonts.json`:

```ts
interface CustomFont {
  id: string;             // file name
  family: string;         // from the font's name table (or overridden)
  weight: number;         // 100–900, from OS/2 usWeightClass
  italic: boolean;        // from OS/2 fsSelection / macStyle
  variable: boolean;      // has a wght axis
  originalName: string;
  uploadedAt: string;
}
```

**Upload.** `POST /api/agent/v1/fonts` (and the same route for the editor,
`POST /api/fonts/custom`): multipart `file`, optional `family` override.
The server parses the file with `fontkit` (same library the PDF export already
uses) to read family, weight and italic, and rejects files it can't parse.
TTF and OTF are accepted. WOFF/WOFF2 are converted to TTF on upload if a small
dependency handles it cleanly, otherwise refused with a clear message (pdf-lib
embeds TTF/OTF). Uploading a second face of a family (e.g. Bold) adds to that
family. `DELETE …/fonts/:id` removes one.

**Serving.** `GET /fonts/:file` serves the file from the caller's own
workspace (like `/assets/*`). `GET /api/fonts/custom.css` returns `@font-face`
rules, one per face, with the right `font-weight` and `font-style`.

**Editor.** On start the app adds that stylesheet, so custom families render
on the canvas like any font. `ensureFontLoaded` treats them like installed
fonts (`document.fonts.load`). The font picker gets a **"Your fonts"** section
above Google Fonts, with an "Add font…" button so Luis can upload too. On
`fonts.changed` the stylesheet and list reload.

**PDF export.** `FontSource.load` in `pdf-export.ts` checks custom fonts first:
it fetches the face with that family and the nearest weight and same italic,
and embeds it (subset) exactly like a Google font. Variable fonts embed their
default instance only (pdf-lib can't pick a weight), which the font picker
notes next to the font.

**Headless renders** load the same stylesheet, so custom fonts render on the
server too. That's the way to use Mac-only fonts in Claude's renders.

Licensing: only upload fonts whose licence allows web and PDF embedding.

### Locks and events (agent side)

| method | path | what |
|---|---|---|
| GET | `/designs/:id/lock` | current lock or `null` |
| POST | `/designs/:id/lock` | take the lock for Claude before a write (423 if Luis holds it) |
| DELETE | `/designs/:id/lock` | release Claude's lock (end of task) |
| POST | `/designs/:id/lock/release-human` | release Luis's lock, **only when Luis asks** |
| GET | `/events` | SSE, same events as the editor gets |

Editor-side (normal auth): `POST /api/designs/:id/lock` (Luis's first
edit), `POST /api/designs/:id/lock/takeover`, `DELETE /api/designs/:id/lock`
(Unlock), `GET /api/locks` (all locks, for the project list),
`GET /api/events`.

## A typical Claude session

```sh
source ~/.config/mycanvas/agent.env
H="Authorization: Bearer $MYCANVAS_AGENT_TOKEN"
curl -sH "$H" -F file=@logo-ceei.png -F folderId=$F "$MYCANVAS_URL/api/agent/v1/assets"
curl -sH "$H" -H 'content-type: application/json' \
  -d '{"name":"Bonilista sponsor v1","width":1200,"height":628,"folderId":"…"}' \
  "$MYCANVAS_URL/api/agent/v1/designs"
curl -sH "$H" -H 'content-type: application/json' -d '{"ops":[
  {"op":"updatePage","page":0,"background":"#0d1b2a"},
  {"op":"addLayer","layer":{"type":"image","id":"logo","asset":"ab12.png","x":60,"y":60,"width":220}},
  {"op":"addLayer","layer":{"type":"text","id":"headline","text":"…","x":60,"y":200,
    "fontFamily":"Montserrat","fontSize":72,"fontStyle":"800","fill":"#ffffff","wrapWidth":900}}
]}' "$MYCANVAS_URL/api/agent/v1/designs/$ID/ops"
curl -sH "$H" "$MYCANVAS_URL/api/agent/v1/designs/$ID/render?scale=1" -o /tmp/v1.png
curl -sXDELETE -H "$H" "$MYCANVAS_URL/api/agent/v1/designs/$ID/lock"
```

Luis has the design open at `https://canva.local/#/edit/$ID` and sees each
batch land. The last call releases Claude's lock; when Luis starts editing,
the lock is his until he unlocks it.

## Build order

Each step ends with `npm run check`, `npm test` and a local check against the
dev server before the next.

1. **Core:** token auth, revisions, locks, `ops`, layer factories in shared,
   uploads (images), SSE event bus. Tests: auth (token, public route refused),
   lock rules (auto-acquire, 423, takeover → lock_lost, release-human,
   locks survive a restart), op validation and atomicity, revision 409.
2. **Editor live mode:** `/api/events` subscription, apply remote updates,
   view-only banner with Take over, Luis's lock on first edit, Unlock
   button, leave dialog and browser leave prompt while locked,
   `baseRevision` on save, lock badges in the project list. Verified in the
   browser preview.
3. **Headless renderer:** `#/headless` page, Playwright runner, render /
   layout / PDF / zip, thumbnails, documents from Markdown, source-file
   uploads, format from example, content import.
4. **Fonts:** upload, parsing, CSS, picker section, PDF embedding, headless.
5. **MCP wrapper** (optional) in `tools/mcp/`.
6. **Demo locally:** Claude builds a small design through the API while the
   editor shows it updating live (screen recording or screenshots).
7. **Deploy (only with Luis's OK):** set `MYCANVAS_AGENT_TOKEN` in Coolify,
   back up `/data`, deploy, smoke test from the Mac.

Steps 1–2 alone already give "Claude edits, Luis watches live and takes over";
3 adds Claude seeing its work. The CEEI Bonilista deadline does not depend on
any of this.

## Decisions (Luis, 2026-11-12)

1. **Transport:** HTTP API over `canva.local` with a token is Claude's bridge;
   Luis uses either address. MCP wrapper later, optional.
2. **Locks:** no timeouts; locks are released on purpose (rules above).
   Claude releases at the end of each task; Take over covers a forgotten one.
3. **Renderer:** headless Chromium inside the app container, kept warm (the
   faster option).
4. **PDF uploads** are sources for content and style (format from example,
   content import), not page images.
5. **No design deletion** through the agent API in v1.
