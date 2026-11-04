/* Tabbed Apps link: lets Tabbed Folders hand a file to this app and receive it back on Save.
   Files are accepted only from Tabbed Folders, and only from the window that opened this one.
   Nothing leaves the device: the file passes between two browser tabs. */
(function () {
  'use strict';
  var FOLDERS = ['https://tabbedfolders.pages.dev'];
  var LOCAL = /^(127\.0\.0\.1|localhost)$/;
  function allowed(origin) {
    if (FOLDERS.indexOf(origin) >= 0) return true;
    try { return LOCAL.test(new URL(origin).hostname) && LOCAL.test(location.hostname); } catch (e) { return false; }
  }
  function opener() { try { return window.opener && !window.opener.closed ? window.opener : null; } catch (e) { return null; } }

  var onFile = null, queue = [], seen = {}, waiting = {}, seq = 0, readyTimer = null;

  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || typeof d !== 'object' || !allowed(e.origin)) return;
    if (d.type === 'tabbed-file' && typeof d.id === 'string' && typeof d.name === 'string' && d.file instanceof Blob) {
      if (e.source !== opener()) return;
      if (readyTimer) { clearInterval(readyTimer); readyTimer = null; }
      try { e.source.postMessage({ type: 'tabbed-received', id: d.id }, e.origin); } catch (x) {}
      if (seen[d.id]) return;
      seen[d.id] = true;
      var file = new File([d.file], d.name, { type: d.file.type || '', lastModified: d.lastModified || Date.now() });
      var link = { id: d.id, origin: e.origin, name: d.name };
      if (onFile) onFile(file, link); else queue.push([file, link]);
    } else if (d.type === 'tabbed-saved' && waiting[d.req]) {
      waiting[d.req](d); delete waiting[d.req];
    }
  });

  /* Open with / double-click from the operating system: hand the file to the app like a Tabbed Folders file */
  if (window.launchQueue) {
    window.launchQueue.setConsumer(function (params) {
      (params.files || []).forEach(function (handle) {
        handle.getFile().then(function (file) {
          if (onFile) onFile(file, null); else queue.push([file, null]);
        }).catch(function () {});
      });
    });
  }

  window.TabbedLink = {
    /* app calls this once it can open files */
    init: function (handler) {
      onFile = handler;
      while (queue.length) { var q = queue.shift(); handler(q[0], q[1]); }
      if (/(^|[#&])tabbed-open\b/.test(location.hash)) {
        try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
        var op = opener();
        if (op) {
          var tries = 0;
          var ping = function () { if (++tries > 60 || !opener()) { clearInterval(readyTimer); readyTimer = null; return; } try { op.postMessage({ type: 'tabbed-ready' }, '*'); } catch (e) {} };
          ping(); readyTimer = setInterval(ping, 250);
        }
      }
    },
    /* true while the Tabbed Folders window that opened this file is still open */
    available: function (link) { return !!(link && opener()); },
    /* send the saved file back; resolves {ok, name} or {ok:false, error} */
    saveBack: function (link, blob, name) {
      var op = opener();
      if (!link || !op) return Promise.resolve({ ok: false, error: 'Tabbed Folders is closed' });
      var req = ++seq;
      return new Promise(function (resolve) {
        var t = setTimeout(function () { delete waiting[req]; resolve({ ok: false, error: 'Tabbed Folders did not answer' }); }, 20000);
        waiting[req] = function (d) { clearTimeout(t); resolve({ ok: !!d.ok, name: d.name, error: d.error }); };
        try { op.postMessage({ type: 'tabbed-save', id: link.id, req: req, name: name || link.name, file: blob }, link.origin); }
        catch (e) { clearTimeout(t); delete waiting[req]; resolve({ ok: false, error: e.message }); }
      });
    }
  };
})();
