# Tabbed PDF

Live version: https://tabbedpdf.pages.dev/

Also see our landing page and other apps: https://tabbedapps.pages.dev

A browser-based PDF editor: open, create, save, annotate, sign, add symbols,
rearrange pages, rotate them, and export. Same layout as Tabbed Word, in red.
Everything runs on the device. Files stay on this device unless you save them to Google Drive (see below).

## Features

- **Open / create / save**: open PDFs (button, drag-and-drop, or Ctrl+O); create a blank document (Ctrl+N);
  Save writes back to the same file where the browser supports it, otherwise downloads; Save as (Ctrl+Shift+S).
- **Tabs**: several PDFs open at once, with unsaved-change markers.
- **Pages**: add blank page, insert pages from another PDF, delete, move (buttons or drag-and-drop),
  rotate left/right, set portrait or landscape, select several, export selected pages as a new PDF.
- **Merge and split**: merge all open documents, in tab order, into one new document (the originals stay open);
  split a document into one PDF per page.
- **Annotate**: select/move/resize, highlight, freehand pen, text box, rectangle, ellipse, arrow.
  Six colours, four line widths, text sizes. Double-click a text box to edit it.
- **Insert**: add JPG, PNG or HEIC images as new pages (each fitted to an A4 page, in its own orientation); HEIC opens only in Safari and other Apple browsers.
- **Advanced → Make searchable (OCR)**: recognises English, Greek and Turkish text on every page and adds it as invisible, searchable text. It runs in your browser; nothing is uploaded. Recognition is approximate, so check the result. Other languages are not recognised.
- **Advanced → Sign with certificate**: signs with your own certificate file (.p12 or .pfx, with its password) and saves a signed copy as a new file. The signature uses SHA-256 in the standard PDF form (PKCS#7, detached). It is invisible on the page. The open document is not changed. The file is read in your browser and never uploaded.
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
styles.css        red theme (Tailwind red scale as CSS variables)
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
- Signing: the signed copy has no visible signature. A certificate you made yourself is shown as untrusted by PDF readers; use a certificate from a trusted provider for signatures that must be trusted. Signing removes any existing signatures in the file. Verify a signed copy in Adobe Reader or another PDF reader.
- OCR covers English, Greek and Turkish only. The searchable text is invisible: the page looks the same, and the recognised words may differ slightly from the scan.

## Licence

MIT. See `LICENSE`. Third-party components and their licences are listed in `third-party-licenses.txt`.

## Author

The Last Byzantine.

This project is not affiliated with or endorsed by Adobe or Microsoft. "PDF" is a trademark of Adobe.

## Version 2026.11.24: Tabbed Word look, Google Drive, Folders, Comments, Email all

- **Look**: the Tabbed Word layout in red: a menu bar (File, Edit, View, Insert, Pages, Tools, Help), a flat
  toolbar with Word-style icons, the Office 2003 flat status bar and dialogs.
- **Google Drive** (File › Open from / Save to Google Drive, or the toolbar buttons): the PDF is saved to
  "your Drive" and kept in step after a short pause, with the same rules as Tabbed Word and Tabbed Slides:
  the newer copy wins, and a Drive copy changed elsewhere is never overwritten silently.
  Sign-in is Google's own; the browser talks to Google directly. Nothing passes through a Tabbed PDF server.
- **Folders** (left pane, Folders tab): lists the PDF files in a folder on this computer. In Chromium
  browsers, Save writes back to the open file; other browsers download a copy.
- **Comments** (left pane, Comments tab): lists the comments added in the document, with Go to page, Edit and
  Delete, and the text comments that are already in the file (read only).
- **Email all open PDFs**: each open document is saved to Drive as a PDF, then Gmail opens for you to attach them.

### Google setup (once)

1. In the Google Cloud project that holds the OAuth client, enable the **Google Drive API**.
2. Under Authorised JavaScript origins, add the address Tabbed PDF is served from (for example
   `https://tabbedpdf.pages.dev`) and `http://localhost:8000` for local tests.
3. While the consent screen is in Testing mode, add your Google account as a test user.

