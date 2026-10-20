// Injected first into every page the web preview proxies (webProxyRewrite.ts),
// configured by window.__webPreview = { token, target, base, cookie }. Plain
// ES2017, no imports: it runs inside the site's own page, in a sandboxed frame
// with an opaque origin. It keeps what scripts build at runtime inside the
// proxy, stands in for the storage an opaque origin doesn't have, and talks to
// the Perch tab that owns the frame:
//   to the tab:   { __webPreview: { type: "location" | "open", url } }
//   from the tab: { __webPreviewCmd: "back" | "forward" | "reload" }
// Picking, screenshots and the error log go through the page agent the tab
// installs (extensions/_shared/pageAgent.js, via the bootstrap at the end).
(function () {
  "use strict";
  var cfg = window.__webPreview;
  if (!cfg || window.__webPreviewRuntime) return;
  window.__webPreviewRuntime = true;

  var TOKEN = cfg.token;
  var WP_PARAM = "__wp";
  var PERCH = location.origin;
  var RESOURCE_PREFIX = "/web/" + TOKEN + "/";
  var targetOrigin = new URL(cfg.target).origin;
  var declaredBase = cfg.base ? new URL(cfg.base) : null;
  // The frame the Perch tab owns, rather than one the page nested in itself.
  var isTabFrame = window.parent === window.top && window.parent !== window;
  var PASS_THROUGH = /^\s*(data|blob|javascript|about|mailto|tel|sms|file|chrome|chrome-extension):/i;

  var nativeFetch = window.fetch;
  var nativeSetAttribute = Element.prototype.setAttribute;
  var nativePushState = history.pushState;
  var nativeReplaceState = history.replaceState;

  function post(message) {
    if (!isTabFrame) return;
    try {
      window.parent.postMessage(message, "*");
    } catch (e) {
      // the tab went away
    }
  }

  // ---- Addresses ----

  function wpValue(u) {
    return TOKEN + "~" + u.protocol.slice(0, -1) + "~" + u.host;
  }

  function stripWp(search) {
    var parts = search.replace(/^\?/, "").split("&").filter(function (p) {
      return p !== "" && p.split("=")[0] !== WP_PARAM;
    });
    return parts.length ? "?" + parts.join("&") : "";
  }

  function parseResourcePath(pathname, search, hash) {
    var m = /^\/web\/[A-Za-z0-9_-]+\/(https?|wss?)\/([^/]+)(.*)$/.exec(pathname);
    if (!m) return null;
    try {
      return new URL(m[1] + "://" + m[2] + (m[3] || "/") + search + hash);
    } catch (e) {
      return null;
    }
  }

  // Which site a URL on this server stands for, from either proxy form.
  function siteFromPerchUrl(u) {
    var resource = parseResourcePath(u.pathname, u.search, u.hash);
    if (resource) return resource;
    var params = new URLSearchParams(u.search);
    var wp = params.get(WP_PARAM);
    var m = wp && /^[A-Za-z0-9_-]+~(https?|wss?)~(.+)$/.exec(wp);
    if (!m) return null;
    try {
      return new URL(m[1] + "://" + m[2] + u.pathname + stripWp(u.search) + u.hash);
    } catch (e) {
      return null;
    }
  }

  // The page's real address right now (history.pushState can change it).
  function currentReal() {
    return siteFromPerchUrl(new URL(location.href)) || new URL(location.pathname + stripWp(location.search) + location.hash, targetOrigin);
  }

  function resolveBase() {
    return declaredBase || currentReal();
  }

  // A URL as the page means it: resolved against the site, not this server.
  function realUrl(raw) {
    if (raw == null) return null;
    var s = String(raw);
    if (!s.trim() || s.trim().charAt(0) === "#" || PASS_THROUGH.test(s)) return null;
    var u;
    try {
      // A root-relative address the proxy already wrote (a rewritten
      // url() a script reads back out of a stylesheet) is this server's.
      u = new URL(s, /^\s*\/web\/[A-Za-z0-9_-]+\/(https?|wss?)\//.test(s) ? PERCH : resolveBase());
    } catch (e) {
      return null;
    }
    if (u.origin === PERCH) {
      u = siteFromPerchUrl(u) || new URL(u.pathname + u.search + u.hash, resolveBase().origin);
    }
    return /^(https?|wss?):$/.test(u.protocol) ? u : null;
  }

  function resourcePath(u) {
    return RESOURCE_PREFIX + u.protocol.slice(0, -1) + "/" + u.host + u.pathname + u.search + u.hash;
  }

  function documentPath(u) {
    var own = stripWp(u.search);
    return u.pathname + (own ? own + "&" : "?") + WP_PARAM + "=" + encodeURIComponent(wpValue(u)) + u.hash;
  }

  function toResource(raw) {
    var u = realUrl(raw);
    return u ? PERCH + resourcePath(u) : raw;
  }

  function toSocket(raw) {
    var u = realUrl(raw);
    if (!u) return raw;
    return (location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host + resourcePath(u);
  }

  function fromResource(value) {
    if (typeof value !== "string" || value.indexOf(PERCH + "/web/") !== 0) return value;
    var u = new URL(value);
    var real = parseResourcePath(u.pathname, u.search, u.hash);
    return real ? real.href : value;
  }

  // ---- Cookies ----
  // An opaque origin has no cookie jar; the server keeps the site's cookies
  // (webProxyCookies.ts). document.cookie reads a local copy, seeded at load
  // and refreshed from responses, and writes go to the server.

  var cookieCache = cfg.cookie || "";
  var cookieWrites = Promise.resolve();

  function applyLocalCookie(str) {
    var first = str.split(";")[0];
    var eq = first.indexOf("=");
    var name = (eq === -1 ? "" : first.slice(0, eq)).trim();
    var attrs = str.toLowerCase();
    var expired = /;\s*max-age\s*=\s*(-\d+|0)\b/.test(attrs);
    var expires = /;\s*expires\s*=\s*([^;]+)/.exec(attrs);
    if (expires && Date.parse(expires[1]) <= Date.now()) expired = true;
    var kept = cookieCache
      .split(/;\s*/)
      .filter(function (c) {
        return c && c.split("=")[0] !== name;
      });
    if (!expired && /httponly/.test(attrs) === false) kept.push(first.trim());
    cookieCache = kept.join("; ");
  }

  function noteCookieHeader(value) {
    if (value == null) return;
    try {
      cookieCache = decodeURIComponent(value);
    } catch (e) {
      // keep the old copy
    }
  }

  try {
    Object.defineProperty(document, "cookie", {
      configurable: true,
      get: function () {
        return cookieCache;
      },
      set: function (value) {
        var str = String(value);
        applyLocalCookie(str);
        var url = PERCH + RESOURCE_PREFIX + "__perch/cookie?u=" + encodeURIComponent(currentReal().href);
        // Requests the page makes after this wait for it, as they would see
        // a browser's cookie straight away.
        cookieWrites = cookieWrites.then(function () {
          return nativeFetch(url, { method: "POST", body: str, keepalive: true }).catch(function () {});
        });
      },
    });
  } catch (e) {
    // a page that already redefined it keeps its own
  }

  // ---- Storage ----
  // localStorage/sessionStorage throw in an opaque origin; an in-memory
  // stand-in lasts as long as the page, which is enough for most sites to run.

  function memoryStorage() {
    var data = new Map();
    var api = {
      getItem: function (k) {
        k = String(k);
        return data.has(k) ? data.get(k) : null;
      },
      setItem: function (k, v) {
        data.set(String(k), String(v));
      },
      removeItem: function (k) {
        data.delete(String(k));
      },
      clear: function () {
        data.clear();
      },
      key: function (i) {
        var keys = Array.from(data.keys());
        return i < keys.length ? keys[i] : null;
      },
    };
    Object.defineProperty(api, "length", {
      get: function () {
        return data.size;
      },
    });
    return new Proxy(api, {
      get: function (t, p) {
        if (p in t) return t[p];
        return typeof p === "string" && data.has(p) ? data.get(p) : undefined;
      },
      set: function (t, p, v) {
        if (p in t) return false;
        data.set(String(p), String(v));
        return true;
      },
      deleteProperty: function (t, p) {
        data.delete(String(p));
        return true;
      },
      has: function (t, p) {
        return p in t || data.has(p);
      },
      ownKeys: function () {
        return Array.from(data.keys());
      },
      getOwnPropertyDescriptor: function (t, p) {
        if (!data.has(p)) return undefined;
        return { value: data.get(p), writable: true, enumerable: true, configurable: true };
      },
    });
  }

  ["localStorage", "sessionStorage"].forEach(function (name) {
    var works = false;
    try {
      works = !!window[name];
    } catch (e) {
      works = false;
    }
    if (works) return;
    try {
      Object.defineProperty(window, name, { configurable: true, value: memoryStorage() });
    } catch (e) {
      // leave it throwing
    }
  });

  // ---- Network ----
  // Everything goes to this server, which is cross-origin to the page's
  // opaque origin, so a request leaves cookies out unless it asks for them.
  // A relay's sign-in in front of this server can be such a cookie (see
  // webProxy.ts), so the page's own requests ask, unless the page said
  // "omit". The proxy answers credentialed requests.

  window.fetch = function (input, init) {
    try {
      if (typeof Request !== "undefined" && input instanceof Request) {
        var next = toResource(input.url);
        if (next !== input.url) input = new Request(next, input);
        if (input.credentials !== "omit" && !(init && init.credentials)) {
          input = new Request(input, { credentials: "include" });
        }
      } else {
        input = toResource(input);
        if (!init || !init.credentials) init = Object.assign({}, init || {}, { credentials: "include" });
      }
    } catch (e) {
      // send it as the page wrote it
    }
    var self = this;
    return cookieWrites.then(function () {
      return nativeFetch.call(self, input, init).then(function (res) {
        noteCookieHeader(res.headers.get("x-web-preview-cookie"));
        return res;
      });
    });
  };

  var nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var args = Array.prototype.slice.call(arguments);
    args[1] = toResource(url);
    var xhr = this;
    xhr.addEventListener("readystatechange", function () {
      if (xhr.readyState === 2) {
        try {
          noteCookieHeader(xhr.getResponseHeader("x-web-preview-cookie"));
        } catch (e) {
          // not exposed
        }
      }
    });
    var result = nativeOpen.apply(this, args);
    try {
      xhr.withCredentials = true;
    } catch (e) {
      // a synchronous request can't; it goes without
    }
    return result;
  };

  function wrapConstructor(Native, rewrite) {
    if (!Native) return Native;
    function Wrapped(url, opts) {
      return arguments.length > 1 ? new Native(rewrite(url), opts) : new Native(rewrite(url));
    }
    Wrapped.prototype = Native.prototype;
    Object.keys(Native).forEach(function (k) {
      Wrapped[k] = Native[k];
    });
    ["CONNECTING", "OPEN", "CLOSING", "CLOSED"].forEach(function (k) {
      if (k in Native) Object.defineProperty(Wrapped, k, { value: Native[k] });
    });
    return Wrapped;
  }

  window.WebSocket = wrapConstructor(window.WebSocket, toSocket);
  var NativeEventSource = window.EventSource;
  if (NativeEventSource) {
    window.EventSource = wrapConstructor(NativeEventSource, toResource);
    var WrappedEventSource = window.EventSource;
    window.EventSource = function (url, opts) {
      return new WrappedEventSource(url, Object.assign({ withCredentials: true }, opts || {}));
    };
    window.EventSource.prototype = NativeEventSource.prototype;
    ["CONNECTING", "OPEN", "CLOSED"].forEach(function (k) {
      if (k in NativeEventSource) Object.defineProperty(window.EventSource, k, { value: NativeEventSource[k] });
    });
  }

  // Fonts a script creates: through the proxy, or from their own host when
  // the server says fonts can't come through it (cfg.fontsDirect).
  if (window.FontFace) {
    var NativeFontFace = window.FontFace;
    window.FontFace = function (family, source, descriptors) {
      if (typeof source === "string") {
        source = source.replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, function (whole, quote, value) {
          var u = realUrl(value);
          if (!u) return whole;
          return "url(" + quote + (cfg.fontsDirect ? u.href : PERCH + resourcePath(u)) + quote + ")";
        });
      }
      return new NativeFontFace(family, source, descriptors);
    };
    window.FontFace.prototype = NativeFontFace.prototype;
  }
  window.Worker = wrapConstructor(window.Worker, toResource);
  if (window.SharedWorker) window.SharedWorker = wrapConstructor(window.SharedWorker, toResource);

  if (navigator.sendBeacon) {
    var nativeBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      return nativeBeacon(toResource(url), data);
    };
  }

  window.open = function (url) {
    var u = realUrl(url == null || url === "" ? "about:blank" : url);
    if (u) post({ __webPreview: { type: "open", url: u.href } });
    return null;
  };

  // ---- Elements ----

  function rewriteSrcset(value) {
    return String(value)
      .split(",")
      .map(function (candidate) {
        var t = candidate.trim();
        if (!t) return candidate;
        var space = t.search(/\s/);
        var url = space === -1 ? t : t.slice(0, space);
        return toResource(url) + (space === -1 ? "" : t.slice(space));
      })
      .join(", ");
  }

  function patchProperty(Ctor, prop, rewrite) {
    if (!Ctor) return;
    var d = Object.getOwnPropertyDescriptor(Ctor.prototype, prop);
    if (!d || !d.set) return;
    Object.defineProperty(Ctor.prototype, prop, {
      configurable: true,
      enumerable: d.enumerable,
      get: function () {
        return fromResource(d.get.call(this));
      },
      set: function (value) {
        d.set.call(this, rewrite(value));
      },
    });
  }

  [
    [window.HTMLImageElement, "src"],
    [window.HTMLScriptElement, "src"],
    [window.HTMLLinkElement, "href"],
    [window.HTMLIFrameElement, "src"],
    [window.HTMLSourceElement, "src"],
    [window.HTMLMediaElement, "src"],
    [window.HTMLVideoElement, "poster"],
    [window.HTMLTrackElement, "src"],
    [window.HTMLEmbedElement, "src"],
    [window.HTMLObjectElement, "data"],
    [window.HTMLInputElement, "src"],
  ].forEach(function (pair) {
    patchProperty(pair[0], pair[1], toResource);
  });
  patchProperty(window.HTMLImageElement, "srcset", rewriteSrcset);
  patchProperty(window.HTMLSourceElement, "srcset", rewriteSrcset);

  // A script or element that asks for CORS gets the credentialed kind (see
  // Network above); a module script always loads in CORS mode.
  function credentialed(value) {
    return value == null ? value : "use-credentials";
  }
  patchProperty(window.HTMLScriptElement, "crossOrigin", credentialed);
  patchProperty(window.HTMLLinkElement, "crossOrigin", credentialed);
  patchProperty(window.HTMLImageElement, "crossOrigin", credentialed);
  patchProperty(window.HTMLMediaElement, "crossOrigin", credentialed);
  var scriptType = window.HTMLScriptElement && Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, "type");
  if (scriptType && scriptType.set) {
    Object.defineProperty(HTMLScriptElement.prototype, "type", {
      configurable: true,
      enumerable: scriptType.enumerable,
      get: scriptType.get,
      set: function (value) {
        scriptType.set.call(this, value);
        if (String(value).toLowerCase() === "module") nativeSetAttribute.call(this, "crossorigin", "use-credentials");
      },
    });
  }

  var LOADING_ATTRS = { src: 1, poster: 1, data: 1, action: 1, formaction: 1, background: 1 };
  Element.prototype.setAttribute = function (name, value) {
    var n = String(name).toLowerCase();
    var tag = this.tagName ? this.tagName.toLowerCase() : "";
    if (n === "crossorigin") {
      value = "use-credentials";
    } else if (n === "type" && tag === "script" && String(value).toLowerCase() === "module") {
      nativeSetAttribute.call(this, "crossorigin", "use-credentials");
    } else if (LOADING_ATTRS[n] || (n === "href" && (tag === "link" || tag === "use" || tag === "image"))) {
      value = toResource(value);
    } else if (n === "srcset" || n === "imagesrcset") {
      value = rewriteSrcset(value);
    }
    return nativeSetAttribute.call(this, name, value);
  };

  // Markup a script inserts as HTML (innerHTML) bypasses the setters above;
  // its URLs are routed once it lands. The first request may already have
  // gone out bare and failed, the second is the one that counts.
  function routeInserted(el) {
    if (!el || el.nodeType !== 1) return;
    var nodes = [el].concat(Array.prototype.slice.call(el.querySelectorAll ? el.querySelectorAll("[src],[srcset],link[href],[poster]") : []));
    nodes.forEach(function (node) {
      ["src", "poster"].forEach(function (attr) {
        var v = node.getAttribute && node.getAttribute(attr);
        if (v && v.indexOf(RESOURCE_PREFIX) === -1) {
          var next = toResource(v);
          if (next !== v) nativeSetAttribute.call(node, attr, next);
        }
      });
      var srcset = node.getAttribute && node.getAttribute("srcset");
      if (srcset && srcset.indexOf(RESOURCE_PREFIX) === -1) nativeSetAttribute.call(node, "srcset", rewriteSrcset(srcset));
      if (node.tagName === "LINK") {
        var href = node.getAttribute("href");
        if (href && href.indexOf(RESOURCE_PREFIX) === -1) {
          var nextHref = toResource(href);
          if (nextHref !== href) nativeSetAttribute.call(node, "href", nextHref);
        }
      }
    });
  }
  if (window.MutationObserver) {
    new MutationObserver(function (records) {
      records.forEach(function (r) {
        Array.prototype.forEach.call(r.addedNodes, routeInserted);
      });
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  // ---- Navigation ----
  // A link's own default would load it against this server's root, which
  // doesn't know the site (an opaque-origin document sends no Referer), so a
  // click a page doesn't handle itself is routed through the proxy here. A
  // site's own router still sees the click first and can keep it. Script
  // navigations (location.href = "/x") reach the server bare; it asks the
  // Perch tab, which knows the site, to open the path.

  function navigate(u) {
    location.href = documentPath(u);
  }

  window.addEventListener("click", function (e) {
    if (e.defaultPrevented || e.button !== 0) return;
    var el = e.target && e.target.closest ? e.target.closest("a[href], area[href]") : null;
    if (!el || el.hasAttribute("download")) return;
    var u = realUrl(el.getAttribute("href"));
    if (!u) return;
    var targetAttr = (el.getAttribute("target") || "").toLowerCase();
    if (targetAttr === "_blank" || e.ctrlKey || e.metaKey || e.shiftKey) {
      e.preventDefault();
      post({ __webPreview: { type: "open", url: u.href } });
      return;
    }
    var here = currentReal();
    // A jump within this page scrolls; anything else loads through the proxy.
    if (u.origin === here.origin && u.pathname === here.pathname && u.search === here.search && u.hash) return;
    e.preventDefault();
    navigate(u);
  });

  window.addEventListener("submit", function (e) {
    if (e.defaultPrevented) return;
    var form = e.target;
    var submitter = e.submitter;
    var holder = submitter && submitter.hasAttribute("formaction") ? submitter : form;
    var attr = holder === form ? "action" : "formaction";
    var raw = holder.getAttribute(attr);
    var u = realUrl(raw || currentReal().href);
    if (!u) return;
    var method = ((submitter && submitter.getAttribute("formmethod")) || form.getAttribute("method") || "get").toLowerCase();
    // A GET form replaces the query, which would drop the site parameter.
    if (method === "get" || u.origin !== currentReal().origin) {
      nativeSetAttribute.call(holder, attr, u.origin === currentReal().origin ? u.pathname : PERCH + resourcePath(u));
      if (method === "get" && u.origin === currentReal().origin) {
        var hidden = form.querySelector('input[name="' + WP_PARAM + '"]') || document.createElement("input");
        hidden.type = "hidden";
        hidden.name = WP_PARAM;
        hidden.value = wpValue(u);
        if (!hidden.parentNode) form.appendChild(hidden);
      }
    }
  });

  // pushState/replaceState: the address a page passes is on the site. An
  // opaque-origin document may only change its query and fragment, so a new
  // path becomes a real navigation, which the site's router then handles on
  // load as it would a typed address.
  function historyCall(native) {
    return function (state, title, url) {
      if (url == null) return native.call(history, state, title);
      var u = realUrl(url);
      if (!u) return native.call(history, state, title, url);
      var next = documentPath(u);
      try {
        native.call(history, state, title, next);
      } catch (err) {
        if (native === nativeReplaceState) location.replace(next);
        else location.assign(next);
        return;
      }
      reportLocation();
    };
  }
  history.pushState = historyCall(nativePushState);
  history.replaceState = historyCall(nativeReplaceState);

  function reportLocation() {
    post({ __webPreview: { type: "location", url: currentReal().href, title: document.title } });
  }
  window.addEventListener("popstate", reportLocation);
  window.addEventListener("hashchange", reportLocation);
  window.addEventListener("load", reportLocation);
  if (document.readyState !== "loading") reportLocation();
  else document.addEventListener("DOMContentLoaded", reportLocation);

  window.addEventListener("message", function (e) {
    if (e.source !== window.parent || !isTabFrame) return;
    var cmd = e.data && e.data.__webPreviewCmd;
    if (cmd === "back") history.back();
    else if (cmd === "forward") history.forward();
    else if (cmd === "reload") location.reload();
  });

  // Error messages and their sources name this server's addresses; the
  // error log (below) shows the site's instead.
  window.__pagePreviewCleanUrl = function (text) {
    return String(text).replace(/(https?:\/\/[^\s"'()]+)/g, function (url) {
      try {
        var u = new URL(url);
        if (u.origin !== PERCH) return url;
        var real = siteFromPerchUrl(u);
        return real ? real.href : url;
      } catch (e) {
        return url;
      }
    });
  };

  // ---- Page bootstrap ----
  // A copy of extensions/_shared/pageBootstrap.js (core can't read extension
  // files): the page's error log, and installing the page agent the Perch tab
  // sends. Last here so its fetch/XHR wrappers sit outermost and log the
  // addresses the page asked for, not the proxy's. Keep the two in step.
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
})();
