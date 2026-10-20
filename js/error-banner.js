// Shows a startup or runtime error on screen, so a broken build is visible
// instead of a screen where nothing works. A classic script, loaded first in
// <head>, so it also catches errors from the modules (including ones that
// fail to load or parse).
(function () {
  var seen = {};

  function show(message) {
    message = String(message || 'Unknown error').slice(0, 400);
    if (seen[message]) return;
    seen[message] = true;
    function put() {
      var bar = document.getElementById('error-banner');
      if (!bar) {
        bar = document.createElement('div');
        bar.id = 'error-banner';
        bar.setAttribute('role', 'alert');
        bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99999;padding:12px 16px;background:#3a0d0d;color:#fff;border-top:3px solid #ff3b3b;font:15px/1.4 -apple-system,Segoe UI,sans-serif;user-select:text;-webkit-user-select:text';
        var text = document.createElement('div');
        text.id = 'error-banner-text';
        var btn = document.createElement('button');
        btn.textContent = 'Clear app cache and reload';
        btn.style.cssText = 'margin-top:8px;min-height:44px;padding:0 16px;font:inherit;font-weight:700;border-radius:8px;border:2px solid #fff;background:#ff3b3b;color:#000';
        btn.onclick = function () {
          var jobs = [];
          if (navigator.serviceWorker) jobs.push(navigator.serviceWorker.getRegistrations().then(function (r) { return Promise.all(r.map(function (x) { return x.unregister(); })); }));
          if (window.caches) jobs.push(caches.keys().then(function (k) { return Promise.all(k.filter(function (n) { return n.indexOf('terra-client-') === 0; }).map(function (n) { return caches.delete(n); })); }));
          // Then a fresh service worker re-downloads every file past the HTTP cache.
          function go() { location.replace(location.pathname + '?v=' + Date.now().toString(36)); }
          Promise.all(jobs).then(function () {
            if (!navigator.serviceWorker) return go();
            return navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
              .then(function () { return Promise.race([navigator.serviceWorker.ready, new Promise(function (r) { setTimeout(r, 15000); })]); })
              .then(go, go);
          });
        };
        bar.appendChild(text);
        bar.appendChild(btn);
        document.body.appendChild(bar);
      }
      var line = document.createElement('div');
      line.textContent = (window.TERRA_VERSION ? 'v' + window.TERRA_VERSION + ': ' : '') + message;
      document.getElementById('error-banner-text').appendChild(line);
    }
    if (document.body) put(); else document.addEventListener('DOMContentLoaded', put);
  }

  window.addEventListener('error', function (e) {
    var where = e.filename ? ' (' + e.filename.split('/').slice(-2).join('/') + ':' + e.lineno + ')' : '';
    show((e.message || 'Script error') + where);
  });
  window.addEventListener('unhandledrejection', function (e) {
    show('Failed: ' + (e.reason && e.reason.message ? e.reason.message : e.reason));
  });
  window.__showError = show;
})();
