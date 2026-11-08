/* Folders for Tabbed PDF: lists the PDF files in a folder on this computer, in the Folders pane.
   Chromium-based browsers remember the folder, and Save writes back to the open file.
   Other browsers can list a folder picked with the file dialog; Save then downloads a copy.
   Nothing is uploaded from here. */
(function () {
  'use strict';
  var DB = 'tabbedpdf', STORE = 'handles', KEY = 'folder';
  var dir = null;

  function $(id) { return document.getElementById(id); }
  function setNote(msg) { $('fl-note').textContent = msg; }

  /* The remembered folder (IndexedDB). Every call is guarded: storage can be blocked. */
  function openDb() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error('no indexedDB')); return; }
      var req = indexedDB.open(DB, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore(STORE); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function dbGet(key) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var q = db.transaction(STORE).objectStore(STORE).get(key);
        q.onsuccess = function () { resolve(q.result); };
        q.onerror = function () { reject(q.error); };
      });
    });
  }
  function dbPut(key, val) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(val, key);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function isPdf(bytes) {
    return bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
  }

  function show() {
    if (dir) { listDir(); return; }
    dbGet(KEY).then(function (h) {
      if (h) { dir = h; $('fl-name').textContent = h.name; listDir(); return; }
      $('fl-name').textContent = 'Folder';
      $('fl-list').textContent = '';
      setNote('Choose a folder to see the PDF files in it.');
    }).catch(function () {
      setNote('Choose a folder to see the PDF files in it.');
    });
  }

  async function readDir(handle) {
    var found = [];
    for await (var h of handle.values()) {
      if (h.kind === 'file' && /\.pdf$/i.test(h.name)) found.push(h);
    }
    found.sort(function (a, b) { return a.name.localeCompare(b.name); });
    return found;
  }

  function listDir() {
    $('fl-allow').hidden = true;
    dir.queryPermission({ mode: 'readwrite' }).then(function (p) {
      if (p !== 'granted') {
        $('fl-list').textContent = '';
        $('fl-allow').hidden = false;
        setNote('Allow access to this folder to see its files.');
        return;
      }
      return readDir(dir).then(function (handles) {
        renderItems(handles.map(function (h) {
          return { name: h.name, handle: h, getFile: function () { return h.getFile(); } };
        }));
        setNote(handles.length ? 'Choose a PDF to open it. Save writes back to that file.' : 'No PDF files in this folder.');
      });
    }).catch(function () {
      setNote('This folder could not be read.');
    });
  }

  function renderItems(items) {
    var list = $('fl-list');
    list.textContent = '';
    items.forEach(function (it) {
      var li = document.createElement('li'), b = document.createElement('button');
      b.type = 'button';
      b.textContent = it.name;
      b.title = it.name;
      b.addEventListener('click', function () { openItem(it); });
      li.appendChild(b);
      list.appendChild(li);
    });
  }

  /* The file is checked before it is opened, so a non-PDF is never written over */
  function openItem(it) {
    setNote('Opening ' + it.name + '…');
    it.getFile().then(function (f) { return f.arrayBuffer(); }).then(function (buf) {
      var bytes = new Uint8Array(buf);
      if (!isPdf(bytes)) { setNote('This file is not a PDF.'); return; }
      document.dispatchEvent(new CustomEvent('tabbedpdf:open', {
        detail: { name: it.name, bytes: bytes, handle: it.handle || null }
      }));
      setNote(it.handle ? 'Save writes back to ' + it.name + '.' : 'Opened a copy. Save downloads a new file.');
    }).catch(function () {
      setNote('The file could not be opened.');
    });
  }

  function chooseFolder() {
    if (!window.showDirectoryPicker) { chooseWithDialog(); return; }
    window.showDirectoryPicker({ mode: 'readwrite' }).then(function (h) {
      dir = h;
      $('fl-name').textContent = h.name;
      dbPut(KEY, h).catch(function () {});
      listDir();
    }).catch(function (e) {
      if (e && e.name !== 'AbortError') setNote('The folder could not be opened.');
    });
  }

  /* Fallback for browsers that cannot write to a folder: a read-only list from the file dialog */
  function chooseWithDialog() {
    var inp = document.createElement('input');
    inp.type = 'file';
    inp.multiple = true;
    inp.webkitdirectory = true;
    inp.accept = '.pdf,application/pdf';
    inp.addEventListener('change', function () {
      var files = Array.prototype.slice.call(inp.files).filter(function (f) { return /\.pdf$/i.test(f.name); });
      dir = null;
      var root = inp.files.length && inp.files[0].webkitRelativePath ? inp.files[0].webkitRelativePath.split('/')[0] : 'Folder';
      $('fl-name').textContent = root;
      renderItems(files.map(function (f) {
        return { name: f.name, handle: null, getFile: function () { return Promise.resolve(f); } };
      }));
      setNote(files.length
        ? 'This browser can list this folder but not save into it. Save downloads a copy.'
        : 'No PDF files in this folder.');
    });
    inp.click();
  }

  function allow() {
    if (!dir) return;
    dir.requestPermission({ mode: 'readwrite' }).then(function (p) { if (p === 'granted') listDir(); });
  }

  $('fl-choose').addEventListener('click', chooseFolder);
  $('fl-allow').addEventListener('click', allow);

  window.TabbedFolders = { show: show };
})();
