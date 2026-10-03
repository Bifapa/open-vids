/**
 * The in-page half of the website style reader: one expression evaluated in the rendered page that samples the live
 * DOM's computed styles (colors by role, fonts in use, type scale, radii, shadows, buttons, logos, headings, motion
 * actually applied). What the CSS files declare (font files, design tokens, keyframes) is read in Node from the
 * captured style sheets instead (`cssAnalysis.ts`): a cross-origin sheet is invisible to `cssRules`.
 *
 * A string expression, not a function: `page.evaluate(fn)` serializes TypeScript output, and a transpiler's `__name`
 * helper does not exist in the page (esbuild issue #1031).
 */

import type { WebsiteResourceKind } from "@hyperframes/agent-protocol";

export interface RawColor {
  hex: string;
  role: "background" | "surface" | "text" | "muted" | "accent" | "border";
  count: number;
}

export interface RawFontUse {
  family: string;
  weight: number;
  italic: boolean;
  count: number;
  heading: number;
  code: number;
}

export interface RawTextStyle {
  element: "h1" | "h2" | "h3" | "body" | "small";
  sample: string;
  fontFamily: string;
  fontSizePx: number;
  fontWeight: number;
  lineHeightPx: number | null;
  letterSpacingPx: number;
  color: string | null;
}

export interface RawButton {
  label: string;
  background: string | null;
  color: string | null;
  border: string | null;
  radiusPx: number;
  fontSizePx: number;
  fontWeight: number;
  padding: string;
  shadow: string | null;
}

export interface RawLogo {
  source: "inline_svg" | "image" | "og_image" | "icon";
  /** Absolute URL of the image; empty for an inline SVG. */
  url: string;
  alt: string;
  width: number | null;
  height: number | null;
  /** Self-contained markup of an inline SVG. */
  svg?: string;
}

export interface RawMotion {
  durationsMs: number[];
  easings: string[];
  properties: string[];
  animationNames: string[];
}

export interface RawPage {
  title: string;
  description: string;
  themeColor: string | null;
  language: string | null;
  finalUrl: string;
  pageBackground: string;
  colors: RawColor[];
  fonts: RawFontUse[];
  textStyles: RawTextStyle[];
  radii: Array<{ px: number; count: number }>;
  shadows: string[];
  buttons: RawButton[];
  logos: RawLogo[];
  /** Icon links (`rel=icon` and friends): url and the larger side of `sizes`. */
  icons: Array<{ url: string; size: number; svg: boolean }>;
  ogImage: string | null;
  headings: string[];
  navLabels: string[];
  motion: RawMotion;
  googleFamilies: string[];
  /** The text of `<style>` elements and adopted style sheets. */
  inlineCss: string[];
  /** Hrefs of the page's `<link rel=stylesheet>` elements. */
  stylesheetUrls: string[];
  visibleElements: number;
  textLength: number;
  documentHeight: number;
}

