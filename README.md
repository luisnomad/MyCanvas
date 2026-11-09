<p align="center">
  <img src="brand/github-thumb.jpg" alt="MyCanvas" width="960" />
</p>

<h1 align="center">MyCanvas</h1>

<p align="center">
  A local-first design tool for thumbnails and social graphics. Layer text with real<br />
  fonts and effects over images, drop in shapes, frames and logos, and export to PNG/JPG.<br />
  No accounts, no cloud, no subscription — your projects live as JSON on your disk.
</p>

## Requirements

- **Node.js ≥ 22** and npm.
- A modern browser — **Chrome or Edge recommended**. The AI features use WebGPU when
  available and fall back to WASM elsewhere (slower, still works). On first use the
  models download once (~50 MB total) and are cached by the browser afterwards.
- Everything runs on your machine: designs, uploads and fonts never leave it.

## Quick start

```sh
npm install
npm run dev        # starts the API (:3001) and the web UI (:5173) together
```

Open http://localhost:5173, create a design, and start layering.
To run the apps separately: `npm run dev:server` / `npm run dev:web`.

## Features

**Canvas & layers**

- Layer types: text, images, rectangles, lines, shapes (triangle, hexagon, circle,
  semicircle, star) and frames — shape containers that clip an image, with
  double-click pan/zoom content editing.
- Move, resize, rotate, and multi-select with marquee (click-drag on empty canvas);
  group/ungroup (`Cmd/Ctrl+G`), with collapsible group rows in the layers panel.
- Smart guides: snapping to other layers' edges and centers and to the canvas
  center while dragging. Optional grid (`'`) with snap-to-grid and rulers
  (`Shift+R`) that highlight the selection, all in the View menu.
- Align selected items to each other and space 3+ items evenly (Arrange panel;
  groups move as one).
- Copy/paste (`Cmd/Ctrl+C` / `Cmd/Ctrl+V`), duplicate (`Cmd/Ctrl+D`), undo/redo,
  arrow-key nudge, align-to-page (horizontal and vertical independently), z-order
  controls, layer locking (`Cmd/Ctrl+Shift+L`), right-click context menus, and
  hover outlines that preview what you're about to select. Press `?` for the
  full shortcut list.
- Corner handles scale proportionally; side handles resize the container
  (text re-wraps, images crop) with a live preview.

**Typography**

- Every font installed on your system plus a curated Google Fonts library with
  per-font favorites.
- Font weights from Thin 100 to Black 900 (Google Fonts list only the weights
  each family has), italic, alignment, line height, letter spacing, and fill
  color. PDF export embeds the exact weight.
- Curved (bent) text along an arc, in either direction.
- Text effects — shadow, outline, echo, background, and glitch — with per-effect
  sliders for color, distance, angle, blur, spread and roundness.
- Edit in place: double-click any text and type directly on the canvas.

**Color**

- Unified color picker everywhere, with HEX and RGB input.
- "Document colors": swatches of every color already used in the design.
- "Photo colors": 5-color palettes extracted from each image on the canvas,
  ranked so the dominant image's palette comes first.
- Linear and radial gradients (with presets and up to 4 stops) on the
  background, rectangles and shapes; drag the on-canvas knob to aim a linear
  gradient (`Shift` snaps to 15°).

**AI tools (100% local, in-browser)**

- **Remove background** — one-click subject cutout.
- **Text behind subject** — the editorial effect: your heading slips behind the
  person or object in the photo, automatically. The **outlined** variant keeps
  the covered letters visible as outlines over the subject, in the text's own
  font and color; it follows the text live as you move, resize or edit it, and
  any cutout can switch between hidden and outlined.
- **Portrait mode** — depth-based background blur with a strength slider.
- All inference runs in a Web Worker via transformers.js (WebGPU, WASM fallback),
  so the canvas never stutters. Originals are always preserved — every AI result
  is a new, undoable asset.

**Formats from an example**

- "Format from example…" learns a format from a PDF with real text: page
  size, background art (the page with its text removed), fonts with exact
  weights (from the embedded font names; stand-ins are flagged), text
  colours (measured from the rendered glyphs), line and paragraph spacing,
  callout boxes, and the first picture as the image sample. Title, lead,
  heading, body and callout are told apart by size, weight, amount of text
  and boxes. The example page stays as a hidden reference layer.
- Optionally, the text model (with vision when available) writes the
  format's AI instructions: content rules and illustration style.

**AI for documents (bring your own models)**

- AI settings (avatar menu) per account: connections to Google Gemini,
  any OpenAI-compatible server (llama.cpp, vLLM, Ollama, LM Studio,
  OpenRouter, OpenAI) or ComfyUI (FLUX.2 klein preset or your own API
  workflow), and which one does text and which does images, local and
  cloud mixed freely.
- A connection runs on the MyCanvas server (cloud APIs and machines on the
  server's network; keys stored encrypted with `MYCANVAS_SECRET_KEY`, never
  sent back to the browser) or on "this computer" (the browser talks to
  Ollama/LM Studio/ComfyUI at localhost; any key stays in that browser).
- The owner decides which accounts may use the server's local network
  (e.g. a GPU machine at home) and can share connections with them: they
  see the name only, never the address, key or workflow. Other accounts
  don't see those machines at all; a local address they type is refused.
