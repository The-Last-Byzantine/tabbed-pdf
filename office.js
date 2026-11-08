/* Tabbed PDF 2026.11.24: the Tabbed Word menu bar and flat toolbar.
   Every item runs the app's own command, so menus, toolbar and the ribbon always agree. */
(function () {
  'use strict';

  var ICON = {
    new: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
    open: '<path d="M3 7h6l2 2h10v9H3z"/>',
    save: '<path d="M5 3h11l3 3v13H5z"/><path d="M8 3v5h7V3M8 21v-7h8v7"/>',
    emailall: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
    opendrive: '<path d="M7 18h10.5a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.6 9.2 4.8 4.8 0 0 0 7 18z"/><path d="M12 10.5v5m0 0-2.2-2.2M12 15.5l2.2-2.2"/>',
    savedrive: '<path d="M7 18h10.5a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.6 9.2 4.8 4.8 0 0 0 7 18z"/><path d="M12 15.5V10.5m0 0-2.2 2.2M12 10.5l2.2 2.2"/>',
    undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
    redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>',
    zoomin: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21M10.5 7.5v6M7.5 10.5h6"/>',
    zoomout: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21M7.5 10.5h6"/>',
    pages: '<rect x="3" y="4" width="18" height="16" rx="1"/><path d="M9 4v16"/>',
    folders: '<path d="M3 6h6l2 2h10v11H3z"/><path d="M3 10h18"/>',
    comments: '<path d="M4 5h16v11H9l-5 4z"/>',
    select: '<path d="M5 3l14 8-6 2-3 6z"/>',
    highlight: '<path d="M4 20h16"/><path d="M7 16l8-10 3 3-8 10H7z"/>',
    ink: '<path d="M4 20c3-6 5-2 8-6s3-6 8-4"/>',
    text: '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>',
    rect: '<rect x="4" y="6" width="16" height="12"/>',
    comment: '<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9h8M8 12h5"/>'
  };
  function icon(name) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + (ICON[name] || '') + '</svg>';
  }

  /* Menu items: act = a command in app.js; id = a button elsewhere (Drive); tool = an annotation tool */
  var MENUS = [
    { name: 'File', items: [
      { label: 'New blank document', act: 'new', kb: 'Ctrl+N', icon: 'new' },
      { label: 'Open PDF…', act: 'open', kb: 'Ctrl+O', icon: 'open' },
      { label: 'Open from Google Drive…', id: 'opendrive', icon: 'opendrive' },
      { sep: true },
      { label: 'Save', act: 'save', kb: 'Ctrl+S', icon: 'save' },
      { label: 'Save as…', act: 'saveas', kb: 'Ctrl+Shift+S' },
      { label: 'Save to Google Drive', id: 'savedrive', icon: 'savedrive' },
      { label: 'Email all open PDFs…', id: 'emailall', icon: 'emailall' },
      { sep: true },
      { label: 'Export selected pages', act: 'export-selected' },
      { label: 'Save selected pages separately', act: 'save-separate' },
      { label: 'Close document', act: 'close-tab' }
    ] },
    { name: 'Edit', items: [
      { label: 'Undo', act: 'undo', kb: 'Ctrl+Z', icon: 'undo' },
      { label: 'Redo', act: 'redo', kb: 'Ctrl+Shift+Z', icon: 'redo' },
      { sep: true },
      { label: 'Select all pages', act: 'select-all', kb: 'Ctrl+A' },
      { label: 'Delete pages', act: 'delete-pages' },
      { label: 'Delete annotation', act: 'delete-item', kb: 'Del' }
    ] },
    { name: 'View', items: [
      { label: 'Zoom in', act: 'zoom-in', icon: 'zoomin' },
      { label: 'Zoom out', act: 'zoom-out', icon: 'zoomout' },
      { label: 'Fit width', act: 'zoom-fit' },
      { label: '100 %', act: 'zoom-100' },
      { sep: true },
      { label: 'Pages panel', act: 'pane-pages', icon: 'pages' },
      { label: 'Folders panel', act: 'pane-folders', icon: 'folders' },
      { label: 'Comments panel', act: 'pane-comments', icon: 'comments' }
    ] },
    { name: 'Insert', items: [
      { label: 'Images as pages…', act: 'insert-image' },
      { label: 'Insert PDF…', act: 'insert-pdf' },
      { sep: true },
      { label: 'Create signature…', act: 'signature' },
      { label: 'Comment on a page', tool: 'comment', icon: 'comment' },
      { label: 'Highlight', tool: 'highlight', icon: 'highlight' },
      { label: 'Pen', tool: 'ink', icon: 'ink' },
      { label: 'Text box', tool: 'text', icon: 'text' },
      { label: 'Rectangle', tool: 'rect', icon: 'rect' }
    ] },
    { name: 'Pages', items: [
      { label: 'Add blank page', act: 'add-page' },
      { label: 'Rotate left', act: 'rotate-left' },
      { label: 'Rotate right', act: 'rotate-right' },
      { label: 'Portrait', act: 'portrait' },
      { label: 'Landscape', act: 'landscape' },
      { sep: true },
      { label: 'Move up', act: 'move-up' },
      { label: 'Move down', act: 'move-down' },
      { sep: true },
      { label: 'Merge open documents', act: 'merge-open' },
      { label: 'Split into pages', act: 'split-pages' },
      { label: 'Page numbers', act: 'page-numbers' },
      { label: 'Header and footer', act: 'header-footer' },
      { label: 'Bookmark page', act: 'bookmark-page' },
      { label: 'Crop pages', act: 'crop-pages' },
      { label: 'Remove crop', act: 'clear-crop' },
      { label: 'Clear bookmarks', act: 'clear-bookmarks' }
    ] },
    { name: 'Tools', items: [
      { label: 'Make searchable (OCR)…', act: 'ocr' },
      { label: 'Sign with certificate…', act: 'sign-cert' },
      { label: 'Compare with a PDF…', act: 'compare' },
      { label: 'Document properties…', act: 'doc-properties' },
      { label: 'Flatten forms on save', act: 'flatten-forms' }
    ] },
    { name: 'Help', items: [
      { label: 'Keyboard shortcuts', act: 'shortcuts' },
      { label: 'About Tabbed PDF', act: 'about' }
    ] }
  ];

  /* Toolbar: icon buttons. pane = a left-pane button; tool = an annotation tool. */
  var TOOLBAR = [
    { icon: 'new', title: 'New blank document (Ctrl+N)', act: 'new' },
    { icon: 'open', title: 'Open PDF (Ctrl+O)', act: 'open' },
    { icon: 'opendrive', title: 'Open from Google Drive', id: 'opendrive' },
    { icon: 'savedrive', title: 'Save to Google Drive', id: 'savedrive' },
    { icon: 'save', title: 'Save (Ctrl+S)', act: 'save' },
    { icon: 'emailall', title: 'Email all open PDFs (saved to Drive, then Gmail opens)', id: 'emailall' },
    'sep',
    { icon: 'undo', title: 'Undo (Ctrl+Z)', act: 'undo' },
    { icon: 'redo', title: 'Redo (Ctrl+Shift+Z)', act: 'redo' },
    'sep',
    { icon: 'zoomout', title: 'Zoom out (−)', act: 'zoom-out' },
    { icon: 'zoomin', title: 'Zoom in (+)', act: 'zoom-in' },
    'sep',
    { icon: 'pages', title: 'Pages panel', act: 'pane-pages', pane: 'pages' },
    { icon: 'folders', title: 'Folders panel', act: 'pane-folders', pane: 'folders' },
    { icon: 'comments', title: 'Comments panel', act: 'pane-comments', pane: 'comments' },
    'sep',
    { icon: 'select', title: 'Select (V)', tool: 'select' },
    { icon: 'highlight', title: 'Highlight (H)', tool: 'highlight' },
    { icon: 'ink', title: 'Pen (P)', tool: 'ink' },
    { icon: 'text', title: 'Text box (T)', tool: 'text' },
    { icon: 'rect', title: 'Rectangle (R)', tool: 'rect' },
    { icon: 'comment', title: 'Comment: click a page to add a note', tool: 'comment' }
  ];

  /* Runs one menu or toolbar item through the app's own controls */
  function run(item) {
    if (item.id) {
      var b = document.getElementById(item.id);
      if (b) b.click();
      return;
    }
    if (item.tool) {
      var t = document.querySelector('#toolbar button[data-tool="' + item.tool + '"]');
      if (t) t.click();
      return;
    }
    document.dispatchEvent(new CustomEvent('tabbedpdf:command', { detail: { act: item.act } }));
  }

  var openMenuWrap = null;
  function closeMenus() {
    document.querySelectorAll('#officemenu .om-pop').forEach(function (p) { p.hidden = true; });
    document.querySelectorAll('#officemenu > .om-item > button').forEach(function (b) { b.setAttribute('aria-expanded', 'false'); });
    openMenuWrap = null;
  }
  function openMenu(wrap) {
    closeMenus();
    wrap.querySelector('.om-pop').hidden = false;
    wrap.querySelector(':scope > button').setAttribute('aria-expanded', 'true');
    openMenuWrap = wrap;
  }

  /* Toolbar buttons show as pressed when the matching tool or left-pane tab is active */
  function syncPressed() {
    var thumbs = document.getElementById('thumbs');
    var visible = thumbs && !thumbs.classList.contains('hidden');
    var pane = document.querySelector('#lptabs button.selected');
    var paneName = pane ? pane.dataset.pane : '';
    document.querySelectorAll('#stdbar .tb').forEach(function (b) {
      var pressed = false;
      if (b.dataset.tool) {
        var real = document.querySelector('#toolbar button[data-tool="' + b.dataset.tool + '"]');
        pressed = !!(real && real.classList.contains('selected'));
      } else if (b.dataset.pane) {
        pressed = !!visible && paneName === b.dataset.pane;
      }
      b.setAttribute('aria-pressed', String(pressed));
    });
  }

  function build() {
    var bar = document.getElementById('officemenu');
    var tb = document.getElementById('stdbar');
    if (!bar || !tb) return;

    MENUS.forEach(function (m) {
      var wrap = document.createElement('div');
      wrap.className = 'om-item';
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = m.name;
      btn.setAttribute('aria-haspopup', 'true');
      btn.setAttribute('aria-expanded', 'false');
      var pop = document.createElement('div');
      pop.className = 'om-pop';
      pop.setAttribute('role', 'menu');
      pop.hidden = true;
      m.items.forEach(function (it) {
        if (it.sep) { pop.appendChild(document.createElement('hr')); return; }
        var b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('role', 'menuitem');
        b.innerHTML = '<span class="om-ic">' + (it.icon ? icon(it.icon) : '') + '</span><span class="om-lbl"></span><span class="om-kb"></span>';
        b.querySelector('.om-lbl').textContent = it.label;
        b.querySelector('.om-kb').textContent = it.kb || '';
        b.addEventListener('click', function () { closeMenus(); run(it); syncPressed(); });
        pop.appendChild(b);
      });
      btn.addEventListener('click', function () {
        if (openMenuWrap === wrap) closeMenus(); else openMenu(wrap);
      });
      btn.addEventListener('mouseenter', function () {
        if (openMenuWrap && openMenuWrap !== wrap) openMenu(wrap);
      });
      wrap.append(btn, pop);
      bar.appendChild(wrap);
    });

    TOOLBAR.forEach(function (t) {
      if (t === 'sep') {
        var s = document.createElement('span');
        s.className = 'om-sep';
        tb.appendChild(s);
        return;
      }
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'tb';
      b.title = t.title;
      b.setAttribute('aria-label', t.title);
      if (t.id) b.id = t.id;
      if (t.tool) b.dataset.tool = t.tool;
      if (t.pane) b.dataset.pane = t.pane;
      b.innerHTML = icon(t.icon);
      b.addEventListener('click', function () { run(t); setTimeout(syncPressed, 0); });
      tb.appendChild(b);
    });

    /* The property controls (colour, line width, text size, symbols, zoom) lived in the old ribbon.
       They are moved here, not copied, so their ids and listeners still work. */
    ['swatches', 'stroke', 'fontsize', 'symbols', 'zoomsel'].forEach(function (id, i) {
      var el = document.getElementById(id);
      if (!el) return;
      if (i === 0) { var sp = document.createElement('span'); sp.className = 'om-sep'; tb.appendChild(sp); }
      tb.appendChild(el);
    });

    document.addEventListener('click', function (e) {
      if (!e.target.closest || !e.target.closest('#officemenu')) closeMenus();
      setTimeout(syncPressed, 0);
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeMenus(); });
    syncPressed();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
  window.TabbedOffice = { syncPressed: syncPressed };
})();
