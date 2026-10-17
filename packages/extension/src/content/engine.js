// Content engine — DOM-only synthetic accessibility/semantic perception.
// NO CDP, NO chrome.debugger. Stealth-first.
//
// Provides: ping, observe(semantic|read|marks), locate({role,name}), screenshot
// hint. Stable refs survive an observe->act cycle within one snapshot
// generation; acting on a stale ref must surface STALE_SNAPSHOT (task #6).

(() => {
  // Idempotent: re-injection (self-heal path) must not register a 2nd listener.
  // An instance orphaned by an extension reload has lost chrome.runtime and
  // can no longer answer, so it must not block its replacement.
  if (window.__ab_engine_loaded && chrome.runtime?.id) return;
  window.__ab_engine_loaded = true;
  const AB = (window.__AB = window.__AB || { gen: 0, refs: new Map() });
  const REDACT_SEL = [
    "input[type=password]",
    "input[autocomplete*=cc-]",
    "input[autocomplete=one-time-code]",
    "input[name*=otp]",
    "input[name*=pass]",
  ];

  const TAG_ROLE = {
    A: (el) => (el.hasAttribute("href") ? "link" : "generic"),
    BUTTON: () => "button",
    INPUT: (el) => {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      return (
        {
          checkbox: "checkbox",
          radio: "radio",
          submit: "button",
          button: "button",
          range: "slider",
          search: "searchbox",
        }[t] || "textbox"
      );
    },
    SELECT: () => "combobox",
    TEXTAREA: () => "textbox",
    NAV: () => "navigation",
    MAIN: () => "main",
    HEADER: () => "banner",
    FOOTER: () => "contentinfo",
    FORM: () => "form",
    H1: () => "heading",
    H2: () => "heading",
    H3: () => "heading",
    H4: () => "heading",
    H5: () => "heading",
    H6: () => "heading",
    IMG: () => "img",
  };

  const clip = (s, n) => (s || "").replace(/\s+/g, " ").trim().slice(0, n);

  // Native dialogs auto-handled by the MAIN-world tamer are reported here.
  AB.dialogs = AB.dialogs || [];
  window.addEventListener("ab-dialog", (e) => {
    AB.dialogs.push(e.detail);
    if (AB.dialogs.length > 20) AB.dialogs.shift();
  });
  const recentDialogs = () => AB.dialogs.slice(-5);

  // An editing host — a contenteditable element, or the body of a document in
  // design mode (the iframe a rich-text editor such as TinyMCE types into).
  const isEditingHost = (el) =>
    el.getAttribute("contenteditable") === "true" ||
    el.getAttribute("contenteditable") === "" ||
    (el === el.ownerDocument.body && (el.isContentEditable || el.ownerDocument.designMode === "on"));

  function role(el) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.split(/\s+/)[0];
    const f = TAG_ROLE[el.tagName];
    if (f) return f(el);
    return isEditingHost(el) ? "textbox" : null;
  }

  // Roles whose accessible name comes from their own content.
  const NAMED_BY_CONTENT = new Set([
    "button", "link", "menuitem", "menuitemcheckbox", "menuitemradio",
    "tab", "option", "treeitem", "switch",
  ]);

  function accName(el) {
    // Look labels up in the element's own document: an element inside an
    // iframe is labelled by ids in that iframe, not in the top page.
    const doc = el.ownerDocument;
    const byId = (attr) =>
      (el.getAttribute(attr) || "")
        .split(/\s+/)
        .map((id) => doc.getElementById(id)?.textContent || "")
        .join(" ");
    let n =
      byId("aria-labelledby") ||
      el.getAttribute("aria-label") ||
      "";
    if (!n && el.id) {
      const lbl = doc.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl) n = lbl.textContent || "";
    }
    if (!n) n = el.closest("label")?.textContent || "";
    if (!n) n = el.getAttribute("placeholder") || el.getAttribute("alt") || "";
    const r = role(el);
    if (!n.trim()) {
      if (NAMED_BY_CONTENT.has(r) || /^h[1-6]$/i.test(el.tagName))
        n = el.textContent || "";
      // Icon-only controls (vote arrows, close buttons) carry their label on a
      // child: <a><img alt="…"></a>, <a><div title="…"></div></a>, an <svg>.
      if (!n.trim() && (r === "button" || r === "link")) {
        const c = el.querySelector("[aria-label], img[alt], [title]");
        n = c?.getAttribute("aria-label") || c?.getAttribute("alt") || c?.getAttribute("title") || "";
      }
    }
    // A checkbox drawn by its neighbour (<input><label>Walk dog</label>, as in
    // TodoMVC) has no programmatic label; the adjacent text is what a person reads.
    if (!n.trim() && (r === "checkbox" || r === "radio")) {
      const sib = [el.nextElementSibling, el.previousElementSibling].find((s) => s?.tagName === "LABEL");
      n = sib?.textContent || "";
    }
    // title is a tooltip: the last resort, after the visible text. Taking it
    // first named Wikipedia's links after their targets ("Special:Statistics").
    if (!n.trim()) n = el.getAttribute("title") || "";
    // An editor's iframe body: the iframe element carries the label.
    if (!n.trim() && el === doc.body) {
      const frame = doc.defaultView?.frameElement;
      n = frame?.getAttribute("title") || frame?.getAttribute("aria-label") || "";
    }
    return clip(n, 100);
  }

  // The group a radio or checkbox belongs to — its fieldset legend or its
  // radiogroup's name — so "Small" under "Pizza Size" can be told from another
  // "Small" on the page.
  function groupName(el) {
    const legend = el.closest("fieldset")?.querySelector(":scope > legend")?.textContent;
    if (legend?.trim()) return clip(legend, 60);
    const g = el.closest('[role="radiogroup"], [role="group"]');
    return g && g !== el ? accName(g) : "";
  }

  // Input types whose value Chrome only accepts whole: a partial time like "1"
  // is invalid and resets the field to empty, so typing character by character
  // can never fill one.
  const WHOLE_VALUE = new Set(["date", "time", "datetime-local", "month", "week", "number", "color", "range"]);
  const TEXT_INPUT_TYPES = new Set(["text", "search", "email", "url", "tel", "password"]);

  // Form controls at opacity 0 are still on top and still take the click: it
  // is how custom-styled checkboxes and radios are built (the page paints a
  // fake box underneath). Dropping them made those controls unreachable.
  const FORM_CONTROL = new Set(["INPUT", "SELECT", "TEXTAREA"]);

  function visible(el) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "none") return false;
    return s.opacity !== "0" || FORM_CONTROL.has(el.tagName);
  }

  // An element's box in the TOP page's viewport. getBoundingClientRect is
  // relative to the element's own frame, so an element inside an iframe needs
  // each enclosing frame's offset (and its border and padding) added.
  function viewRect(el, r = el.getBoundingClientRect()) {
    let x = r.left;
    let y = r.top;
    let win = el.ownerDocument.defaultView;
    while (win && win !== window && win.frameElement) {
      const fe = win.frameElement;
      const f = fe.getBoundingClientRect();
      const cs = getComputedStyle(fe);
      x += f.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
      y += f.top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop);
      win = win.parent;
    }
    return { left: x, top: y, width: r.width, height: r.height, right: x + r.width, bottom: y + r.height };
  }

  const inViewport = (el) => {
    const r = viewRect(el);
    return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  };

  function isRedacted(el) {
    return REDACT_SEL.some((s) => {
      try {
        return el.matches(s);
      } catch {
        return false;
      }
    });
  }

  function state(el) {
    const s = {};
    if (el.disabled || el.getAttribute("aria-disabled") === "true") s.disabled = true;
    if (el.required) s.required = true;
    const ac = el.getAttribute("aria-checked");
    if (el.type === "checkbox" || el.type === "radio") s.checked = !!el.checked;
    else if (ac) s.checked = ac === "true";
    const ae = el.getAttribute("aria-expanded");
    if (ae) s.expanded = ae === "true";
    if (el.getAttribute("aria-selected") === "true") s.selected = true;
    if (/^h([1-6])$/i.test(el.tagName)) s.level = +el.tagName[1];
    if (el.getAttribute("aria-invalid") === "true") s.invalid = true;
    if (el.tagName === "SELECT") {
      // The label a person sees, not just the option's value ("2").
      const opts = [...el.options];
      if (el.selectedOptions[0]) s.selected = clip(el.selectedOptions[0].text, 60);
      s.options = opts.slice(0, 12).map((o) => clip(o.text, 40));
      if (opts.length > 12) s.optionCount = opts.length;
    }
    if (el.tagName === "INPUT") {
      const t = (el.type || "text").toLowerCase();
      // Say the type when it dictates the value's format (time, date, number…).
      if (!TEXT_INPUT_TYPES.has(t) && t !== "checkbox" && t !== "radio") s.inputType = t;
      if (t === "checkbox" || t === "radio") {
        const g = groupName(el);
        if (g) s.group = g;
      }
    }
    if ("value" in el && el.value != null && el.value !== "" && el.type !== "checkbox" && el.type !== "radio") {
      s.value = isRedacted(el) ? "[redacted]" : clip(String(el.value), 60);
    }
    return s;
  }

  const INTERACTIVE = new Set([
    "link",
    "button",
    "textbox",
    "searchbox",
    "checkbox",
    "radio",
    "combobox",
    "slider",
    "menuitem",
    "tab",
    "switch",
    "option",
  ]);
  const LANDMARK = new Set([
    "navigation",
    "main",
    "banner",
    "contentinfo",
    "form",
    "search",
    "region",
    "heading",
  ]);

  // Walk doc + open shadow roots + same-origin iframes. Cross-origin frames
  // are emitted as boundary nodes (documented capability limit, no CDP).
  function* walk(root, depth) {
    const tw = (root.ownerDocument || root).createTreeWalker(
      root,
      NodeFilter.SHOW_ELEMENT,
    );
    let el = tw.nextNode();
    while (el) {
      yield { el, depth };
      if (el.shadowRoot) yield* walk(el.shadowRoot, depth + 1);
      if (el.tagName === "IFRAME") {
        let doc = null;
        try {
          doc = el.contentDocument;
        } catch {
          doc = null;
        }
        if (doc && doc.body) {
          AB.frameDocs.add(doc);
          // The body itself first: in an editor's iframe it is the text box.
          yield { el: doc.body, depth: depth + 1 };
          yield* walk(doc.body, depth + 1);
        } else yield { el, depth, crossOrigin: true };
      }
      el = tw.nextNode();
    }
  }

  function buildTree(opts) {
    const maxNodes = opts.maxNodes || 220;
    AB.gen = Date.now();
    AB.refs = new Map();
    // Clear old refs in iframes too: robustClick finds an element by its ref
    // attribute in every frame, so a stale one there could be clicked instead.
    for (const d of [document, ...(AB.frameDocs || [])]) {
      try {
        d.querySelectorAll("[data-ab-ref]").forEach((n) => n.removeAttribute("data-ab-ref"));
      } catch {}
    }
    AB.frameDocs = new Set();

    // Every qualifying element gets a ref, so locate/act can reach the whole
    // page; only the tree handed back is capped at maxNodes. Capping the refs
    // too made anything past the cap unreachable by name.
    const out = [];
    let ref = 0;
    let omitted = 0;
    for (const { el, depth, crossOrigin } of walk(document.body, 0)) {
      if (crossOrigin) {
        if (out.length < maxNodes)
          out.push({ depth, role: "iframe", name: clip(el.src, 60), crossOrigin: true });
        else omitted += 1;
        continue;
      }
      const r = role(el);
      if (!r || r === "generic") continue;
      if (!visible(el)) continue;
      const name = accName(el);
      const interactive = INTERACTIVE.has(r);
      const landmark = LANDMARK.has(r);
      if (!interactive && !landmark) continue;
      if (!interactive && !name) continue;

      ref += 1;
      el.setAttribute("data-ab-ref", String(ref));
      AB.refs.set(ref, el);
      if (out.length >= maxNodes || (opts.viewportOnly && !inViewport(el))) {
        omitted += 1;
        continue;
      }
      const st = state(el);
      out.push({
        ref,
        depth,
        role: r,
        name,
        ...(interactive ? { interactive: true } : {}),
        ...(inViewport(el) ? {} : { offscreen: true }),
        ...(Object.keys(st).length ? { state: st } : {}),
      });
    }
    return {
      url: location.href,
      title: document.title,
      snapshotGeneration: AB.gen,
      truncated: omitted > 0,
      counts: {
        nodes: out.length,
        interactive: out.filter((n) => n.interactive).length,
        ...(omitted ? { omitted } : {}),
      },
      ...(omitted
        ? { hint: `${omitted} more elements not listed; agent_browser_act still finds them by name` }
        : {}),
      ...(recentDialogs().length ? { dialogs: recentDialogs() } : {}),
      tree: out,
    };
  }

  function drawMarks() {
    document.getElementById("__ab_marks")?.remove();
    const layer = document.createElement("div");
    layer.id = "__ab_marks";
    layer.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
    for (const [r, el] of AB.refs) {
      const b = viewRect(el);
      if (b.width <= 0 || b.bottom < 0 || b.top > innerHeight) continue;
      const tag = document.createElement("div");
      tag.textContent = String(r);
      tag.style.cssText = `position:absolute;left:${Math.max(0, b.left)}px;top:${Math.max(
        0,
        b.top,
      )}px;background:#e11;color:#fff;font:11px/1.4 monospace;padding:0 3px;border-radius:2px;`;
      const box = document.createElement("div");
      box.style.cssText = `position:absolute;left:${b.left}px;top:${b.top}px;width:${b.width}px;height:${b.height}px;outline:1.5px solid #e11;`;
      layer.appendChild(box);
      layer.appendChild(tag);
    }
    document.documentElement.appendChild(layer);
  }
  const clearMarks = () => document.getElementById("__ab_marks")?.remove();

  // Resolve after the next painted frame, or after `ms` if frames are
  // throttled (a hidden or occluded window never runs rAF).
  const nextPaint = (ms = 150) =>
    new Promise((r) => {
      requestAnimationFrame(() => requestAnimationFrame(r));
      setTimeout(r, ms);
    });

  // The page's visible text, with line breaks kept (collapsing every newline
  // to a space ran headings into their paragraphs) and paged by offset so a
  // long article is never cut off silently.
  function readText(params = {}) {
    // Leading indentation is kept (it carries the structure of JSON and code);
    // runs of spaces inside a line and trailing spaces are squeezed.
    // innerText stops at iframe boundaries; add each same-origin frame's text
    // (an editor's content, an embedded form) under a marker, in page order.
    const frames = [];
    for (const f of document.querySelectorAll("iframe")) {
      try {
        const t = f.contentDocument?.body?.innerText?.trim();
        if (t && visible(f)) frames.push(`\n[frame: ${clip(f.title || f.name || f.src || "untitled", 60)}]\n${t}`);
      } catch {} // cross-origin
    }
    const all = ((document.body?.innerText || "") + frames.join("\n"))
      .replace(/ /g, " ")
      .replace(/(\S)[ \t]{2,}/g, "$1 ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    const offset = Math.max(0, params.offset || 0);
    const maxChars = params.maxChars || 8000;
    const end = Math.min(all.length, offset + maxChars);
    return {
      text: all.slice(offset, end),
      totalChars: all.length,
      ...(end < all.length ? { truncated: true, nextOffset: end } : {}),
    };
  }

  async function observe(params = {}) {
    const mode = params.mode || "semantic";
    if (mode === "read") return { url: location.href, title: document.title, ...readText(params) };
    const snap = buildTree(params);
    if (mode === "marks") {
      drawMarks();
      // The overlay has to reach the screen before the SW captures it, or the
      // image comes back without it.
      await nextPaint();
      snap.marksDrawn = true;
      snap.needsScreenshot = true; // SW captures via chrome.tabs.captureVisibleTab
    }
    return snap;
  }

  // ---- screenshot support: the SW captures the viewport; these let it scroll
  //      the page and map an element or region to page coordinates.
  function pageMetrics() {
    const se = document.scrollingElement || document.documentElement;
    return {
      scrollX, scrollY, innerWidth, innerHeight,
      scrollHeight: Math.max(se.scrollHeight, innerHeight),
      devicePixelRatio,
    };
  }

  async function scrollToY(p = {}) {
    window.scrollTo({ top: p.y || 0, left: scrollX, behavior: "instant" });
    await nextPaint(250);
    return { scrollY };
  }

  function rectOf(p = {}) {
    const el = resolve(p.ref, p.gen);
    // Take in text that overflows the box: a large heading in a short line
    // box (TodoMVC's 80px "todos" in a 19.6px box) was captured cut in half.
    let r = el.getBoundingClientRect();
    try {
      const range = el.ownerDocument.createRange();
      range.selectNodeContents(el);
      const t = range.getBoundingClientRect();
      if (t.width && t.height) {
        const left = Math.min(r.left, t.left);
        const top = Math.min(r.top, t.top);
        r = { left, top, width: Math.max(r.right, t.right) - left, height: Math.max(r.bottom, t.bottom) - top };
      }
    } catch {}
    const v = viewRect(el, r);
    return { rect: { x: v.left + scrollX, y: v.top + scrollY, width: v.width, height: v.height } };
  }

  // Fixed and sticky elements (headers, cookie bars) would repeat in every
  // slice of a stitched capture. Hide them after the first slice, then restore.
  function hideFixed() {
    // Already hidden: a second pass would record "hidden" as the original
    // value and never restore it.
    if (AB.hiddenFixed?.length) return { hidden: AB.hiddenFixed.length };
    const hidden = [];
    for (const el of document.body.querySelectorAll("*")) {
      const pos = getComputedStyle(el).position;
      if (pos !== "fixed" && pos !== "sticky") continue;
      hidden.push([el, el.style.getPropertyValue("visibility"), el.style.getPropertyPriority("visibility")]);
      el.style.setProperty("visibility", "hidden", "important");
    }
    AB.hiddenFixed = hidden;
    return { hidden: hidden.length };
  }
  // macOS flashes its overlay scrollbar on every programmatic scroll, so each
  // slice of a stitched capture carried a scrollbar thumb down the right edge.
  function hideScrollbar() {
    if (document.getElementById("__ab_noscrollbar")) return { ok: true };
    const s = document.createElement("style");
    s.id = "__ab_noscrollbar";
    s.textContent =
      "html,body{scrollbar-width:none!important}html::-webkit-scrollbar,body::-webkit-scrollbar{display:none!important}";
    document.documentElement.appendChild(s);
    return { ok: true };
  }
  const restoreScrollbar = () => (document.getElementById("__ab_noscrollbar")?.remove(), { ok: true });

  function restoreFixed() {
    for (const [el, v, prio] of AB.hiddenFixed || []) {
      if (v) el.style.setProperty("visibility", v, prio);
      else el.style.removeProperty("visibility");
    }
    AB.hiddenFixed = [];
    return { ok: true };
  }

  // Used by the action engine (task #6). Stale refs must be detectable.
  function resolve(ref, gen) {
    if (gen && gen !== AB.gen) {
      const e = new Error("STALE_SNAPSHOT: re-observe before acting");
      e.code = "STALE_SNAPSHOT";
      throw e;
    }
    const el = AB.refs.get(ref);
    if (!el || !el.isConnected) {
      const e = new Error("REF_NOT_FOUND: element gone, re-observe");
      e.code = "REF_NOT_FOUND";
      throw e;
    }
    return el;
  }

  // Page structure the snapshot leaves out to stay small, but which callers
  // still want to target — mostly to screenshot one (an infobox, a story row).
  const STRUCTURAL = {
    table: "table", row: "tr", cell: "td, th", figure: "figure", article: "article",
    img: "img, svg", list: "ul, ol", listitem: "li", paragraph: "p",
    region: "section", dialog: "dialog", code: "pre",
  };

  function structuralName(el) {
    const own = accName(el);
    if (own.trim()) return own;
    // innerText, not textContent: cells and lines need their breaks, or a
    // table reads "The Star Ferry CompanyStar Ferry Pier…".
    const cap = el.querySelector(":scope > caption, :scope > figcaption");
    const lead = cap?.innerText || el.getAttribute("alt") || el.innerText || el.textContent;
    return clip(lead, 100);
  }

  // Find structural elements by role and name, and give them refs on demand.
  // Innermost first: HN nests whole pages in table rows, so the row that is
  // the story must come before the row that holds everything.
  function locateStructural(roleName, want) {
    const sel = [STRUCTURAL[roleName], `[role="${roleName}"]`].filter(Boolean).join(", ");
    const found = [...document.querySelectorAll(sel)].filter(
      (el) => visible(el) && (!want || structuralName(el).toLowerCase().includes(want)),
    );
    const outer = (el) => found.some((o) => o !== el && el.contains(o));
    found.sort((a, b) => outer(a) - outer(b));
    let next = Math.max(0, ...AB.refs.keys()) + 1;
    return found.slice(0, 20).map((el) => {
      let r = +el.getAttribute("data-ab-ref") || 0;
      if (!r || AB.refs.get(r) !== el) {
        r = next++;
        el.setAttribute("data-ab-ref", String(r));
        AB.refs.set(r, el);
      }
      return { ref: r, role: roleName, name: structuralName(el) };
    });
  }

  function locate(params = {}) {
    if (!AB.refs.size) buildTree(params);
    const want = (params.name || "").toLowerCase();
    const search = () => {
      const matches = [];
      for (const [r, el] of AB.refs) {
        if (!el.isConnected) continue;
        if (params.role && role(el) !== params.role) continue;
        // A radio or checkbox also answers to "<group> <name>" ("Pizza Size
        // Small"), which tells it from another "Small" on the page.
        const name = accName(el);
        const group = el.type === "radio" || el.type === "checkbox" ? groupName(el) : "";
        if (want && !name.toLowerCase().includes(want) && !(group && `${group} ${name}`.toLowerCase().includes(want))) continue;
        matches.push({ ref: r, role: role(el), name, ...(group ? { group } : {}) });
      }
      return matches;
    };
    let matches = search();
    // The page may have changed since the last snapshot (a menu opened, an SPA
    // route rendered). Re-index once before reporting nothing. Rebuilding
    // only on a miss keeps refs from an earlier observe valid on a hit.
    if (!matches.length) {
      buildTree(params);
      matches = search();
    }
    if (!matches.length && params.role && (STRUCTURAL[params.role] || !INTERACTIVE.has(params.role)))
      matches = locateStructural(params.role, want);
    return { snapshotGeneration: AB.gen, matches };
  }

  // ---- action engine (DOM-only, human-like). isTrusted:false is an accepted
  //      tradeoff of the no-CDP stealth posture; sites that gate on it surface
  //      TRUSTED_INPUT_REQUIRED rather than weakening stealth.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (b) => b + Math.random() * b;

  async function settleRect(el, timeout = 2000) {
    const t0 = performance.now();
    let last = null;
    while (performance.now() - t0 < timeout) {
      const r = el.getBoundingClientRect();
      const key = `${r.x | 0},${r.y | 0},${r.width | 0},${r.height | 0}`;
      if (key === last) return;
      last = key;
      await sleep(80);
    }
  }

  async function ensureActionable(el) {
    if (!el.isConnected) {
      const e = new Error("REF_NOT_FOUND: element detached"); e.code = "REF_NOT_FOUND"; throw e;
    }
    el.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
    await sleep(jitter(120));
    await settleRect(el);
    if (!visible(el)) {
      const e = new Error("NOT_ACTIONABLE: not visible"); e.code = "NOT_ACTIONABLE"; throw e;
    }
    if (el.disabled || el.getAttribute("aria-disabled") === "true") {
      const e = new Error("NOT_ACTIONABLE: disabled"); e.code = "NOT_ACTIONABLE"; throw e;
    }
    // Coordinates relative to the element's own frame, so ask that frame's
    // document what is on top (the top page would only ever answer "the iframe").
    const b = el.getBoundingClientRect();
    const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
    const top = el.ownerDocument.elementFromPoint(cx, cy);
    if (top && top !== el && !el.contains(top) && !top.contains(el)) {
      const e = new Error("NOT_ACTIONABLE: occluded by another element");
      e.code = "NOT_ACTIONABLE"; throw e;
    }
    return { cx, cy };
  }

  function fire(el, type, init = {}) {
    const Ev = /^(pointer)/.test(type)
      ? PointerEvent
      : /^(mouse|click|dbl)/.test(type)
        ? MouseEvent
        : /^key/.test(type)
          ? KeyboardEvent
          : Event;
    el.dispatchEvent(new Ev(type, { bubbles: true, cancelable: true, composed: true, ...init }));
  }

  async function humanClick(el, cx, cy) {
    const at = { clientX: cx, clientY: cy };
    fire(el, "pointerover", at); fire(el, "mouseover", at);
    for (let i = 0; i < 3; i++) {
      fire(el, "mousemove", { clientX: cx + (Math.random() - 0.5) * 4, clientY: cy + (Math.random() - 0.5) * 4 });
      await sleep(jitter(18));
    }
    fire(el, "pointerdown", at); fire(el, "mousedown", at);
    if (typeof el.focus === "function") el.focus();
    await sleep(jitter(55));
    fire(el, "pointerup", at); fire(el, "mouseup", at);
    fire(el, "click", at);
  }

  const nativeSetter = (el) => {
    // Only return a setter for elements that actually have a .value property;
    // returning the input setter for a <div>/<select> -> "Illegal invocation".
    // By tag, from the element's own window: `instanceof HTMLInputElement` is
    // false for an input inside an iframe, which has its own constructors.
    const win = el.ownerDocument.defaultView || window;
    const proto =
      el.tagName === "TEXTAREA" ? win.HTMLTextAreaElement : el.tagName === "INPUT" ? win.HTMLInputElement : null;
    return proto ? Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set : null;
  };

  async function humanType(el, text, replace) {
    el.focus();
    const setter = nativeSetter(el);
    const isCE = el.isContentEditable;
    const doc = el.ownerDocument; // an editor in an iframe edits its own document

    // Date, time, number…: one whole-value write, then check it took.
    if (setter && el.tagName === "INPUT" && WHOLE_VALUE.has((el.type || "").toLowerCase())) {
      const want = String(text);
      const previous = el.value;
      setter.call(el, want);
      if (el.value !== want && want !== "") {
        // Chrome clears the field when it rejects a value. Put the old one
        // back before saying so, or "unchanged" would be false.
        setter.call(el, previous);
        const fmt = { date: "YYYY-MM-DD", time: "HH:MM (24h)", "datetime-local": "YYYY-MM-DDTHH:MM", month: "YYYY-MM", week: "YYYY-Www", color: "#rrggbb" }[el.type] || "a valid number";
        const e = new Error(`INVALID_VALUE: this ${el.type} field rejected "${want}"; it expects ${fmt}`);
        e.code = "NOT_ACTIONABLE";
        throw e;
      }
      // Only now tell the page: a rejected value never reaches its handlers.
      fire(el, "input", { inputType: "insertReplacementText" });
      fire(el, "change");
      return;
    }

    if (replace) {
      if (setter) {
        setter.call(el, "");
        fire(el, "input", { inputType: "deleteContentBackward" });
      } else if (isCE) {
        // Select-all + delete: rich editors (ProseMirror etc.) track this.
        const sel = doc.getSelection();
        const range = doc.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
        fire(el, "beforeinput", { inputType: "deleteContentBackward" });
        doc.execCommand("delete", false);
        fire(el, "input", { inputType: "deleteContentBackward" });
      }
    }

    for (const ch of String(text)) {
      fire(el, "keydown", { key: ch });
      fire(el, "beforeinput", { data: ch, inputType: "insertText" });
      if (setter) {
        setter.call(el, (el.value ?? "") + ch);
      } else if (isCE) {
        // execCommand insertText drives the editor's own model + fires input.
        doc.execCommand("insertText", false, ch);
      } else {
        el.textContent = (el.textContent ?? "") + ch;
      }
      fire(el, "input", { data: ch, inputType: "insertText" });
      fire(el, "keyup", { key: ch });
      await sleep(jitter(45));
    }
    fire(el, "change");
  }

  const NOT_TEXT = new Set(["checkbox", "radio", "button", "submit", "reset", "file", "image", "range", "color", "hidden"]);
  const isTextField = (el) => el.tagName === "INPUT" && !NOT_TEXT.has((el.type || "text").toLowerCase());

  // HTML implicit submission: Enter in a single-line field activates the
  // form's default button, or submits a form that has only one such field.
  // A real key press gets this from the browser; a synthetic keydown does not,
  // so without it "fill, then press Enter" silently did nothing on
  // Wikipedia's search box.
  function implicitSubmit(form) {
    const fields = [...form.elements];
    const button = fields.find((f) => f.type === "submit" || f.type === "image");
    if (button) {
      if (!button.disabled) button.click();
      return !button.disabled;
    }
    if (fields.filter(isTextField).length !== 1) return false;
    form.requestSubmit();
    return true;
  }

  async function pressKey(el, key) {
    const t = el || document.activeElement || document.body;
    const init = { key, bubbles: true, cancelable: true, composed: true };
    // A handler that cancels the keydown owns the key; then the browser
    // performs no default action, and neither do we.
    const proceed = t.dispatchEvent(new KeyboardEvent("keydown", init));
    if (proceed && (key === "Enter" || key.length === 1))
      t.dispatchEvent(new KeyboardEvent("keypress", init));
    t.dispatchEvent(new KeyboardEvent("keyup", init));
    if (proceed && key === "Enter" && isTextField(t) && t.form) return { submitted: implicitSubmit(t.form) };
    return {};
  }

  // Select by option value, or failing that by the text a person sees.
  function selectOption(el, want) {
    if (el.tagName !== "SELECT") {
      const e = new Error("NOT_ACTIONABLE: select needs a <select> element"); e.code = "NOT_ACTIONABLE"; throw e;
    }
    const w = String(want ?? "").toLowerCase();
    const opt =
      [...el.options].find((o) => o.value === want) ||
      [...el.options].find((o) => o.text.trim().toLowerCase() === w) ||
      [...el.options].find((o) => o.text.toLowerCase().includes(w));
    if (!opt) {
      const names = [...el.options].slice(0, 20).map((o) => `"${clip(o.text, 40)}"`).join(", ");
      const e = new Error(`NO_SUCH_OPTION: no option matching "${want}"; the options are ${names}`);
      e.code = "NOT_ACTIONABLE";
      throw e;
    }
    el.value = opt.value;
    fire(el, "input");
    fire(el, "change");
  }

  async function act(p = {}) {
    const el = resolve(p.ref, p.gen); // throws STALE_SNAPSHOT / REF_NOT_FOUND
    // An editing host has no .value; its text is what typing changes.
    const valueOf = () => ("value" in el ? el.value : el.isContentEditable ? el.textContent : undefined);
    const before = { url: location.href, value: valueOf() };
    const checkedBefore = el.checked;
    // How a native dialog raised by this action is answered. The MAIN-world
    // dialog handler reads these attributes when the dialog opens. Set before
    // the observer starts, or setting them counts as a change on the page and
    // hides a genuine no-op.
    const root = document.documentElement;
    root.setAttribute("data-ab-dialog", p.onDialog === "dismiss" ? "dismiss" : "accept");
    if (p.dialogText != null) root.setAttribute("data-ab-dialog-text", String(p.dialogText));
    else root.removeAttribute("data-ab-dialog-text");
    const dialogsBefore = AB.dialogs.length;
    let mutated = 0;
    let extra = {};
    const mo = new MutationObserver((recs) => (mutated += recs.length));
    // Watch the element's own document too: a change inside an iframe is not
    // a mutation of the top page.
    for (const d of new Set([document, el.ownerDocument]))
      mo.observe(d.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    try {
      const { cx, cy } = await ensureActionable(el);
      switch (p.action) {
        case "click": await humanClick(el, cx, cy); break;
        case "hover": fire(el, "pointerover", { clientX: cx, clientY: cy }); fire(el, "mouseover", {}); break;
        case "focus": el.focus(); break;
        case "type": await humanType(el, p.value ?? "", false); break;
        case "fill": await humanType(el, p.value ?? "", true); break;
        case "clear": await humanType(el, "", true); break;
        case "press": extra = await pressKey(el, p.value ?? "Enter"); break;
        case "check":
        case "uncheck": {
          const want = p.action === "check";
          if (!!el.checked !== want) await humanClick(el, cx, cy);
          break;
        }
        case "select": selectOption(el, p.value); break;
        case "submit": (el.form || el.closest("form"))?.requestSubmit?.(); break;
        default: {
          const e = new Error(`unknown action: ${p.action}`); e.code = "BAD_ACTION"; throw e;
        }
      }
    } finally {
      await sleep(60);
      mo.disconnect();
    }
    const after = { url: location.href, value: valueOf() };
    // A field's value and a checkbox's state are properties, not DOM
    // mutations, so domMutations alone reads 0 for a fill that worked.
    const valueChanged = before.value !== after.value || el.checked !== checkedBefore;
    const dialogs = AB.dialogs.slice(dialogsBefore);
    return {
      acted: true,
      action: p.action,
      changed: before.url !== after.url || valueChanged || mutated > 0 || !!extra.submitted || dialogs.length > 0,
      signals: { navigated: before.url !== after.url, domMutations: mutated, valueChanged, ...extra },
      ...(dialogs.length ? { dialogs } : {}),
      snapshotStale: true, // caller should re-observe
    };
  }

  // Scroll the page: to the top or bottom, by a screen, or to a y. Reports
  // whether the bottom was reached, and how much the page grew — an infinite
  // feed loads more as you reach its end.
  async function scrollPage(p = {}) {
    const se = document.scrollingElement || document.documentElement;
    const heightBefore = se.scrollHeight;
    const step = Math.round(innerHeight * 0.85);
    const y =
      p.to === "top" ? 0
      : p.to === "bottom" ? se.scrollHeight
      : p.to === "up" ? scrollY - step
      : p.to === "down" ? scrollY + step
      : +p.y || 0;
    window.scrollTo({ top: y, left: scrollX, behavior: "instant" });
    await nextPaint(250);
    await waitForStable({ timeout: p.timeout || 3000, quietMs: 400 });
    return {
      scrollY: Math.round(scrollY),
      pageHeight: se.scrollHeight,
      viewportHeight: innerHeight,
      atTop: scrollY <= 0,
      atBottom: scrollY + innerHeight >= se.scrollHeight - 2,
      ...(se.scrollHeight > heightBefore ? { grewBy: se.scrollHeight - heightBefore } : {}),
    };
  }

  // Wait until some text appears on the page, or an element by role/name, or
  // until it goes away (gone:true). Polls; no CDP.
  async function waitFor(p = {}) {
    const timeout = Math.min(p.timeout || 10000, 25000);
    const want = (p.text || "").toLowerCase();
    const present = () => {
      if (want && !(document.body?.innerText || "").toLowerCase().includes(want)) return false;
      if (p.name || p.role) {
        buildTree({});
        if (!locate({ role: p.role, name: p.name }).matches.length) return false;
      }
      return true;
    };
    const t0 = performance.now();
    while (performance.now() - t0 < timeout) {
      if (present() !== !!p.gone) return { found: !p.gone, gone: !!p.gone, waitedMs: Math.round(performance.now() - t0) };
      await sleep(250);
    }
    return { timedOut: true, waitedMs: timeout };
  }

  // Network/DOM-quiet heuristic without CDP.
  async function waitForStable(p = {}) {
    const timeout = p.timeout || 8000;
    const quiet = p.quietMs || 600;
    const t0 = performance.now();
    let lastMutation = performance.now();
    const mo = new MutationObserver(() => (lastMutation = performance.now()));
    mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
    let lastResource = performance.now();
    let po;
    try {
      po = new PerformanceObserver(() => (lastResource = performance.now()));
      po.observe({ type: "resource", buffered: false });
    } catch {}
    try {
      while (performance.now() - t0 < timeout) {
        const idle = performance.now() - Math.max(lastMutation, lastResource);
        if (document.readyState === "complete" && idle > quiet)
          return { stable: true, waitedMs: Math.round(performance.now() - t0) };
        await sleep(120);
      }
      return { stable: false, timedOut: true, waitedMs: timeout };
    } finally {
      mo.disconnect();
      po?.disconnect();
    }
  }

  async function navigate(p = {}) {
    const historyLength = history.length;
    if (p.action === "back") history.back();
    else if (p.action === "forward") history.forward();
    else if (p.action === "reload") location.reload();
    else if (p.url) location.assign(p.url);
    else {
      const e = new Error("navigate: need url or back/forward/reload"); e.code = "BAD_ACTION"; throw e;
    }
    return { navigating: true, to: p.url || p.action, historyLength };
  }

  // Re-injection must REPLACE the previous listener, never stack on it.
  // After a back/forward-cache restore the earlier instance is still
  // registered but its message channel is dead; if it stays, it answers first
  // and the reply goes nowhere ("message channel is closed"). Dropping the old
  // registration first makes injection idempotent and re-binds the channel.
  if (window.__abEngineListener) {
    try {
      chrome.runtime.onMessage.removeListener(window.__abEngineListener);
    } catch {}
  }
  const abEngineListener = (msg, _s, sendResponse) => {
    (async () => {
      try {
        const m = msg.method;
        if (m === "ping")
          sendResponse({ pong: true, url: location.href, title: document.title, ts: Date.now() });
        else if (m === "observe") sendResponse(await observe(msg.params));
        else if (m === "pageMetrics") sendResponse(pageMetrics());
        else if (m === "scrollToY") sendResponse(await scrollToY(msg.params));
        else if (m === "rectOf") sendResponse(rectOf(msg.params));
        else if (m === "hideFixed") sendResponse(hideFixed());
        else if (m === "restoreFixed") sendResponse(restoreFixed());
        else if (m === "scrollPage") sendResponse(await scrollPage(msg.params));
        else if (m === "waitFor") sendResponse(await waitFor(msg.params));
        else if (m === "hideScrollbar") sendResponse(hideScrollbar());
        else if (m === "restoreScrollbar") sendResponse(restoreScrollbar());
        else if (m === "locate") sendResponse(locate(msg.params));
        else if (m === "act") sendResponse(await act(msg.params));
        else if (m === "waitForStable") sendResponse(await waitForStable(msg.params));
        else if (m === "navigate") sendResponse(await navigate(msg.params));
        else if (m === "clearMarks") {
          clearMarks();
          sendResponse({ ok: true });
        } else sendResponse({ error: `unknown engine method: ${m}` });
      } catch (e) {
        sendResponse({ error: String((e && e.message) || e), code: e && e.code });
      }
    })();
    return true;
  };
  window.__abEngineListener = abEngineListener;
  chrome.runtime.onMessage.addListener(abEngineListener);

  // A bfcache restore brings this document back with a stale channel. Re-arm
  // the listener so the next call binds to a live one instead of erroring.
  window.addEventListener("pageshow", (e) => {
    if (!e.persisted) return;
    try {
      chrome.runtime.onMessage.removeListener(abEngineListener);
      chrome.runtime.onMessage.addListener(abEngineListener);
    } catch {}
  });
})();