export const PAGE_SCRIPT = String.raw`(() => {
  var VW = window.innerWidth, VH = window.innerHeight;
  var MAX_ELEMENTS = 3500;

  // ── Colors: any CSS color (rgb, oklch, color-mix…) → sRGB through a 1×1 canvas ──
  var canvas = document.createElement("canvas");
  canvas.width = 1; canvas.height = 1;
  var cx = canvas.getContext("2d", { willReadFrequently: true });
  var colorCache = new Map();
  function parseColor(str) {
    if (!str || str === "transparent") return null;
    if (colorCache.has(str)) return colorCache.get(str);
    var result = null;
    try {
      cx.globalCompositeOperation = "copy";
      cx.fillStyle = "#010203";
      cx.fillStyle = str;
      if (cx.fillStyle !== "#010203" || str.replace(/\s/g, "") === "rgb(1,2,3)") {
        cx.fillRect(0, 0, 1, 1);
        var d = cx.getImageData(0, 0, 1, 1).data;
        result = { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
      }
    } catch (e) { result = null; }
    colorCache.set(str, result);
    return result;
  }
  function toHex(c) {
    function h(v) { return Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0"); }
    return "#" + h(c.r) + h(c.g) + h(c.b);
  }
  function over(c, base) {
    return { r: c.a * c.r + (1 - c.a) * base.r, g: c.a * c.g + (1 - c.a) * base.g, b: c.a * c.b + (1 - c.a) * base.b, a: 1 };
  }
  function spread(c) { return Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b); }
  function lightness(c) { return (Math.max(c.r, c.g, c.b) + Math.min(c.r, c.g, c.b)) / 510; }
  function saturated(c) {
    var l = lightness(c);
    return spread(c) >= 48 && l > 0.08 && l < 0.96;
  }
  function luminance(c) {
    function ch(v) { v = v / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
    return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
  }
  function contrast(a, b) {
    var la = luminance(a), lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  // ── Page background: what a visitor sees behind the hero ──
  function opaqueBg(el) {
    var c = parseColor(getComputedStyle(el).backgroundColor);
    return c && c.a >= 0.9 ? c : null;
  }
  var base = null;
  var stack = document.elementsFromPoint(Math.floor(VW / 2), Math.floor(VH / 2));
  for (var i = 0; i < stack.length && !base; i++) {
    var sr = stack[i].getBoundingClientRect();
    if (sr.width >= VW * 0.9) base = opaqueBg(stack[i]);
  }
  base = base || opaqueBg(document.body) || opaqueBg(document.documentElement) || { r: 255, g: 255, b: 255, a: 1 };
  var baseHex = toHex(base);

  // ── Sampling ──
  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, LINK: 1, META: 1, HEAD: 1, BR: 1, WBR: 1 };
  var roleMaps = { background: {}, surface: {}, accent: {}, border: {} };
  var textColors = {};
  var fontMap = {};
  var radii = {}, shadows = {};
  var typeRows = [];
  var buttonRows = [];
  var motionDur = {}, motionEase = {}, motionProp = {}, motionAnim = {};
  var visible = 0;

  function addRole(role, hex, weight) {
    var map = roleMaps[role];
    var row = map[hex] || (map[hex] = { count: 0, weight: 0 });
    row.count++; row.weight += weight;
  }
  function px(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }
  function firstFamily(v) {
    var m = /^\s*(?:"([^"]+)"|'([^']+)'|([^,]+))/.exec(v || "");
    return m ? (m[1] || m[2] || m[3] || "").trim() : "";
  }
  function timeMs(v) {
    var n = parseFloat(v);
    if (!isFinite(n)) return 0;
    return /ms\s*$/.test(v) ? n : n * 1000;
  }
  function bump(map, key, by) { map[key] = (map[key] || 0) + (by || 1); }
  function clip(text, n) { return text.replace(/\s+/g, " ").trim().slice(0, n); }
  function ownText(el) {
    var t = "";
    for (var n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3) t += n.nodeValue;
    return t.trim();
  }
  function isRealVisible(el, s, r) {
    return r.width > 1 && r.height > 1 && s.display !== "none" && s.visibility !== "hidden" &&
      parseFloat(s.opacity) > 0.05 && r.right > 0 && r.left < VW;
  }

  function pushType(tag, s, family, weight, text) {
    typeRows.push({
      tag: tag, size: px(s.fontSize), weight: weight, family: family, text: text,
      lineHeight: s.lineHeight, letterSpacing: s.letterSpacing, color: s.color
    });
  }

  var all = document.body.getElementsByTagName("*");
  var limit = Math.min(all.length, MAX_ELEMENTS);
  for (var k = 0; k < limit; k++) {
    var el = all[k];
    if (SKIP[el.tagName]) continue;
    if (el.tagName !== "svg" && el.closest("svg")) continue;
    var s = getComputedStyle(el);
    var r = el.getBoundingClientRect();
    if (!isRealVisible(el, s, r)) continue;
    visible++;
    var area = Math.min(r.width, VW) * Math.min(r.height, 3000);
    var tag = el.tagName.toLowerCase();
    var interactive = tag === "button" || tag === "a" || el.getAttribute("role") === "button" ||
      (tag === "input" && /^(submit|button)$/.test(el.type));

    var bg = parseColor(s.backgroundColor);
    if (bg && bg.a >= 0.2) {
      var bgHex = toHex(bg.a < 0.99 ? over(bg, base) : bg);
      if (bgHex !== baseHex) {
        var bgc = parseColor(bgHex);
        if (area >= VW * VH * 0.4) addRole("background", bgHex, area);
        else if (interactive && saturated(bgc)) addRole("accent", bgHex, area + 4000);
        else if (area >= 8000) addRole("surface", bgHex, area);
        else if (saturated(bgc) && area >= 120) addRole("accent", bgHex, area);
      }
    }

    var bw = ["Top", "Right", "Bottom", "Left"];
    for (var b = 0; b < bw.length; b++) {
      if (px(s["border" + bw[b] + "Width"]) > 0 && s["border" + bw[b] + "Style"] !== "none" && s["border" + bw[b] + "Style"] !== "hidden") {
        var bc = parseColor(s["border" + bw[b] + "Color"]);
        if (bc && bc.a >= 0.08) { addRole("border", toHex(over(bc, base)), 1); break; }
      }
    }

    var rad = s.borderTopLeftRadius;
    if (area >= 200 && rad) {
      var rv = /%\s*$/.test(rad) ? (px(rad) >= 40 ? 9999 : 0) : px(rad);
      if (rv > 0) bump(radii, String(rv >= 500 ? 9999 : Math.round(rv * 2) / 2));
    }
    if (s.boxShadow && s.boxShadow !== "none") bump(shadows, s.boxShadow.replace(/\s+/g, " ").slice(0, 200));

    var text = ownText(el);
    if (text.length > 0) {
      var fam = firstFamily(s.fontFamily);
      var weight = parseInt(s.fontWeight, 10) || 400;
      var italic = s.fontStyle === "italic";
      var isHeading = /^h[1-6]$/.test(tag) || el.getAttribute("role") === "heading";
      var isCode = /^(code|pre|kbd|samp)$/.test(tag) || /monospace/.test(s.fontFamily);
      var key = fam + "|" + weight + "|" + italic;
      var row = fontMap[key] || (fontMap[key] = { family: fam, weight: weight, italic: italic, count: 0, heading: 0, code: 0 });
      row.count++;
      if (isHeading) row.heading++;
      if (isCode) row.code++;

      var tc = parseColor(s.color);
      if (tc && tc.a >= 0.1) {
        var tcHex = toHex(over(tc, base));
        var trow = textColors[tcHex] || (textColors[tcHex] = { weight: 0, accent: 0 });
        trow.weight += Math.min(text.length, 200);
        if (interactive || weight >= 600) trow.accent += Math.min(text.length, 200);
      }
      pushType(tag, s, fam, weight, text);
    } else if (/^h[1-3]$/.test(tag)) {
      // A heading whose words sit in nested spans owns no text node itself.
      var headingText = clip(el.innerText || "", 200);
      if (headingText) pushType(tag, s, firstFamily(s.fontFamily), parseInt(s.fontWeight, 10) || 400, headingText);
    }

    if (px(s.transitionDuration) > 0 || /ms/.test(s.transitionDuration)) {
      var durs = s.transitionDuration.split(",");
      var eases = s.transitionTimingFunction.split(/,(?![^(]*\))/);
      var props = s.transitionProperty.split(",");
      for (var d = 0; d < durs.length; d++) {
        var ms = timeMs(durs[d]);
        if (ms <= 0) continue;
        bump(motionDur, String(Math.round(ms)));
        bump(motionEase, (eases[d % eases.length] || "ease").trim());
        var prop = (props[d % props.length] || "").trim();
        if (prop && prop !== "all") bump(motionProp, prop);
      }
    }
    if (s.animationName && s.animationName !== "none") {
      var names = s.animationName.split(",");
      var adur = s.animationDuration.split(",");
      var aease = s.animationTimingFunction.split(/,(?![^(]*\))/);
      for (var a = 0; a < names.length; a++) {
        bump(motionAnim, names[a].trim());
        var am = timeMs(adur[a % adur.length]);
        if (am > 0) bump(motionDur, String(Math.round(am)));
        bump(motionEase, (aease[a % aease.length] || "ease").trim());
      }
    }

    if (interactive && (tag === "button" || tag === "a" || el.getAttribute("role") === "button" || tag === "input")) {
      var label = tag === "input" ? (el.value || "") : clip(el.textContent || "", 40);
      var cls = (el.getAttribute("class") || "") + " " + (el.id || "");
      var bgHex2 = bg && bg.a >= 0.2 ? toHex(bg.a < 0.99 ? over(bg, base) : bg) : null;
      var bordW = px(s.borderTopWidth);
      var looksButton = bgHex2 && bgHex2 !== baseHex ||
        (bordW > 0 && px(s.borderTopLeftRadius) > 0) || /btn|button|cta/i.test(cls);
      if (label && label.length <= 30 && looksButton && r.height >= 24 && r.height <= 90 && r.width >= 40 && r.width <= 420) {
        var bcol = parseColor(s.borderTopColor);
        var colorC = parseColor(s.color);
        buttonRows.push({
          label: label,
          background: bgHex2,
          color: colorC ? toHex(over(colorC, base)) : null,
          border: bordW > 0 && s.borderTopStyle !== "none" && bcol ? Math.round(bordW * 10) / 10 + "px solid " + toHex(over(bcol, base)) : null,
          radiusPx: Math.min(px(s.borderTopLeftRadius), 9999),
          fontSizePx: px(s.fontSize),
          fontWeight: parseInt(s.fontWeight, 10) || 400,
          padding: s.padding,
          shadow: s.boxShadow && s.boxShadow !== "none" ? s.boxShadow.replace(/\s+/g, " ").slice(0, 200) : null,
          score: (bgHex2 && saturated(parseColor(bgHex2)) ? 3 : bgHex2 ? 1 : 0) + Math.min(r.width * r.height / 6000, 2) + (r.top < VH ? 1 : 0)
        });
      }
    }
  }

  // ── Colors by role ──
  var textHexes = Object.keys(textColors).sort(function (x, y) { return textColors[y].weight - textColors[x].weight; });
  // The text colour is the strongest neutral one that carries a real share of the text; body copy is often a
  // softer grey than the headings, so the most frequent colour alone would be the muted one.
  var mainText = null;
  var topWeight = textHexes.length ? textColors[textHexes[0]].weight : 0;
  for (var t = 0; t < textHexes.length; t++) {
    var tcol = parseColor(textHexes[t]);
    if (textColors[textHexes[t]].weight < topWeight * 0.15 || saturated(tcol) || contrast(tcol, base) < 3) continue;
    if (!mainText || contrast(tcol, base) > contrast(mainText, base)) mainText = tcol;
  }
  var textRoles = { text: {}, muted: {} };
  for (var t2 = 0; t2 < textHexes.length; t2++) {
    var hx = textHexes[t2], tr = textColors[hx], cc = parseColor(hx);
    if (contrast(cc, base) < 1.6) continue; // text on a filled button or badge, not on the page
    if (saturated(cc) && contrast(cc, base) >= 2) addRole("accent", hx, tr.accent * 60 + tr.weight * 8);
    else if (mainText && contrast(cc, base) < contrast(mainText, base) * 0.8 && contrast(cc, base) >= 1.6) textRoles.muted[hx] = tr;
    else textRoles.text[hx] = tr;
  }
  function near(x, y) {
    var a = parseColor(x), b = parseColor(y);
    return Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) <= 9;
  }
  function pick(map, n, role, out) {
    var taken = 0;
    Object.keys(map).sort(function (x, y) {
      return (map[y].weight || 0) - (map[x].weight || 0);
    }).forEach(function (hex) {
      if (taken >= n) return;
      if (out.some(function (o) { return o.role === role && near(o.hex, hex); })) return;
      taken++;
      out.push({ hex: hex, role: role, count: map[hex].count || 1 });
    });
  }
  var colors = [{ hex: baseHex, role: "background", count: 1 }];
  var bgRows = roleMaps.background; delete bgRows[baseHex];
  pick(bgRows, 2, "background", colors);
  pick(textRoles.text, 3, "text", colors);
  pick(textRoles.muted, 2, "muted", colors);
  pick(roleMaps.surface, 4, "surface", colors);
  pick(roleMaps.accent, 5, "accent", colors);
  pick(roleMaps.border, 3, "border", colors);

  // ── Type scale ──
  function rowStyle(row, element) {
    var c = parseColor(row.color);
    var lh = /px\s*$/.test(row.lineHeight) ? px(row.lineHeight) : null;
    return {
      element: element, sample: clip(row.text, 60), fontFamily: row.family, fontSizePx: row.size, fontWeight: row.weight,
      lineHeightPx: lh, letterSpacingPx: /px\s*$/.test(row.letterSpacing) ? px(row.letterSpacing) : 0,
      color: c ? toHex(over(c, base)) : null
    };
  }
  var textStyles = [];
  ["h1", "h2", "h3"].forEach(function (name) {
    var best = null;
    typeRows.forEach(function (row) { if (row.tag === name && (!best || row.size > best.size)) best = row; });
    if (best) textStyles.push(rowStyle(best, name));
  });
  var bodyGroups = {};
  typeRows.forEach(function (row) {
    if ((row.tag === "p" || row.tag === "li" || row.tag === "span" || row.tag === "div") && row.text.length >= 25) {
      var g = row.size + "|" + row.weight + "|" + row.family;
      (bodyGroups[g] = bodyGroups[g] || { rows: [], n: 0 }).n += row.text.length;
      bodyGroups[g].rows.push(row);
    }
  });
  var bodyKey = Object.keys(bodyGroups).sort(function (x, y) { return bodyGroups[y].n - bodyGroups[x].n; })[0];
  var bodyRow = bodyKey ? bodyGroups[bodyKey].rows[0] : null;
  if (bodyRow) {
    textStyles.push(rowStyle(bodyRow, "body"));
    var smallGroups = {};
    typeRows.forEach(function (row) {
      if (row.size > 0 && row.size < bodyRow.size - 0.5 && row.size >= 9 && row.text.length >= 6) {
        var g2 = row.size + "|" + row.weight + "|" + row.family;
        (smallGroups[g2] = smallGroups[g2] || { rows: [], n: 0 }).n += row.text.length;
        smallGroups[g2].rows.push(row);
      }
    });
    var smallKey = Object.keys(smallGroups).sort(function (x, y) { return smallGroups[y].n - smallGroups[x].n; })[0];
    if (smallKey) textStyles.push(rowStyle(smallGroups[smallKey].rows[0], "small"));
  }

  // ── Buttons ──
  buttonRows.sort(function (x, y) { return y.score - x.score; });
  var seenButtons = {}, buttons = [];
  buttonRows.forEach(function (row) {
    var sig = row.background + "|" + row.color + "|" + row.radiusPx + "|" + row.border;
    if (seenButtons[sig] || buttons.length >= 6) return;
    seenButtons[sig] = 1;
    delete row.score;
    buttons.push(row);
  });

  // ── Logos ──
  function homeLink(a) {
    try {
      var u = new URL(a.href, location.href);
      return u.origin === location.origin && (u.pathname === "/" || u.pathname === "" || /^\/[a-z]{2}(-[a-z]{2})?\/?$/i.test(u.pathname));
    } catch (e) { return false; }
  }
  function svgMarkup(svg, rect) {
    var clone = svg.cloneNode(true);
    var cs = getComputedStyle(svg);
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    if (!clone.getAttribute("viewBox")) clone.setAttribute("viewBox", "0 0 " + Math.round(rect.width) + " " + Math.round(rect.height));
    if (!clone.getAttribute("width")) clone.setAttribute("width", String(Math.round(rect.width)));
    if (!clone.getAttribute("height")) clone.setAttribute("height", String(Math.round(rect.height)));
    var col = parseColor(cs.color);
    if (col) clone.setAttribute("color", toHex(col));
    if (!clone.getAttribute("fill") && cs.fill && cs.fill !== "none" && cs.fill !== "rgb(0, 0, 0)") {
      var fc = parseColor(cs.fill);
      if (fc) clone.setAttribute("fill", toHex(fc));
    }
    // A colour that points at the page's CSS variable means nothing in a standalone file: write the colour itself.
    var sourceNodes = [svg].concat(Array.prototype.slice.call(svg.querySelectorAll("*")));
    var cloneNodes = [clone].concat(Array.prototype.slice.call(clone.querySelectorAll("*")));
    for (var n = 0; n < cloneNodes.length && n < sourceNodes.length; n++) {
      ["fill", "stroke", "stop-color", "color"].forEach(function (attr) {
        var value = cloneNodes[n].getAttribute(attr);
        if (!value || value.indexOf("var(") < 0) return;
        var computed = getComputedStyle(sourceNodes[n]).getPropertyValue(attr);
        var parsed = parseColor(computed);
        if (parsed) cloneNodes[n].setAttribute(attr, toHex(parsed));
        else cloneNodes[n].removeAttribute(attr);
      });
    }
    var uses = clone.querySelectorAll("use");
    var defs = "";
    var seenIds = {};
    for (var u = 0; u < uses.length; u++) {
      var href = uses[u].getAttribute("href") || uses[u].getAttribute("xlink:href") || "";
      if (href.charAt(0) !== "#" || seenIds[href] || clone.querySelector(href.replace(/([^\w#-])/g, "\\$1"))) continue;
      seenIds[href] = 1;
      var target = document.getElementById(href.slice(1));
      if (target) defs += target.outerHTML;
    }
    if (defs) {
      var holder = document.createElementNS("http://www.w3.org/2000/svg", "defs");
      holder.innerHTML = defs;
      clone.insertBefore(holder, clone.firstChild);
    }
    var markup = clone.outerHTML;
    return markup.length <= 60000 ? markup : null;
  }
  var logoRows = [];
  var graphics = document.querySelectorAll("img, svg");
  for (var g = 0; g < graphics.length && g < 600; g++) {
    var node = graphics[g];
    if (node.tagName.toLowerCase() === "svg" && node.parentElement && node.parentElement.closest("svg")) continue;
    var gr = node.getBoundingClientRect();
    var gs = getComputedStyle(node);
    var docTop = gr.top + window.scrollY;
    var inHeader = !!node.closest("header, nav, [role=banner]");
    if (!isRealVisible(node, gs, gr) || gr.width < 16 || gr.width > 420 || gr.height < 12 || gr.height > 200) continue;
    if (docTop > 260 && !inHeader) continue;
    var anchor = node.closest("a");
    var hint = ((node.getAttribute("class") || "") + " " + (node.id || "") + " " + (node.getAttribute("alt") || "") + " " +
      (node.getAttribute("aria-label") || "") + " " + (node.getAttribute("src") || "") + " " + (anchor ? (anchor.getAttribute("class") || "") + (anchor.getAttribute("aria-label") || "") : "")).toLowerCase();
    var score = (/logo|brand|wordmark/.test(hint) ? 4 : 0) + (anchor && homeLink(anchor) ? 3 : 0) + (inHeader ? 2 : 0) +
      (gr.left < VW * 0.5 ? 1 : 0) + (gr.top < 120 ? 1 : 0);
    if (score < 4) continue;
    if (node.tagName.toLowerCase() === "svg") {
      var markup = svgMarkup(node, gr);
      if (markup) logoRows.push({ score: score, left: gr.left, logo: { source: "inline_svg", url: "", alt: node.getAttribute("aria-label") || (node.querySelector("title") ? node.querySelector("title").textContent : "") || "", width: Math.round(gr.width), height: Math.round(gr.height), svg: markup } });
    } else {
      var src = node.currentSrc || node.src || "";
      if (/^https?:/i.test(src)) logoRows.push({ score: score, left: gr.left, logo: { source: "image", url: src, alt: node.getAttribute("alt") || "", width: node.naturalWidth || Math.round(gr.width), height: node.naturalHeight || Math.round(gr.height) } });
    }
  }
  logoRows.sort(function (x, y) { return y.score - x.score || x.left - y.left; });
  var logos = logoRows.slice(0, 3).map(function (row) { return row.logo; });

  var meta = function (sel) { var m = document.querySelector(sel); return m ? (m.getAttribute("content") || "").trim() : ""; };
  var ogImage = meta('meta[property="og:image"], meta[name="og:image"], meta[name="twitter:image"]');
  var icons = [];
  document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="apple-touch-icon-precomposed"], link[rel="mask-icon"]').forEach(function (link) {
    try {
      var iu = new URL(link.getAttribute("href") || "", location.href);
      if (!/^https?:$/.test(iu.protocol)) return;
      var sizes = (link.getAttribute("sizes") || "").split(/\s+/).map(function (v) { return parseInt(v, 10) || 0; });
      var isSvg = /svg/i.test(link.getAttribute("type") || "") || /\.svg(\?|$)/i.test(iu.pathname);
      icons.push({ url: iu.href, size: Math.max.apply(null, sizes.concat([0])) || (/apple-touch/.test(link.rel) ? 180 : 32), svg: isSvg });
    } catch (e) { /* unusable href */ }
  });

  // ── Text, links, google fonts, style sheets ──
  var seenText = {};
  function textsOf(selector, max, maxLen) {
    var out = [];
    document.querySelectorAll(selector).forEach(function (n) {
      if (out.length >= max) return;
      var ns = getComputedStyle(n), nr = n.getBoundingClientRect();
      if (!isRealVisible(n, ns, nr)) return;
      var tx = clip(n.innerText || n.textContent || "", maxLen);
      if (tx.length >= 2 && out.indexOf(tx) < 0) out.push(tx);
    });
    return out;
  }
  var headings = textsOf("h1", 4, 160).concat(textsOf("h2", 8, 160)).slice(0, 12);
  var navLabels = textsOf("nav a, header a, [role=navigation] a", 12, 40);

  var googleFamilies = [];
  var stylesheetUrls = [];
  document.querySelectorAll('link[rel~="stylesheet"]').forEach(function (link) {
    var href = link.href || "";
    if (!/^https?:/i.test(href)) return;
    stylesheetUrls.push(href);
    try {
      var lu = new URL(href);
      if (/(^|\.)fonts\.googleapis\.com$/.test(lu.hostname)) {
        lu.searchParams.getAll("family").forEach(function (fam) {
          fam.split("|").forEach(function (one) {
            var nm = one.split(":")[0].replace(/\+/g, " ").trim();
            if (nm && googleFamilies.indexOf(nm) < 0) googleFamilies.push(nm);
          });
        });
      }
    } catch (e) { /* not a URL */ }
  });
  var inlineCss = [];
  document.querySelectorAll("style").forEach(function (st) { if (st.textContent) inlineCss.push(st.textContent.slice(0, 400000)); });
  try {
    (document.adoptedStyleSheets || []).forEach(function (sheet) {
      try { inlineCss.push(Array.prototype.map.call(sheet.cssRules, function (rule) { return rule.cssText; }).join("\n").slice(0, 400000)); } catch (e) { /* blocked */ }
    });
  } catch (e) { /* unsupported */ }

  var radiusRows = Object.keys(radii).map(function (key) { return { px: Number(key), count: radii[key] }; })
    .sort(function (x, y) { return y.count - x.count; }).slice(0, 6);
  var shadowRows = Object.keys(shadows).sort(function (x, y) { return shadows[y] - shadows[x]; }).slice(0, 4);
  function top(map, n) { return Object.keys(map).sort(function (x, y) { return map[y] - map[x]; }).slice(0, n); }
  var themeColorRaw = meta('meta[name="theme-color"]');
  var themeParsed = parseColor(themeColorRaw);

  return {
    title: clip(document.title || "", 300),
    description: clip(meta('meta[name="description"]') || meta('meta[property="og:description"]'), 300),
    themeColor: themeParsed && themeParsed.a >= 0.9 ? toHex(themeParsed) : null,
    language: document.documentElement.lang || null,
    finalUrl: location.href,
    pageBackground: baseHex,
    colors: colors,
    fonts: Object.keys(fontMap).map(function (key) { return fontMap[key]; }),
    textStyles: textStyles,
    radii: radiusRows,
    shadows: shadowRows,
    buttons: buttons,
    logos: logos,
    icons: icons,
    ogImage: /^https?:/i.test(ogImage) ? ogImage : (ogImage ? new URL(ogImage, location.href).href : null),
    headings: headings,
    navLabels: navLabels,
    motion: {
      durationsMs: top(motionDur, 8).map(Number),
      easings: top(motionEase, 6),
      properties: top(motionProp, 8),
      animationNames: top(motionAnim, 12)
    },
    googleFamilies: googleFamilies,
    inlineCss: inlineCss,
    stylesheetUrls: stylesheetUrls,
    visibleElements: visible,
    textLength: (document.body.innerText || "").trim().length,
    documentHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)
  };
})()`;

