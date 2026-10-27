# Tabbed PDF

Live version: https://tabbedpdf.pages.dev/

A browser-based PDF editor: open, create, save, annotate, sign, add symbols,
rearrange pages, rotate them, and export. Same layout as Tabbed Word, in orange.
Everything runs on the device. Files are never uploaded.

## Features

- **Open / create / save**: open PDFs (button, drag-and-drop, or Ctrl+O); create a blank document (Ctrl+N);
  Save writes back to the same file where the browser supports it, otherwise downloads; Save as (Ctrl+Shift+S).
- **Tabs**: several PDFs open at once, with unsaved-change markers.
- **Pages**: add blank page, insert pages from another PDF, delete, move (buttons or drag-and-drop),
  rotate left/right, set portrait or landscape, select several, export selected pages as a new PDF.
- **Annotate**: select/move/resize, highlight, freehand pen, text box, rectangle, ellipse, arrow.
  Six colours, four line widths, text sizes. Double-click a text box to edit it.
- **Sign**: draw, type (three styles) or upload a signature image; place it on a page. Remembered on the device if you tick the box.
- **Symbols**: ✓ ✗ ● ○ ★ →, placed as vector graphics.
- **Undo / redo**: Ctrl+Z / Ctrl+Shift+Z for every edit, page operation and annotation.
- Annotations are written into the PDF as vector drawings and text, so they stay sharp at any zoom.
  Greek and Turkish characters work in typed text (embedded DejaVu Sans).

## Keyboard

| Key | Action |
| --- | --- |
| Ctrl/Cmd + O / N / S | Open / New / Save |
| Ctrl/Cmd + Shift + S | Save as |
| Ctrl/Cmd + Z, Ctrl/Cmd + Shift + Z | Undo / redo |
| Ctrl/Cmd + A | Select all pages |
| V H P T R E A | Select, Highlight, Pen, Text, Rectangle, Ellipse, Arrow |
| + / − | Zoom in / out |
| Delete | Delete selected annotation |
| Esc | Back to Select tool, clear selection |

## Project layout

```
index.html        app shell (CSP: no inline scripts, no network except the app's own files)
styles.css        orange theme (Tailwind orange scale as CSS variables)
app.js            all application logic (ES module)
sw.js             service worker for offline use
manifest.webmanifest, icons/, _headers   PWA and Cloudflare Pages headers
vendor/           pdf.js 4.10.38 (rendering), pdf-lib 1.17.1 (editing and export),
                  @pdf-lib/fontkit 1.1.1, DejaVu Sans (see third-party-licenses.txt)
```

No build step. Serve the folder as static files.

## Run locally

```
python3 -m http.server 8000
# open http://localhost:8000
```

## Deploy to Cloudflare Pages

```
npx wrangler pages deploy . --project-name tabbedpdf
```

Or create a Pages project from a Git repo with no build command and output directory `/`.

## Notes and limits

- Password-protected PDFs can't be opened yet.
- Text annotations use one font (DejaVu Sans). They don't wrap automatically; use Enter for new lines.
- Freehand strokes and shapes are exported as vector lines; highlights are translucent rectangles.
- Page rotation keeps annotations in place on the page. Upright items (text, signatures, symbols) stay upright.
- Save writes back in place only in Chrome and Edge (File System Access API). Other browsers download the file.
- Session restore and form-field filling are not in this version.

## Licence

MIT. See `LICENSE`. Third-party components and their licences are listed in `third-party-licenses.txt`.

## Author

The Last Byzantine.

This project is not affiliated with or endorsed by Adobe or Microsoft. "PDF" is a trademark of Adobe.
