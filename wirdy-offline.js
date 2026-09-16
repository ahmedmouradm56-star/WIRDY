/* ============================================================================
   Wirdy offline capture + native share bridge
   ----------------------------------------------------------------------------
   Injected into the page ahead of the app script. It does two things:

   1. Defines window.html2canvas(el, opts) -> Promise<HTMLCanvasElement> with a
      signature-compatible shim, backed by a purpose-built Canvas2D table
      renderer. No CDN, no network. Every existing call site keeps working.
      Text colour is contrast-corrected against its real background, so no cell
      can come out unreadable.

   2. Polyfills navigator.share / navigator.canShare and intercepts
      <a download> on blob: URLs, routing both to the Android bridge so the
      PICTURE leaves the app instead of a bare line of text.

   Written defensively: every failure path degrades to the app's own behaviour.
   ========================================================================== */
(function () {
  'use strict';

  /* ---------- colour helpers ---------------------------------------------- */

  function parseColor(s) {
    if (!s) return null;
    s = String(s).trim();
    if (s === 'transparent' || s === 'none') return { r: 0, g: 0, b: 0, a: 0 };
    var m = s.match(/^rgba?\(([^)]+)\)$/i);
    if (m) {
      var p = m[1].split(/[,\s/]+/).filter(Boolean).map(parseFloat);
      return { r: p[0] | 0, g: p[1] | 0, b: p[2] | 0, a: p.length > 3 ? p[3] : 1 };
    }
    m = s.match(/^#([0-9a-f]{3,8})$/i);
    if (m) {
      var h = m[1];
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      if (h.length === 6 || h.length === 8) {
        return {
          r: parseInt(h.slice(0, 2), 16),
          g: parseInt(h.slice(2, 4), 16),
          b: parseInt(h.slice(4, 6), 16),
          a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1
        };
      }
    }
    return null;
  }

  function css(c) {
    return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + c.a + ')';
  }

  /* flatten a translucent colour onto an opaque one */
  function over(fg, bg) {
    var a = fg.a;
    return {
      r: Math.round(fg.r * a + bg.r * (1 - a)),
      g: Math.round(fg.g * a + bg.g * (1 - a)),
      b: Math.round(fg.b * a + bg.b * (1 - a)),
      a: 1
    };
  }

  function luminance(c) {
    var ch = [c.r, c.g, c.b].map(function (v) {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  }

  function contrast(a, b) {
    var l1 = luminance(a), l2 = luminance(b);
    if (l1 < l2) { var t = l1; l1 = l2; l2 = t; }
    return (l1 + 0.05) / (l2 + 0.05);
  }

  var BLACK = { r: 17, g: 17, b: 17, a: 1 };
  var WHITE = { r: 255, g: 255, b: 255, a: 1 };

  /* The contrast guarantee: keep the designer's colour when it is legible,
     otherwise swap to whichever of near-black / white reads better. 4.5:1 is
     the WCAG AA threshold for body text. */
  function legible(fg, bg) {
    var solid = fg.a < 1 ? over(fg, bg) : fg;
    if (contrast(solid, bg) >= 4.5) return solid;
    return contrast(BLACK, bg) >= contrast(WHITE, bg) ? BLACK : WHITE;
  }

  /* ---------- geometry ----------------------------------------------------- */

  function effectiveBg(el, root) {
    var node = el;
    while (node && node !== root.parentNode) {
      var c = parseColor(getComputedStyle(node).backgroundColor);
      if (c && c.a > 0.95) return c;
      if (c && c.a > 0) return over(c, WHITE);
      node = node.parentElement;
    }
    return WHITE;
  }

  /* does this element hold text of its own (no element child carrying text)? */
  function isTextLeaf(el) {
    var own = false;
    for (var i = 0; i < el.childNodes.length; i++) {
      var n = el.childNodes[i];
      if (n.nodeType === 3 && n.nodeValue.trim()) own = true;
      if (n.nodeType === 1 && (n.textContent || '').trim()) return false;
    }
    return own;
  }

  function wrap(ctx, text, maxW, nowrap) {
    if (nowrap) return [text];
    var words = text.split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    var lines = [], line = words[0];
    for (var i = 1; i < words.length; i++) {
      var probe = line + ' ' + words[i];
      if (ctx.measureText(probe).width <= maxW) line = probe;
      else { lines.push(line); line = words[i]; }
    }
    lines.push(line);
    return lines;
  }

  /* ---------- vector / raster children ------------------------------------ */

  function svgToImage(svg) {
    return new Promise(function (resolve) {
      try {
        var clone = svg.cloneNode(true);
        var r = svg.getBoundingClientRect();
        clone.setAttribute('width', Math.max(1, Math.round(r.width)));
        clone.setAttribute('height', Math.max(1, Math.round(r.height)));
        if (!clone.getAttribute('xmlns')) {
          clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        }
        /* currentColor does not survive serialisation - bake it in */
        var stroke = getComputedStyle(svg).color;
        clone.querySelectorAll('*').forEach(function (n) {
          ['stroke', 'fill'].forEach(function (k) {
            if (n.getAttribute(k) === 'currentColor') n.setAttribute(k, stroke);
          });
        });
        if (clone.getAttribute('stroke') === 'currentColor') clone.setAttribute('stroke', stroke);
        var src = 'data:image/svg+xml;charset=utf-8,' +
          encodeURIComponent(new XMLSerializer().serializeToString(clone));
        var img = new Image();
        img.onload = function () { resolve(img); };
        img.onerror = function () { resolve(null); };
        img.src = src;
      } catch (e) { resolve(null); }
    });
  }

  /* ---------- the renderer ------------------------------------------------- */

  async function renderElement(root, opts) {
    opts = opts || {};
    var scale = opts.scale || 2;
    var rect = root.getBoundingClientRect();
    var W = Math.max(1, Math.ceil(rect.width));
    var H = Math.max(1, Math.ceil(rect.height));

    var canvas = document.createElement('canvas');
    canvas.width = Math.round(W * scale);
    canvas.height = Math.round(H * scale);
    var ctx = canvas.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, 0, 0);

    ctx.fillStyle = opts.backgroundColor || '#ffffff';
    ctx.fillRect(0, 0, W, H);

    var all = [root].concat(Array.prototype.slice.call(root.querySelectorAll('*')));

    /* pass 1 - boxes and borders, in document order so later siblings paint over */
    all.forEach(function (el) {
      var cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return;
      var r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      var x = r.left - rect.left, y = r.top - rect.top;

      var bg = parseColor(cs.backgroundColor);
      if (bg && bg.a > 0) {
        ctx.fillStyle = css(bg);
        var rad = parseFloat(cs.borderTopLeftRadius) || 0;
        if (rad > 0 && ctx.roundRect) {
          ctx.beginPath();
          ctx.roundRect(x, y, r.width, r.height, Math.min(rad, r.width / 2, r.height / 2));
          ctx.fill();
        } else {
          ctx.fillRect(x, y, r.width, r.height);
        }
      }

      [['Top', 0, 0, r.width, 1], ['Bottom', 0, 1, r.width, 1],
       ['Left', 0, 0, 1, r.height], ['Right', 1, 0, 1, r.height]
      ].forEach(function (side) {
        var w = parseFloat(cs['border' + side[0] + 'Width']) || 0;
        if (w <= 0) return;
        var col = parseColor(cs['border' + side[0] + 'Color']);
        if (!col || col.a === 0) return;
        if (cs['border' + side[0] + 'Style'] === 'none') return;
        ctx.fillStyle = css(col);
        var bx = x + (side[1] ? r.width - w : 0);
        var by = y + (side[2] ? r.height - w : 0);
        var bw = side[3] === r.width ? r.width : w;
        var bh = side[4] === r.height ? r.height : w;
        ctx.fillRect(bx, by, bw, bh);
      });
    });

    /* pass 2 - images and inline SVG */
    var svgs = Array.prototype.slice.call(root.querySelectorAll('svg'));
    for (var i = 0; i < svgs.length; i++) {
      var s = svgs[i];
      var sr = s.getBoundingClientRect();
      if (!sr.width || !sr.height) continue;
      var img = await svgToImage(s);
      if (img) {
        try { ctx.drawImage(img, sr.left - rect.left, sr.top - rect.top, sr.width, sr.height); }
        catch (e) { /* an un-drawable icon must never sink the whole capture */ }
      }
    }
    Array.prototype.slice.call(root.querySelectorAll('img')).forEach(function (im) {
      var ir = im.getBoundingClientRect();
      if (!ir.width || !im.complete) return;
      try { ctx.drawImage(im, ir.left - rect.left, ir.top - rect.top, ir.width, ir.height); }
      catch (e) {}
    });

    /* pass 3 - text, contrast-corrected */
    ctx.textBaseline = 'middle';
    all.forEach(function (el) {
      var cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      if (!isTextLeaf(el)) return;
      var text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) return;

      var r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;

      var padL = parseFloat(cs.paddingLeft) || 0;
      var padR = parseFloat(cs.paddingRight) || 0;
      var padT = parseFloat(cs.paddingTop) || 0;
      var padB = parseFloat(cs.paddingBottom) || 0;

      var x = r.left - rect.left + padL;
      var y = r.top - rect.top + padT;
      var w = Math.max(1, r.width - padL - padR);
      var h = Math.max(1, r.height - padT - padB);

      var size = parseFloat(cs.fontSize) || 14;
      var lh = parseFloat(cs.lineHeight);
      if (!lh || isNaN(lh)) lh = size * 1.25;

      ctx.font = (cs.fontStyle === 'italic' ? 'italic ' : '') +
                 (cs.fontWeight || '400') + ' ' + size + 'px ' + cs.fontFamily;
      ctx.direction = cs.direction || 'ltr';

      var bg = effectiveBg(el, root);
      var fg = parseColor(cs.color) || BLACK;
      ctx.fillStyle = css(legible(fg, bg));

      var lines = wrap(ctx, text, w, cs.whiteSpace === 'nowrap' || cs.whiteSpace === 'pre');

      /* shrink-to-fit rather than clip: a cell that overflows is exactly how
         text ends up unreadable in the shared picture */
      var guard = 0;
      while (lines.length * lh > h && size > 7 && guard++ < 14) {
        size = Math.max(7, size - 0.5);
        lh = size * 1.25;
        ctx.font = (cs.fontStyle === 'italic' ? 'italic ' : '') +
                   (cs.fontWeight || '400') + ' ' + size + 'px ' + cs.fontFamily;
        lines = wrap(ctx, text, w, cs.whiteSpace === 'nowrap' || cs.whiteSpace === 'pre');
      }

      var align = cs.textAlign;
      var rtl = (cs.direction === 'rtl');
      if (align === 'start') align = rtl ? 'right' : 'left';
      if (align === 'end') align = rtl ? 'left' : 'right';
      if (align !== 'center' && align !== 'right' && align !== 'left') align = rtl ? 'right' : 'left';

      var total = lines.length * lh;
      var cy = y + (h - total) / 2 + lh / 2;

      ctx.textAlign = align;
      var tx = align === 'center' ? x + w / 2 : (align === 'right' ? x + w : x);

      lines.forEach(function (ln, idx) {
        ctx.fillText(ln, tx, cy + idx * lh, w);
      });
    });

    return canvas;
  }

  /* Only take over if the real library never arrived (offline / blocked CDN). */
  if (typeof window.html2canvas !== 'function') {
    window.html2canvas = function (el, opts) { return renderElement(el, opts); };
  }
  window.__wirdyRender = renderElement;

  /* ======================================================================== */
  /*  Native bridge                                                            */
  /* ======================================================================== */

  var B = window.WirdyBridge;
  function hasBridge() {
    return !!(B && typeof B.startImage === 'function' && typeof B.shareImage === 'function');
  }
  if (!hasBridge()) return;   /* plain browser: leave the page exactly as it is */

  function b64(u8) {
    var out = '', CH = 0x8000;
    for (var i = 0; i < u8.length; i += CH) {
      out += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    }
    return btoa(out);
  }

  /* 393216 is divisible by 3, so every base64 slice is self-contained */
  var CHUNK = 393216;

  async function pushBlob(blob) {
    var bytes = new Uint8Array(await blob.arrayBuffer());
    B.startImage();
    for (var i = 0; i < bytes.length; i += CHUNK) {
      B.addChunk(b64(bytes.subarray(i, Math.min(i + CHUNK, bytes.length))));
      await new Promise(function (r) { setTimeout(r, 0); });   /* keep the UI alive */
    }
    return bytes.length;
  }

  navigator.canShare = function (d) { return !!(d && d.files && d.files.length); };

  navigator.share = async function (d) {
    if (d && d.files && d.files.length) {
      var f = d.files[0];
      await pushBlob(f);
      var ok = B.shareImage(f.name || 'timetable.png', d.text || '', '');
      if (!ok) throw new Error('share-failed');
      return;
    }
    if (d && d.text && typeof B.shareText === 'function') { B.shareText(d.text); return; }
    throw new Error('nothing-to-share');
  };

  /* <a download href="blob:..."> is silently dropped by WebView - catch it in
     the capture phase, before the app removes the anchor, and save natively. */
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[download]') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (!/^(blob:|data:)/.test(href)) return;
    var name = a.getAttribute('download') || 'timetable.png';
    e.preventDefault();
    e.stopPropagation();
    fetch(href)
      .then(function (r) { return r.blob(); })
      .then(function (blob) { return pushBlob(blob); })
      .then(function () { B.saveImage(name); })
      .catch(function () {});
  }, true);
})();