/** One file the page's DOM points at (an element or a CSS background), as the in-page script reported it. */
export interface RawResourceRef {
  url: string;
  /** What the element implies; the reader re-classifies with the response's type when it has one. */
  kind: WebsiteResourceKind;
  /** Natural size, when the page shows it. */
  width: number | null;
  height: number | null;
  /** Media length in seconds, when the element knows it. */
  duration: number | null;
  usage: string;
}

/**
 * The files the page's DOM points at: images (src, srcset, picture sources), video/audio (src, poster, sources),
 * external SVG `<use>` sprites, CSS `url()` backgrounds of visible elements, icon/preload links, and Lottie/Rive
 * players. Inline SVGs and `#fragment` references are not files and are skipped; the network half of the list (every
 * response, its size and mime type) is collected in Node (`inspectSite.ts`).
 */
export const RESOURCE_SCRIPT = String.raw`(() => {
  var MAX = 400;
  var MAX_ELEMENTS = 2500;
  var out = [];
  var seen = new Map();

  function absolute(value) {
    try {
      var url = new URL(value, location.href);
      return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
    } catch (e) { return null; }
  }
  function clip(text, n) { return String(text || "").replace(/\s+/g, " ").trim().slice(0, n); }
  function where(el) {
    var node = el;
    for (var depth = 0; node && depth < 4; depth++) {
      if (node.id) return "#" + node.id;
      var cls = typeof node.className === "string" ? node.className.trim().split(/\s+/)[0] : "";
      if (cls) return "." + cls;
      node = node.parentElement;
    }
    return el.tagName ? el.tagName.toLowerCase() : "?";
  }
  function context(el) {
    var tag = el.tagName ? el.tagName.toLowerCase() : "?";
    var place = where(el);
    return place === tag ? tag : tag + " in " + place;
  }
  function add(url, kind, usage, size) {
    var href = absolute(url);
    if (!href || out.length >= MAX) return;
    var key = href.split("#")[0];
    var known = seen.get(key);
    if (known) {
      if (known.kind === "other" && kind !== "other") known.kind = kind;
      if (known.width === null && size && size.width) known.width = size.width;
      if (known.height === null && size && size.height) known.height = size.height;
      if (known.duration === null && size && size.duration) known.duration = size.duration;
      return;
    }
    var row = {
      url: href,
      kind: kind,
      width: (size && size.width) || null,
      height: (size && size.height) || null,
      duration: (size && size.duration) || null,
      usage: clip(usage, 160)
    };
    seen.set(key, row);
    out.push(row);
  }
  function candidates(srcset) {
    return String(srcset || "").split(",").map(function (part) {
      return part.trim().split(/\s+/)[0];
    }).filter(Boolean);
  }

  // ── Images ──
  document.querySelectorAll("img").forEach(function (img) {
    var rect = img.getBoundingClientRect();
    var size = {
      width: img.naturalWidth || Math.round(rect.width) || null,
      height: img.naturalHeight || Math.round(rect.height) || null
    };
    var src = img.currentSrc || img.src || "";
    if (src) add(src, "image", context(img), size);
    candidates(img.getAttribute("srcset")).forEach(function (url) {
      add(url, "image", context(img) + " (srcset)", size);
    });
  });
  document.querySelectorAll("picture source[srcset]").forEach(function (source) {
    var picture = source.closest("picture") || source;
    candidates(source.getAttribute("srcset")).forEach(function (url) {
      add(url, "image", context(picture) + " (source)", null);
    });
  });

  // ── Video and audio ──
  function mediaFlags(el) {
    var flags = [];
    if (el.autoplay) flags.push("autoplay");
    if (el.loop) flags.push("loop");
    if (el.muted) flags.push("muted");
    return flags.length ? " " + flags.join(" ") : "";
  }
  function mediaDuration(el) {
    var seconds = Number(el.duration);
    return isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) / 1000 : null;
  }
  document.querySelectorAll("video").forEach(function (video) {
    var usage = context(video) + mediaFlags(video);
    var size = {
      width: video.videoWidth || null,
      height: video.videoHeight || null,
      duration: mediaDuration(video)
    };
    var src = video.currentSrc || video.src || "";
    if (src) add(src, "video", usage, size);
    video.querySelectorAll("source[src]").forEach(function (source) {
      add(source.getAttribute("src"), "video", usage + " (source)", size);
    });
    var poster = video.getAttribute("poster");
    if (poster) add(poster, "image", context(video) + " poster", null);
  });
  document.querySelectorAll("audio").forEach(function (audio) {
    var usage = context(audio) + mediaFlags(audio);
    var size = { duration: mediaDuration(audio) };
    var src = audio.currentSrc || audio.src || "";
    if (src) add(src, "audio", usage, size);
    audio.querySelectorAll("source[src]").forEach(function (source) {
      add(source.getAttribute("src"), "audio", usage + " (source)", size);
    });
  });

  // ── External SVG sprites ──
  document.querySelectorAll("use").forEach(function (use) {
    var href = use.getAttribute("href") || use.getAttribute("xlink:href") || "";
    if (!href || href.charAt(0) === "#") return;
    add(href, "svg", "SVG <use> sprite in " + where(use), null);
  });

  // ── Animation players: Lottie JSON/.lottie, Rive .riv ──
  document.querySelectorAll("lottie-player, dotlottie-player, [data-animation-path], [data-src]").forEach(function (el) {
    var src = el.getAttribute("src") || el.getAttribute("data-animation-path") || el.getAttribute("data-src") || "";
    var path = src.split(/[?#]/)[0].toLowerCase();
    if (!/\.(json|lottie|riv)$/.test(path)) return;
    var label = /\.riv$/.test(path) ? "Rive animation" : "Lottie player";
    add(src, "animation", label + " in " + where(el), null);
  });

  // ── CSS backgrounds of visible elements ──
  var all = document.body ? document.body.getElementsByTagName("*") : [];
  var limit = Math.min(all.length, MAX_ELEMENTS);
  var urlPattern = /url\((['"]?)([^'")]+)\1\)/g;
  for (var i = 0; i < limit && out.length < MAX; i++) {
    var el = all[i];
    if (el.closest && el.closest("svg")) continue;
    var style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") continue;
    var rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;
    var background = style.backgroundImage;
    if (!background || background === "none" || background.indexOf("url(") < 0) continue;
    var found = 0;
    urlPattern.lastIndex = 0;
    var match;
    while ((match = urlPattern.exec(background)) && found < 2) {
      var ref = match[2];
      if (/^data:/i.test(ref)) continue;
      add(ref, "image", "CSS background of " + where(el), null);
      found++;
    }
  }

  // ── Icon and preload links ──
  var PRELOAD_KINDS = { font: "font", script: "script", style: "stylesheet", video: "video", audio: "audio", image: "image", fetch: "data", document: "document", track: "other" };
  document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="apple-touch-icon-precomposed"], link[rel="mask-icon"], link[rel="preload"]').forEach(function (link) {
    var href = link.getAttribute("href") || "";
    if (!href) return;
    var rel = (link.getAttribute("rel") || "").toLowerCase();
    var as = (link.getAttribute("as") || "").toLowerCase();
    if (rel === "preload") {
      add(href, PRELOAD_KINDS[as] || "other", "preload (" + (as || "fetch") + ")", null);
    } else {
      add(href, "image", "<link rel=" + rel + ">", null);
    }
  });

  return out;
})()`;