- Formats carry AI instructions: content rules and an illustration style.
- "Tidy with AI" restructures content (callouts, leads, headings, broken
  lines) without changing the words, and reports any word that changed.
- "Add illustrations": the text model chooses where pictures help and what
  they show; the image model draws them in the format's style into Uploads.

**Images & assets**

- Drag image files straight from the filesystem onto the canvas — they upload and
  land where you drop them. Dropping onto a frame fills it; dropping near the
  canvas edge sets the image as the full-canvas background.
- A shared Uploads library for all designs: the editor drawer (search, filter,
  click or drag to place, set as background, rename, delete) and an Uploads
  manager (also on the projects page) with multi-select, "select unused",
  bulk delete, file details and links to every design using an image. Deleting
  an image still in use asks first and lists where it's used.
- Image cropping via side handles; corner radius on shapes and frames.
- Non-destructive image looks: filter presets (Vivid, Warm, Mono, …),
  brightness, contrast, saturation, hue and blur, plus flip horizontal/vertical.
  Works on images and framed photos and stays sharp at any export size.

**Projects & export**

- Multi-page designs: a Pages strip (thumbnails, drag to reorder, duplicate,
  delete, "+" to add), "2 / 5" navigation in the bottom bar, `Cmd/Ctrl+Enter`
  to add a page and `PageUp`/`PageDown` to move between pages; undo covers page
  changes. Designs from before multi-page support open as one page.
- PDF export of every page: plain text becomes real, searchable PDF text with
  the font embedded (Google Fonts, or your own installed fonts), kerned like
  the editor; images, shapes and styled/curved text are embedded as
  high-resolution slices in the right stacking order.

**Document formats**

- Any design can become a format (top bar → Format). Its pages are masters:
  page 1 for a document's first page, page 2 for the pages after it.
- In a format, the inspector's "Role in format" panel marks layers: a **flow
  area** rectangle where content goes, a **sample** text for each block kind
  (title, lead, heading, body, callout) or an image, a **box** drawn behind a
  sample (e.g. a callout strip), and decorations that skip the last page (e.g.
  a "next page" arrow). Everything else repeats on every page.
- Format → Fonts…: one row per block kind (title, lead, heading, body,
  callout) to choose its font and weight in one place; kinds without a
  sample show what they fall back to.
- "New document" writes or pastes content in a small Markdown dialect (`#`
  title, `**…**` lead, `##` heading, `>` callout, `![name](upload)` image,
  `---` new page) and lays it out: blocks stack in the flow area and continue
  on new pages; long paragraphs split across pages, and a heading never ends
  a page.
- Import a file instead of typing: Word (.docx), PowerPoint (.pptx), PDF or
  Markdown. Headings, leads, lists, quotes and tables are recognised from
  styles where they exist and from size and boldness where a document was
  styled by hand; embedded Word/PowerPoint images go to your Uploads. PDFs
  are read column by column, without running headers, footers or page
  numbers; scanned PDFs (no text layer) are reported. Optionally, each slide
  or page starts a new page. The result lands in the editor to check first.
- Documents stay normal designs: edit anything by hand. "Edit content"
  re-flows the text with the format's latest version (one undo step).
  Each document records which version of its format it was laid out with;
  when the format changes later, "Edit content" shows a marker and says so.

- Project list with thumbnails, search, duplicate and delete.
- Project folders (e.g. one per customer): create, rename and delete folders,
  move designs with the Move menu or by dragging a card onto a folder, and
  start new designs straight inside a folder. Deleting a folder keeps its
  designs (they become unfiled); the editor shows a Folder › Design
  breadcrumb.
- New designs from aspect-ratio presets, platform sizes (YouTube, Instagram,
  X, LinkedIn, A4) or any custom size up to 8192 px.
- Templates: four built-in starters, and "Save as template" for your own.
- Export the current page to PNG or JPG at 0.25x–3x resolution with a JPG quality slider and a live
  file-size estimate — handy when a platform rejects an upload for being too heavy.
- Debounced autosave with thumbnails; refresh-safe.
- Light and dark themes, OS-aware and persisted.

## Layout

- `apps/server` — Hono API. Each person has a private workspace in
  `apps/server/data/users/<email>/` (`designs/*.json`, `templates/*.json`,
  `assets/*`, `settings.json`), or under `MYCANVAS_DATA_DIR` when set. Locally
  (and on the LAN route) everything belongs to `MYCANVAS_LOCAL_USER`; behind
  Cloudflare Access the signed-in email picks the workspace. In production it
  also serves the built web app.
- `Dockerfile` + `docker-compose.coolify.yml` — single-container deployment
  (used on Coolify); `ops/traefik/` holds the LAN-only HTTPS route.
- `apps/web` — React + react-konva editor (Vite).
- `packages/shared` — types, aspect-ratio presets, curated Google Fonts list.

## Checks

```sh
npm run check   # eslint (strict, zero-warning) + tsc across workspaces
npm run build   # production build of all workspaces
```

Note: `konva@^10.3.1` is pinned past a `min-release-age=7` npm window; if a fresh
install ever complains, run `npm install --min-release-age=0` once.
