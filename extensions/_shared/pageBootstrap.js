// The first thing a previewed page runs (live-preview injects it into the
// HTML it serves; core's web proxy carries its own copy in
// server/src/webProxyRuntime.js, since core can't read extension files; the
// page agent bundle starts with it too, for a dev server's same-origin frame
// where nothing was injected). Two jobs, both of which have to start before
// the page's own scripts do:
//   - keep a log of the page's errors (console.error, uncaught exceptions,
//     rejected promises, failed requests and resources), so a comment can
//     carry them to the agent;
//   - install the page agent (pageAgent.js) when the Perch tab sends it.
// Plain ES2017, no imports; it runs inside an arbitrary page.
(function () {
  if (window.__pagePreviewErrors) return;
  var list = (window.__pagePreviewErrors = []);
  var MAX = 100;

  function describe(value) {
    if (value && value.stack) return String(value.stack);
    if (value && typeof value === "object") {
      try {
        return JSON.stringify(value);
      } catch (e) {
        return String(value);
      }
    }
    return String(value);
  }

  function add(kind, message, source) {
    // A proxy can name the real addresses in place of its own.
    var clean = window.__pagePreviewCleanUrl || function (x) {
      return x;
    };
    var entry = { kind: kind, message: clean(String(message)).slice(0, 1000), source: clean(source || ""), time: Date.now() };
    if (list.length >= MAX) list.shift();
    list.push(entry);
    try {
      if (window.parent !== window) window.parent.postMessage({ __pa: { type: "error", entry: entry } }, "*");
    } catch (e) {
      // the tab went away
    }
  }
  window.__pagePreviewAddError = add;

  var nativeError = console.error;
  console.error = function () {
    try {
      add("console", Array.prototype.map.call(arguments, describe).join(" "));
    } catch (e) {
      // logging must never break the page
    }
    return nativeError.apply(console, arguments);
  };

  window.addEventListener(
    "error",
    function (e) {
      var t = e.target;
      if (t && t !== window && t.nodeType === 1) {
        var url = t.currentSrc || t.src || t.href || "";
        add("resource", "Failed to load " + t.tagName.toLowerCase() + (url ? " " + url : ""));
        return;
      }
      add("exception", e.message || describe(e.error), (e.filename || "") + (e.lineno ? ":" + e.lineno + ":" + e.colno : ""));
    },
    true,
  );
  window.addEventListener("unhandledrejection", function (e) {
    add("rejection", "Unhandled rejection: " + describe(e.reason));
  });

  // Outermost wrappers, so they see the URL the page asked for.
  var nativeFetch = window.fetch;
  if (nativeFetch) {
    window.fetch = function (input, init) {
      var url = typeof input === "string" ? input : (input && input.url) || String(input);
      var method = (init && init.method) || (input && input.method) || "GET";
      return nativeFetch.apply(this, arguments).then(
        function (res) {
          if (res.status >= 400) add("network", method + " " + url + " → " + res.status);
          return res;
        },
        function (err) {
          add("network", method + " " + url + " failed: " + describe(err && err.message ? err.message : err));
          throw err;
        },
      );
    };
  }
  var nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var xhr = this;
    xhr.addEventListener("loadend", function () {
      if (xhr.status >= 400) add("network", method + " " + url + " → " + xhr.status);
      else if (xhr.status === 0) add("network", method + " " + url + " failed");
    });
    return nativeOpen.apply(this, arguments);
  };

  window.addEventListener("message", function (e) {
    if (e.source !== window.parent) return;
    var d = e.data && e.data.__pa;
    if (!d || d.cmd !== "install" || typeof d.source !== "string") return;
    if (window.__pageAgent) {
      if (window.__pageAgentAnnounce) window.__pageAgentAnnounce();
      return;
    }
    try {
      (0, eval)(d.source);
    } catch (err) {
      add("exception", "Perch couldn't start its page tools: " + describe(err));
    }
  });
})();
