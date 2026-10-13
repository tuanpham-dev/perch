// The page agent: the tools a Perch preview tab runs inside the page it
// shows (an HTML file, a dev server, a proxied site). The tab installs it
// after the page loads, by message for a sandboxed frame (see
// pageBootstrap.js) or by eval for a same-origin one, and talks to it with
//   tab → page:  { __pa: { cmd, ... } }
//   page → tab:  { __pa: { type, ... } }
// It picks elements (one, several, an area, selected text), keeps reporting
// where picked elements are as the page scrolls and changes, takes
// screenshots of what's in view, and hands over the error log the bootstrap
// keeps. Bundled after the screenshot library (window.__perchHtmlToImage) and
// the bootstrap by extensions/build.mjs. Plain ES2017, no imports.
(function () {
  // Already here (the tab installs again after any load it sees): just say
  // so again, so the tab knows the page is ready.
  if (window.__pageAgent) {
    if (window.__pageAgentAnnounce) window.__pageAgentAnnounce();
    return;
  }
  window.__pageAgent = true;

  var OVERLAY = "__perchOverlay";
  var STYLE_PROPS = ["display", "position", "top", "right", "bottom", "left", "width", "height",
    "margin", "padding", "boxSizing", "color", "backgroundColor", "fontFamily", "fontSize",
    "fontWeight", "lineHeight", "flexDirection", "justifyContent", "alignItems"];
  var MAX_HTML = 4000;

  function post(type, data) {
    var message = { __pa: Object.assign({ type: type }, data || {}) };
    try {
      window.parent.postMessage(message, "*");
    } catch (e) {
      // the tab went away
    }
  }

  // ---- Helpers ----

  function rectOf(r) {
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }

  function unionRect(rects) {
    if (!rects.length) return null;
    var l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    rects.forEach(function (x) {
      l = Math.min(l, x.left);
      t = Math.min(t, x.top);
      r = Math.max(r, x.left + x.width);
      b = Math.max(b, x.top + x.height);
    });
    return { left: l, top: t, width: r - l, height: b - t };
  }

  // A short CSS-like path: tag#id (stops at an id), else tag.class1.class2
  // plus :nth-of-type(n) among same-tag siblings. A locator for a person or
  // an agent, and for finding the element again after a reload.
  function selectorFor(el) {
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.body && node !== document.documentElement) {
      var part = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift(part + "#" + cssEscape(node.id));
        break;
      }
      if (typeof node.className === "string" && node.className.trim()) {
        var cls = node.className.trim().split(/\s+/).filter(function (c) {
          return /^[A-Za-z_-][\w-]*$/.test(c);
        }).slice(0, 2);
        if (cls.length) part += "." + cls.join(".");
      }
      var parent = node.parentElement;
      if (parent) {
        var current = node;
        var siblings = Array.prototype.filter.call(parent.children, function (c) {
          return c.tagName === current.tagName;
        });
        if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(node) + 1) + ")";
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(" > ") || (el.tagName ? el.tagName.toLowerCase() : "");
  }

  function cssEscape(s) {
    return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^\w-]/g, "\\$&");
  }

  function stylesOf(el) {
    var cs = window.getComputedStyle(el);
    var styles = {};
    STYLE_PROPS.forEach(function (p) {
      styles[p] = cs[p];
    });
    return styles;
  }

  function htmlOf(el) {
    var html = el.outerHTML || "";
    return html.length > MAX_HTML ? html.slice(0, MAX_HTML) + "…" : html;
  }

  function isOurs(el) {
    return !!(el && el[OVERLAY]);
  }

  function box(color, fill) {
    var d = document.createElement("div");
    d[OVERLAY] = true;
    d.style.cssText = "position:fixed;pointer-events:none;z-index:2147483647;box-sizing:border-box;display:none;" +
      "border:" + (fill ? "1px solid " : "2px dashed ") + color + ";background:" + (fill ? fill : "transparent") + ";";
    document.documentElement.appendChild(d);
    return d;
  }

  function place(d, r) {
    if (!r) {
      d.style.display = "none";
      return;
    }
    d.style.left = r.left + "px";
    d.style.top = r.top + "px";
    d.style.width = r.width + "px";
    d.style.height = r.height + "px";
    d.style.display = "block";
  }

  // Where in the picked rect the user clicked, as fractions of its size, so
  // the comment's badge sits there and moves with the element.
  function anchorIn(r, point) {
    if (!r || !point || !r.width || !r.height) return { fx: 0.5, fy: 0.5 };
    return {
      fx: Math.min(1, Math.max(0, (point.x - r.left) / r.width)),
      fy: Math.min(1, Math.max(0, (point.y - r.top) / r.height)),
    };
  }

  // ---- What's been picked, by id, so it can be found again ----

  var picks = new Map();
  var nextPick = 1;

  function remember(entry) {
    var id = "p" + nextPick++;
    picks.set(id, entry);
    return id;
  }

  function elementPick(el, point) {
    var pickId = remember({ elements: [el] });
    var rect = rectOf(el.getBoundingClientRect());
    return {
      anchor: anchorIn(rect, point),
      kind: "element",
      pickId: pickId,
      selector: selectorFor(el),
      outerHTML: htmlOf(el),
      styles: stylesOf(el),
      rect: rect,
    };
  }

  function elementsPick(els, point) {
    var pickId = remember({ elements: els });
    var selectors = els.map(selectorFor);
    var union = unionRect(els.map(function (e) {
      return rectOf(e.getBoundingClientRect());
    }));
    return {
      anchor: anchorIn(union, point),
      kind: "elements",
      pickId: pickId,
      selector: selectors.join(", "),
      selectors: selectors,
      outerHTML: els.map(htmlOf).join("\n").slice(0, MAX_HTML * 2),
      styles: stylesOf(els[0]),
      rect: union,
    };
  }

  // The outermost elements lying wholly inside an area: what the area is of.
  function elementsIn(r) {
    var found = [];
    var all = document.body ? document.body.getElementsByTagName("*") : [];
    for (var i = 0; i < all.length && found.length < 12; i++) {
      var el = all[i];
      if (isOurs(el)) continue;
      var b = el.getBoundingClientRect();
      // Screen-reader-only text and other things nobody sees aren't what an
      // area is of.
      if (b.width < 3 || b.height < 3 || !isSeen(el)) continue;
      if (b.left >= r.left && b.top >= r.top && b.right <= r.left + r.width && b.bottom <= r.top + r.height) {
        if (!found.some(function (f) {
          return f.contains(el);
        })) found.push(el);
      }
    }
    return found;
  }

  function isSeen(el) {
    var cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) return false;
    if (cs.clip && cs.clip !== "auto" && /rect\(0(px)?,?\s*0(px)?/.test(cs.clip)) return false;
    return true;
  }

  // The smallest visible element around a point that covers the whole area.
  function containerOf(r) {
    var el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    while (el && el !== document.body && el !== document.documentElement) {
      var b = el.getBoundingClientRect();
      if (!isOurs(el) && b.left <= r.left + 1 && b.top <= r.top + 1 && b.right >= r.left + r.width - 1 && b.bottom >= r.top + r.height - 1) return el;
      el = el.parentElement;
    }
    return document.body;
  }

  function areaPick(r, point) {
    var inside = elementsIn(r);
    // Kept in document coordinates, so the area scrolls with the page.
    var pickId = remember({
      area: { left: r.left + scrollX, top: r.top + scrollY, width: r.width, height: r.height },
      container: containerOf(r),
    });
    var selectors = inside.map(selectorFor);
    var center = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    var around = center && !isOurs(center) ? center : document.body;
    return {
      anchor: anchorIn(r, point),
      kind: "area",
      pickId: pickId,
      selector: selectors.length ? selectors.slice(0, 4).join(", ") + (selectors.length > 4 ? ", …" : "") : selectorFor(around),
      selectors: selectors,
      outerHTML: (inside.length ? inside : [around]).map(htmlOf).join("\n").slice(0, MAX_HTML * 2),
      styles: stylesOf(inside[0] || around),
      rect: rectOf(r),
    };
  }

  function textPick(range, point) {
    var node = range.commonAncestorContainer;
    var el = node.nodeType === 1 ? node : node.parentElement;
    var pickId = remember({ range: range.cloneRange(), elements: [el] });
    var rr = rectOf(range.getBoundingClientRect());
    var first = range.getClientRects()[0];
    return {
      // Where the selection starts, unless the mouse said otherwise.
      anchor: anchorIn(rr, point || (first ? { x: first.left, y: first.top + first.height / 2 } : null)),
      kind: "text",
      pickId: pickId,
      selector: selectorFor(el),
      quote: String(range.toString()).slice(0, 2000),
      outerHTML: htmlOf(el),
      styles: stylesOf(el),
      rect: rr,
    };
  }

  // ---- Picking ----
  // Click an element; Shift+click to gather several, then click (or Enter)
  // to finish; drag to mark an area. Esc cancels.

  var mode = null; // "element" | "text"
  var hoverBox = null;
  var dragBox = null;
  var chosen = [];
  var chosenBoxes = [];
  var down = null;
  var hovered = null;

  function clearChosen() {
    chosen = [];
    chosenBoxes.forEach(function (b) {
      b.remove();
    });
    chosenBoxes = [];
  }

  function disarm() {
    mode = null;
    down = null;
    if (hoverBox) place(hoverBox, null);
    if (dragBox) place(dragBox, null);
    clearChosen();
    document.documentElement.style.cursor = "";
  }

  // Picking ends on mouseup; the click the browser sends right after it
  // must still not reach the page (it would follow a link, submit a form).
  var swallowClickUntil = 0;

  function finish(pick) {
    disarm();
    swallowClickUntil = Date.now() + 500;
    post("picked", { pick: pick });
  }

  function targetAt(x, y) {
    var el = document.elementFromPoint(x, y);
    return el && !isOurs(el) ? el : null;
  }

  document.addEventListener("mousemove", function (e) {
    if (mode !== "element") return;
    if (down) {
      var dx = e.clientX - down.x;
      var dy = e.clientY - down.y;
      if (!down.dragging && Math.abs(dx) + Math.abs(dy) > 6) down.dragging = true;
      if (down.dragging) {
        dragBox = dragBox || box("rgba(79,168,255,0.95)", "rgba(79,168,255,0.12)");
        place(dragBox, {
          left: Math.min(down.x, e.clientX),
          top: Math.min(down.y, e.clientY),
          width: Math.abs(dx),
          height: Math.abs(dy),
        });
        if (hoverBox) place(hoverBox, null);
        return;
      }
    }
    var el = targetAt(e.clientX, e.clientY);
    if (!el) return;
    hovered = el;
    hoverBox = hoverBox || box("rgba(79,168,255,0.9)", "rgba(79,168,255,0.25)");
    place(hoverBox, rectOf(el.getBoundingClientRect()));
  }, true);

  document.addEventListener("mousedown", function (e) {
    if (mode !== "element" || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    down = { x: e.clientX, y: e.clientY, dragging: false };
  }, true);

  document.addEventListener("mouseup", function (e) {
    if (mode === "text") {
      var sel = window.getSelection();
      if (sel && sel.rangeCount && !sel.isCollapsed) finish(textPick(sel.getRangeAt(0), { x: e.clientX, y: e.clientY }));
      return;
    }
    if (mode !== "element" || !down) return;
    e.preventDefault();
    e.stopPropagation();
    var start = down;
    down = null;
    if (start.dragging) {
      var r = {
        left: Math.min(start.x, e.clientX),
        top: Math.min(start.y, e.clientY),
        width: Math.abs(e.clientX - start.x),
        height: Math.abs(e.clientY - start.y),
      };
      finish(areaPick(r, { x: start.x, y: start.y }));
      return;
    }
    var el = hovered || targetAt(e.clientX, e.clientY);
    if (!el) return;
    if (e.shiftKey) {
      var at = chosen.indexOf(el);
      if (at === -1) {
        chosen.push(el);
        var b = box("rgba(255,170,0,0.95)");
        place(b, rectOf(el.getBoundingClientRect()));
        chosenBoxes.push(b);
      } else {
        chosen.splice(at, 1);
        chosenBoxes.splice(at, 1)[0].remove();
      }
      return;
    }
    var point = { x: e.clientX, y: e.clientY };
    if (chosen.length) {
      if (chosen.indexOf(el) === -1) chosen.push(el);
      finish(elementsPick(chosen.slice(), point));
      return;
    }
    finish(elementPick(el, point));
  }, true);

  // The click that follows a picking mouseup must not reach the page.
  function swallow(e) {
    if (mode !== "element" && Date.now() > swallowClickUntil) return;
    swallowClickUntil = 0;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }
  window.addEventListener("click", swallow, true);
  window.addEventListener("auxclick", swallow, true);

  document.addEventListener("keydown", function (e) {
    if (!mode) return;
    if (e.key === "Escape") {
      e.preventDefault();
      disarm();
      post("cancelled");
    } else if (e.key === "Enter" && chosen.length) {
      e.preventDefault();
      finish(elementsPick(chosen.slice(), null));
    }
  }, true);

  function startPick(kind) {
    disarm();
    if (kind === "text") {
      var sel = window.getSelection();
      if (sel && sel.rangeCount && !sel.isCollapsed) {
        finish(textPick(sel.getRangeAt(0), null));
        return;
      }
      mode = "text";
      document.documentElement.style.cursor = "text";
      return;
    }
    mode = "element";
    document.documentElement.style.cursor = "crosshair";
  }

  // ---- Where picked things are now ----

  var tracked = [];
  var found = new Map();
  var scheduled = false;

  function currentRect(item) {
    var entry = item.pickId ? picks.get(item.pickId) : null;
    if (entry && entry.area) {
      var a = entry.area;
      return { left: a.left - scrollX, top: a.top - scrollY, width: a.width, height: a.height };
    }
    if (entry && entry.range && entry.range.startContainer.isConnected) {
      var rr = entry.range.getBoundingClientRect();
      if (rr.width || rr.height) return rectOf(rr);
    }
    var els = entry && entry.elements ? entry.elements.filter(function (e) {
      return e && e.isConnected;
    }) : [];
    if (!els.length) {
      // After a reload the elements are new ones: find them again.
      var cached = found.get(item.id);
      if (cached && cached.every(function (e) {
        return e.isConnected;
      })) els = cached;
      else {
        els = (item.selectors && item.selectors.length ? item.selectors : [item.selector])
          .map(function (s) {
            try {
              return document.querySelector(s);
            } catch (e) {
              return null;
            }
          })
          .filter(Boolean);
        found.set(item.id, els);
      }
    }
    var rects = els.map(function (e) {
      return rectOf(e.getBoundingClientRect());
    }).filter(function (r) {
      return r.width || r.height;
    });
    return unionRect(rects);
  }

  function report() {
    scheduled = false;
    if (!tracked.length) return;
    var rects = {};
    tracked.forEach(function (item) {
      rects[item.id] = currentRect(item);
    });
    post("rects", { rects: rects, viewport: { width: innerWidth, height: innerHeight } });
  }

  function schedule() {
    if (scheduled || !tracked.length) return;
    scheduled = true;
    requestAnimationFrame(report);
  }

  window.addEventListener("scroll", schedule, { passive: true, capture: true });
  window.addEventListener("resize", schedule);
  setInterval(schedule, 700);

  // ---- Screenshots ----
  // What's in view, with the subject outlined, as a PNG data URL. Rendered by
  // html-to-image from the page's own DOM, so it's close to, not exactly,
  // what the browser paints (canvas, video and cross-origin frames come out
  // blank).

  function capture(req) {
    var lib = window.__perchHtmlToImage;
    if (!lib) return Promise.reject(new Error("screenshots aren't available on this page"));
    var subject = req.item ? currentRect(req.item) : null;
    var restore = null;
    if (subject && (subject.top + subject.height < 0 || subject.top > innerHeight) && req.scroll !== false) {
      restore = { x: scrollX, y: scrollY };
      var entry = req.item.pickId ? picks.get(req.item.pickId) : null;
      var el = entry && entry.elements && entry.elements[0];
      if (el && el.isConnected) el.scrollIntoView({ block: "center" });
      else window.scrollTo(scrollX, Math.max(0, subject.top + scrollY - innerHeight / 3));
      subject = currentRect(req.item);
    }
    var width = innerWidth;
    var height = innerHeight;
    var ratio = Math.min(2, window.devicePixelRatio || 1);
    var bg = getComputedStyle(document.body || document.documentElement).backgroundColor;
    if (!bg || bg === "rgba(0, 0, 0, 0)" || bg === "transparent") bg = getComputedStyle(document.documentElement).backgroundColor;
    if (!bg || bg === "rgba(0, 0, 0, 0)" || bg === "transparent") bg = "#ffffff";
    var sx = scrollX;
    var sy = scrollY;
    // Our own overlays stay out, and so does what a browser with scripts on
    // never shows (<noscript> fallbacks would render as raw text).
    function keep(node) {
      if (isOurs(node)) return false;
      var tag = node.tagName;
      if (tag === "NOSCRIPT" || tag === "SCRIPT" || tag === "TEMPLATE") return false;
      return !belowView(node);
    }

    // Content wholly below what's in view can be left out: nothing in view
    // moves (layout flows downward), and a long page then renders in a
    // fraction of the time, without fetching every image further down.
    // Anything positioned out of the flow stays, wherever it is.
    var limit = innerHeight + 200;
    function belowView(node) {
      if (node.nodeType !== 1 || node === document.documentElement || node === document.body) return false;
      var r = node.getBoundingClientRect();
      if (r.top <= limit) return false;
      var pos = getComputedStyle(node).position;
      return pos === "static" || pos === "relative";
    }
    var PLACEHOLDER = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

    function viewportShot(extra) {
      return lib.toCanvas(
        document.documentElement,
        Object.assign(
          {
            width: width,
            height: height,
            canvasWidth: width,
            canvasHeight: height,
            pixelRatio: ratio,
            backgroundColor: bg,
            cacheBust: false,
            imagePlaceholder: PLACEHOLDER,
            filter: keep,
            style: {
              transform: "translate(" + -sx + "px, " + -sy + "px)",
              transformOrigin: "0 0",
              width: document.documentElement.scrollWidth + "px",
              height: document.documentElement.scrollHeight + "px",
            },
          },
          extra || {},
        ),
      );
    }

    // The colour actually behind an element: the first ancestor that paints
    // a background (a dark page often paints it on a wrapper, not <body>).
    function backgroundBehind(el) {
      for (var node = el; node && node.nodeType === 1; node = node.parentElement) {
        var c = getComputedStyle(node).backgroundColor;
        if (c && c !== "transparent" && !/rgba\([^)]*,\s*0\)$/.test(c)) return c;
      }
      return bg;
    }

    // Just the subject, when the whole view won't render: an area's
    // container, else the element — or, when that's too small to see (a
    // screen-reader-only label), the nearest ancestor that isn't.
    function subjectShot() {
      var entry = req.item && req.item.pickId ? picks.get(req.item.pickId) : null;
      var el = entry && entry.container && entry.container.isConnected ? entry.container : null;
      if (!el) el = entry && entry.elements && entry.elements[0];
      if (!el || !el.isConnected) {
        try {
          el = req.item && document.querySelector((req.item.selectors && req.item.selectors[0]) || req.item.selector);
        } catch (e) {
          el = null;
        }
      }
      while (el && el.parentElement && el !== document.body) {
        var b = el.getBoundingClientRect();
        if (b.width >= 24 && b.height >= 16 && isSeen(el)) break;
        el = el.parentElement;
      }
      if (!el) return Promise.reject(new Error("the element isn't on the page"));
      return lib.toCanvas(el, {
        pixelRatio: ratio,
        backgroundColor: backgroundBehind(el),
        cacheBust: false,
        skipFonts: true,
        imagePlaceholder: PLACEHOLDER,
        filter: keep,
      });
    }

    function outline(canvas, whole) {
      if (whole && subject) {
        var ctx = canvas.getContext("2d");
        ctx.lineWidth = 3 * ratio;
        ctx.strokeStyle = "#ff2d6f";
        ctx.strokeRect(
          (subject.left - 2) * ratio,
          (subject.top - 2) * ratio,
          (subject.width + 4) * ratio,
          (subject.height + 4) * ratio,
        );
      }
      // The real thing here: a tainted result must fail, not turn grey.
      return nativeToDataURL.call(canvas, "image/png");
    }

    // Web fonts and other sites' images are what usually break an
    // in-page render; each fallback leaves more of them out.
    // html-to-image draws each <video> frame and <canvas> through
    // toDataURL. A hidden one comes back empty ("data:,") and another site's
    // video taints the canvas so it throws, and either aborts the whole
    // render. While capturing, those give a plain placeholder instead.
    var nativeToDataURL = HTMLCanvasElement.prototype.toDataURL;
    function placeholderFor(canvas) {
      var c = document.createElement("canvas");
      c.width = Math.max(1, canvas.width || 1);
      c.height = Math.max(1, canvas.height || 1);
      var ctx = c.getContext("2d");
      if (ctx) {
        ctx.fillStyle = "#2b2b2b";
        ctx.fillRect(0, 0, c.width, c.height);
      }
      return nativeToDataURL.call(c, "image/png");
    }
    function guardCanvases() {
      HTMLCanvasElement.prototype.toDataURL = function () {
        try {
          var url = nativeToDataURL.apply(this, arguments);
          return url === "data:," ? placeholderFor(this) : url;
        } catch (e) {
          return placeholderFor(this);
        }
      };
    }
    function unguardCanvases() {
      HTMLCanvasElement.prototype.toDataURL = nativeToDataURL;
    }

    var attempts = [
      function () {
        return viewportShot().then(function (c) {
          return outline(c, true);
        });
      },
      function () {
        return viewportShot({ skipFonts: true }).then(function (c) {
          return outline(c, true);
        });
      },
      function () {
        return subjectShot().then(function (c) {
          return outline(c, false);
        });
      },
    ];
    var firstError = null;
    var used = 0;
    function run(i) {
      if (i >= attempts.length) return Promise.reject(firstError);
      used = i;
      return withTimeout(attempts[i](), i === 0 ? 25000 : 12000).catch(function (err) {
        if (!firstError) firstError = err;
        return run(i + 1);
      });
    }
    guardCanvases();
    return run(0).then(
      function (dataUrl) {
        unguardCanvases();
        if (restore) window.scrollTo(restore.x, restore.y);
        // Say when a simpler render stood in, and why the full one failed.
        return {
          dataUrl: dataUrl,
          note: used === 0 ? "" : (used === 1 ? "without web fonts; " : "the element only; ") + "the full view failed: " + describeCaptureError(firstError),
        };
      },
      function (err) {
        unguardCanvases();
        if (restore) window.scrollTo(restore.x, restore.y);
        throw new Error(describeCaptureError(err));
      },
    );
  }

  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        reject(new Error("it took longer than " + ms / 1000 + "s"));
      }, ms);
      promise.then(
        function (v) {
          clearTimeout(timer);
          resolve(v);
        },
        function (e) {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }

  // html-to-image rejects with a bare load Event when an image or font won't
  // load; say which one.
  function describeCaptureError(err) {
    if (!err) return "the page couldn't be drawn";
    if (err.message) return err.message;
    if (typeof Event !== "undefined" && err instanceof Event) {
      var t = err.target;
      var src = t && (t.currentSrc || t.src || t.href);
      if (src && String(src).indexOf("data:image/svg+xml") === 0) {
        return "the page blocks drawing it as an image (its Content-Security-Policy, most likely)";
      }
      return "a resource it uses couldn't be loaded" + (src ? " (" + String(src).slice(0, 120) + ")" : "");
    }
    return String(err);
  }

  // Scrolls a comment's subject into the middle of the view.
  function reveal(item) {
    var entry = item.pickId ? picks.get(item.pickId) : null;
    var el = entry && entry.elements && entry.elements[0];
    if (!el || !el.isConnected) {
      var cached = found.get(item.id);
      el = cached && cached[0] && cached[0].isConnected ? cached[0] : null;
    }
    if (!el) {
      try {
        el = document.querySelector((item.selectors && item.selectors[0]) || item.selector);
      } catch (e) {
        el = null;
      }
    }
    if (el && !(entry && entry.area)) {
      el.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
    } else {
      var r = currentRect(item);
      if (r) window.scrollTo({ top: Math.max(0, r.top + scrollY - innerHeight / 3), behavior: "smooth" });
    }
    schedule();
  }

  // ---- Commands from the tab ----

  window.addEventListener("message", function (e) {
    if (e.source !== window.parent) return;
    var d = e.data && e.data.__pa;
    if (!d || !d.cmd) return;
    if (d.cmd === "pick") startPick(d.mode === "text" ? "text" : "element");
    else if (d.cmd === "cancel") disarm();
    else if (d.cmd === "reveal" && d.item) reveal(d.item);
    else if (d.cmd === "track") {
      tracked = Array.isArray(d.items) ? d.items : [];
      found.clear();
      schedule();
    } else if (d.cmd === "capture") {
      capture(d)
        .then(function (result) {
          post("captured", { reqId: d.reqId, dataUrl: result.dataUrl, note: result.note });
        })
        .catch(function (err) {
          post("captured", { reqId: d.reqId, error: String((err && err.message) || err || "capture failed") });
        });
    } else if (d.cmd === "errors") {
      post("errors", { list: (window.__pagePreviewErrors || []).slice() });
    }
  });

  if (window.MutationObserver) {
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, attributes: true });
  }

  window.__pageAgentAnnounce = function () {
    post("ready", { errors: (window.__pagePreviewErrors || []).slice() });
  };
  window.__pageAgentAnnounce();
})();
