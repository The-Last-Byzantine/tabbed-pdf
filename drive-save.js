/* Google Drive for Tabbed PDF: save, open, and automatic sync (no sharing).
   The same sign-in and file handling as Tabbed Word 2026.11.76.
   Google's sign-in script loads only when a Drive button is pressed or a sync needs it.
   Changes always save on this device first. A linked deck is uploaded to Drive after the
   person pauses; while offline, changed decks wait and upload on reconnect.
   The browser talks to Google directly; nothing passes through a Tabbed PDF server.
   Tokens stay in memory only. Drive links and the "last synced" signature are stored on each
   deck, so they survive a reload. The app gives this file an adapter (see attach). */
(function () {
  'use strict';
  var CLIENT_ID = '1030444770738-0r8vo12bf77lof26jifk31bq1qu7gll1.apps.googleusercontent.com';
  var SCOPE = 'https://www.googleapis.com/auth/drive.file';
  /* Google Picker: lets the person choose a file, which is all drive.file allows us to open.
     API_KEY is a browser key (Cloud Console > Credentials > API key), restricted to the Google Picker API
     and to this app's web address. PROJECT_NUMBER is the project that holds the OAuth client. */
  var API_KEY = 'AIzaSyAv8K9QXz7WzNuZFfYLY_Hf-RyqJHy_d_I';
  var PROJECT_NUMBER = '1030444770738';
  var API_JS = 'https://apis.google.com/js/api.js';
  var GIS_URL = 'https://accounts.google.com/gsi/client';
  var FILES = 'https://www.googleapis.com/drive/v3/files';
  var UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
  var PDF = 'application/pdf';
  var JSON_MIME = 'application/json';
  var OPEN_MIMES = [PDF];
  var OPEN_EXT = /\.pdf$/i;
  var IDLE_MS = 3000;       /* no typing for this long before a sync starts */
  var DEBOUNCE_MS = 4000;   /* wait this long after the last change */
  var RETRY_MS = 30000;
  /* Deck fields that are not content: changing them is not an edit */
  var NOT_CONTENT = { drive: 1, driveSig: 1, driveConflict: 1, driveError: 1, current: 1, link: 1, linkSafe: 1, fileName: 1, format: 1 };

  var A = null;             /* the app's adapter, set by attach() */
  var token = null, tokenExpires = 0, tokenClient = null, pending = null, loading = null;
  var busy = false, working = false, signinNeeded = false, timer = null, lastKey = 0;
  var stateEl = null, dlg = null;

  function report(msg, isError) { if (A) A.status(msg, isError); }

  function httpError(r) {
    var e = new Error('Google Drive answered with status ' + r.status + '.');
    e.status = r.status;
    return e;
  }

  function gisReady() {
    return !!(window.google && google.accounts && google.accounts.oauth2);
  }

  function loadGis() {
    if (gisReady()) return Promise.resolve();
    if (loading) return loading;
    loading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = GIS_URL;
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () {
        loading = null;
        reject(new Error('Google sign-in could not be loaded. Check your internet connection.'));
      };
      document.head.appendChild(s);
    });
    return loading;
  }

  function ensureTokenClient() {
    if (tokenClient) return;
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      callback: function (resp) {
        var p = pending;
        pending = null;
        if (!p) return;
        if (resp.error) { p.reject(new Error('Google sign-in was not completed (' + resp.error + ').')); return; }
        token = resp.access_token;
        tokenExpires = Date.now() + (Number(resp.expires_in) || 3600) * 1000;
        signinNeeded = false;
        p.resolve(token);
      },
      error_callback: function (err) {
        var p = pending;
        pending = null;
        if (p) p.reject(new Error('The Google sign-in window was closed.' + (err && err.type ? ' (' + err.type + ')' : '')));
      }
    });
  }

  /* A click must call requestAccessToken synchronously, or browsers block the sign-in window.
     silent = true asks Google without a window; it fails when the person must choose. */
  function askToken(silent) {
    ensureTokenClient();
    return new Promise(function (resolve, reject) {
      pending = { resolve: resolve, reject: reject };
      tokenClient.requestAccessToken({ prompt: silent ? 'none' : '' });
    });
  }

  function getToken(silent) {
    if (token && Date.now() < tokenExpires - 60000) return Promise.resolve(token);
    if (!gisReady()) return loadGis().then(function () { return askToken(silent); });
    return askToken(silent);
  }

  function upload(blob, fileName, mime, existingId, accessToken) {
    var boundary = 'tsdrive' + Date.now().toString(36) + Math.random().toString(36).slice(2);
    var meta = existingId ? { name: fileName } : { name: fileName, mimeType: mime };
    var body = new Blob([
      '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n',
      JSON.stringify(meta),
      '\r\n--' + boundary + '\r\nContent-Type: ' + mime + '\r\n\r\n',
      blob,
      '\r\n--' + boundary + '--'
    ], { type: 'multipart/related; boundary=' + boundary });
    var url = UPLOAD + (existingId ? '/' + encodeURIComponent(existingId) : '') +
      '?uploadType=multipart&fields=id,name,modifiedTime';
    return fetch(url, {
      method: existingId ? 'PATCH' : 'POST',
      headers: { Authorization: 'Bearer ' + accessToken },
      body: body
    }).then(function (r) { if (r.ok) return r.json(); throw httpError(r); });
  }

  function mimeOf(fmt) { return PDF; }

  /* The document's content as text: a deck counts as changed when this differs from the copy last sent to Drive */
  function sig(d) {
    if (A && A.sig) return A.sig(d);
    var c = {};
    Object.keys(d).forEach(function (k) { if (!NOT_CONTENT[k]) c[k] = d[k]; });
    return JSON.stringify(c);
  }

  function isDirty(d) {
    return !!d.drive && !d.driveConflict && sig(d) !== d.driveSig;
  }

  function timeLabel(ms) {
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function linkedDirty() {
    return A.decks().filter(isDirty);
  }

  function hasLinked() {
    return A.decks().some(function (d) { return !!d.drive; });
  }

  /* ---- bottom bar note ---- */

  function refresh() {
    if (!stateEl || !A) return;
    var d = A.active();
    if (!d || !d.drive) { stateEl.textContent = ''; return; }
    var txt;
    if (d.driveConflict) txt = 'Drive has a newer version of this file · press Save to Google Drive to keep this copy';
    else if (isDirty(d) && !navigator.onLine) txt = 'Offline · saved on this device, syncs when you are back online';
    else if (isDirty(d) && signinNeeded) txt = 'Press Drive to reconnect · changes are saved on this device';
    else if (isDirty(d) && d.driveError) txt = 'Not synced to Google Drive yet · will retry';
    else if (isDirty(d)) txt = busy ? 'Syncing to Google Drive…' : 'Changes waiting to sync to Google Drive';
    else txt = 'Synced to Google Drive' + (d.drive.at ? ' · ' + timeLabel(d.drive.at) : '');
    stateEl.textContent = txt;
  }

  function addStateElement() {
    stateEl = document.getElementById('drivestate');
  }

  /* ---- automatic sync ---- */

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(function () { timer = null; runJob(); }, ms === undefined ? DEBOUNCE_MS : ms);
  }

  /* Upload one deck's file, unless Drive has a newer version. sent = the signature that was exported */
  function pushDeck(d, blob, fileName, mime, t, sent) {
    return fetch(FILES + '/' + encodeURIComponent(d.drive.id) + '?fields=modifiedTime', {
      headers: { Authorization: 'Bearer ' + t }
    }).then(function (r) {
      if (r.status === 404) { d.drive = null; d.driveSig = null; return; }
      if (!r.ok) throw httpError(r);
      return r.json().then(function (meta) {
        if (d.drive.rev && meta.modifiedTime !== d.drive.rev) { d.driveConflict = true; return; }
        return upload(blob, fileName, mime, d.drive.id, t).then(function (f) {
          d.drive.rev = f.modifiedTime;
          d.drive.at = Date.now();
          d.driveSig = sent;       /* if the deck was edited while uploading, it stays dirty and syncs again */
          d.driveConflict = false;
          d.driveError = '';
        });
      });
    });
  }

  function syncList(list, t) {
    var stopped = false;
    return list.reduce(function (p, d) {
      return p.then(function () {
        if (stopped) return;
        if (Date.now() - lastKey < IDLE_MS) { stopped = true; return; }
        if (!isDirty(d)) return;
        var sent = sig(d), fmt = A.formatOf(d);
        return A.blob(d, fmt).then(function (blob) {
          return pushDeck(d, blob, A.fileName(d, fmt), mimeOf(fmt), t, sent);
        }).catch(function (e) {
          d.driveError = e.message;
          if (e.status === 401) { token = null; signinNeeded = true; }
        });
      });
    }, Promise.resolve()).then(function () {
      A.save();
      return stopped;
    });
  }

  function runJob() {
    var list = linkedDirty();
    if (!list.length) { refresh(); return; }
    if (busy) { schedule(IDLE_MS); return; }
    if (!navigator.onLine) { refresh(); return; }
    var idle = Date.now() - lastKey;
    if (idle < IDLE_MS) { schedule(IDLE_MS - idle + 200); return; }
    busy = true;
    working = true;
    refresh();
    getToken(true).then(function (t) {
      signinNeeded = false;
      return syncList(list, t);
    }, function () {
      signinNeeded = true;
      return null;
    }).then(function (stopped) {
      busy = false;
      working = false;
      refresh();
      if (signinNeeded) return;           /* wait for a Drive press */
      if (linkedDirty().length) schedule(stopped ? IDLE_MS + 200 : RETRY_MS);
    }, function () {
      busy = false;
      working = false;
      refresh();
      schedule(RETRY_MS);
    });
  }

  /* ---- Save to Drive (button) ---- */

  /* tokenP is requested inside the click, so the sign-in window is not blocked */
  function saveDeck(d, blob, fileName, mime, sent, tokenP) {
    return tokenP.then(function (t) {
      var existing = d.drive ? d.drive.id : null;
      return upload(blob, fileName, mime, existing, t).catch(function (e) {
        if (e.status === 401) { token = null; throw new Error('The sign-in has expired. Press Save to Google Drive again.'); }
        if (existing && e.status === 404) { d.drive = null; return upload(blob, fileName, mime, null, t); }
        throw e;
      });
    }).then(function (f) {
      d.drive = { id: f.id, rev: f.modifiedTime, at: Date.now() };
      d.driveSig = sent;
      d.driveConflict = false;
      d.driveError = '';
      A.save();
      return { ok: true, name: f.name };
    });
  }

  /* ---- Email all: every open deck is saved to Drive as .pdf, then Gmail opens to attach them ---- */
  function emailAll() {
    if (!A) return;
    var decks = A.decks();
    if (!decks.length) { report('No open PDFs to email.', true); return; }
    requireGis(function () {
      var tokenP = getToken(false);           /* starts the sign-in window while this click is still active */
      tokenP.catch(function () {});
      var win = window.open('https://mail.google.com/mail/?view=cm&fs=1', '_blank');
      if (!win) report('Allow pop-ups for this site to open Gmail. The files are still saved to Drive.');
      var used = {};
      tokenP.then(function (t) {
        report('Saving ' + decks.length + (decks.length === 1 ? ' PDF' : ' PDFs') + ' to Google Drive…');
        return decks.reduce(function (p, d) {
          return p.then(function () {
            return A.blob(d, 'pdf').then(function (blob) {
              var base = A.fileName(d, 'pdf').replace(/\.pdf$/i, ''), name = base + '.pdf', k = 1;
              while (used[name.toLowerCase()]) name = base + ' (' + (++k) + ').pdf';
              used[name.toLowerCase()] = true;
              return upload(blob, name, PDF, null, t);
            });
          });
        }, Promise.resolve());
      }).then(function () {
        report('Saved to Google Drive. In Gmail, attach them with Insert files using Drive.');
      }, function (e) { report('Could not save all PDFs to Google Drive: ' + e.message, true); });
    });
  }

  /* ---- Open from Drive ---- */

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('Could not load ' + src + '. Check your internet connection.')); };
      document.head.appendChild(s);
    });
  }

  var pickerLoading = null;
  function loadPicker() {
    if (window.google && google.picker) return Promise.resolve();
    if (pickerLoading) return pickerLoading;
    pickerLoading = loadScript(API_JS).then(function () {
      return new Promise(function (resolve, reject) {
        gapi.load('picker', { callback: resolve, onerror: function () { reject(new Error('Google Picker could not be loaded.')); } });
      });
    }).catch(function (e) { pickerLoading = null; throw e; });
    return pickerLoading;
  }

  /* Keeps Google's picker inside the window: fixed in the centre, never larger than the screen.
     Without this, Safari can place its top above the visible area, where it cannot be scrolled to. */
  function fitPickerStyle() {
    if (document.getElementById('picker-fit')) return;
    var st = document.createElement('style');
    st.id = 'picker-fit';
    st.textContent =
      '.picker-dialog-bg{position:fixed!important;top:0!important;left:0!important;width:100vw!important;height:100vh!important;z-index:10000!important}' +
      '.picker-dialog{position:fixed!important;top:50%!important;left:50%!important;transform:translate(-50%,-50%)!important;' +
      'max-width:calc(100vw - 16px)!important;max-height:calc(100vh - 16px)!important;z-index:10001!important}' +
      '.picker-dialog-content,.picker-dialog-content iframe{max-width:calc(100vw - 16px)!important;max-height:calc(100vh - 16px)!important}';
    document.head.appendChild(st);
  }

  /* Shows Google's own file chooser, limited to PDFs. Resolves with the chosen file, or null if cancelled. */
  function openPicker(t) {
    if (!API_KEY || API_KEY.indexOf('PASTE_') === 0) {
      return Promise.reject(new Error('The Picker key is not set in this build.'));
    }
    return loadPicker().then(function () {
      return new Promise(function (resolve) {
        var view = new google.picker.DocsView(google.picker.ViewId.DOCS).setMimeTypes(PDF);
        fitPickerStyle();
        new google.picker.PickerBuilder()
          .addView(view)
          .setSize(Math.max(320, Math.min(1051, window.innerWidth - 32)), Math.max(320, Math.min(650, window.innerHeight - 32)))
          .setOAuthToken(t)
          .setDeveloperKey(API_KEY)
          .setAppId(PROJECT_NUMBER)
          .setTitle('Open a PDF from Google Drive')
          .setCallback(function (data) {
            if (data.action === google.picker.Action.PICKED) resolve(data.docs[0]);
            else if (data.action === google.picker.Action.CANCEL) resolve(null);
          })
          .build()
          .setVisible(true);
      });
    });
  }

  function openDriveFile(f) {
    report('Opening ' + f.name + ' from Google Drive…');
    getToken().then(function (t) {
      return fetch(FILES + '/' + encodeURIComponent(f.id) + '?alt=media', { headers: { Authorization: 'Bearer ' + t } });
    }).then(function (r) {
      if (!r.ok) throw httpError(r);
      return r.blob();
    }).then(function (blob) {
      var file = new File([blob], f.name, { type: blob.type || '' });
      A.openFile(file, function (d) {
        d.drive = { id: f.id, rev: f.modifiedTime, at: Date.now() };
        d.driveSig = sig(d);
        d.driveConflict = false;
        d.driveError = '';
        A.save();
        refresh();
        report('Opened from Google Drive · ' + f.name);
      });
    }).catch(function (e) {
      if (e.status === 401) token = null;
      report('Not opened from Google Drive: ' + e.message, true);
    });
  }

  /* First press only loads Google's script; the sign-in window needs a fresh click. */
  function requireGis(then) {
    if (!navigator.onLine) {
      report('Google Drive needs an internet connection. Your PDF is still saved on this device.', true);
      return;
    }
    if (!gisReady()) {
      report('Loading Google sign-in…');
      loadGis().then(
        function () { report('Google sign-in is ready. Press the Drive button again.'); },
        function (e) { report(e.message, true); }
      );
      return;
    }
    then();
  }

  function wireButtons() {
    var saveBtn = document.getElementById('savedrive');
    if (saveBtn) {
      saveBtn.addEventListener('click', function () {
        requireGis(function () {
          var d = A.active();
          if (!d) { report('Open a PDF first.', true); return; }
          var tokenP = getToken(false);           /* starts the sign-in window while this click is still active */
          var fmt = A.formatOf(d), sent = sig(d);
          report('Saving to Google Drive…');
          A.blob(d, fmt)
            .then(function (blob) { return saveDeck(d, blob, A.fileName(d, fmt), mimeOf(fmt), sent, tokenP); })
            .then(
              function (r) {
                refresh();
                report('Saved to Google Drive · ' + r.name);
                schedule(1000);                   /* also brings other changed decks up to date */
              },
              function (e) { report('Not saved to Google Drive: ' + e.message, true); }
            );
        });
      });
    }

    var mailBtn = document.getElementById('emailall');
    if (mailBtn) mailBtn.addEventListener('click', emailAll);

    var openBtn = document.getElementById('opendrive');
    if (openBtn) {
      openBtn.addEventListener('click', function () {
        requireGis(function () {
          var tokenP = getToken(false);           /* starts the sign-in window while this click is still active */
          tokenP.then(function (t) {
            return openPicker(t).then(function (doc) {
              if (!doc) return;
              report('Opening ' + doc.name + ' from Google Drive…');
              return fetch(FILES + '/' + encodeURIComponent(doc.id) + '?fields=id,name,modifiedTime', {
                headers: { Authorization: 'Bearer ' + t }
              }).then(function (r) { if (!r.ok) throw httpError(r); return r.json(); })
                .then(function (meta) { openDriveFile(meta); });
            });
          }).catch(function (e) {
            if (e && e.status === 401) token = null;
            report('Could not open from Google Drive: ' + e.message, true);
          });
        });
      });
    }
  }

  /* Called by the app after every change to content (not for switching decks alone: the sync checks the content) */
  function touch() {
    if (!A) return;
    refresh();
    if (hasLinked()) schedule(DEBOUNCE_MS);
  }

  /* The app passes its functions here:
     decks(), active(), formatOf(deck), fileName(deck, fmt), blob(deck, fmt) -> Promise<Blob>,
     openFile(file, after(deck)), save(), status(text, isError) */
  function attach(adapter) {
    A = adapter;
    addStateElement();
    /* The toolbar buttons are made by office.js when the page finishes loading, so wire them then */
    if (document.getElementById('savedrive')) wireButtons();
    else document.addEventListener('DOMContentLoaded', wireButtons);
    ['keydown', 'input'].forEach(function (type) {
      document.addEventListener(type, function () { lastKey = Date.now(); }, true);
    });
    /* Load Google's sign-in script now, so the first click can open the sign-in window (browsers block it otherwise) */
    loadGis().catch(function () {});
    window.addEventListener('online', function () { refresh(); schedule(1000); });
    window.addEventListener('offline', refresh);
    refresh();
    if (linkedDirty().length) schedule(DEBOUNCE_MS);
  }

  window.TabbedDrive = {
    attach: attach,
    touch: touch,
    ready: gisReady,
    prepare: loadGis
  };
})();
