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

  // Something a person would click although the markup does not say so: an
  // <a> with no href but a handler (Bootstrap's data-toggle, an onclick), or a
  // div wired the same way. Handlers added with addEventListener are
  // invisible from here, so the pointer cursor stands in for them on <a>.
  const HANDLER_ATTRS = ["onclick", "data-toggle", "data-bs-toggle", "ng-click", "v-on:click", "@click", "data-action"];
  const hasHandlerAttr = (el) => HANDLER_ATTRS.some((a) => el.hasAttribute(a));
  const pointerCursor = (el) => {
    try {
      return getComputedStyle(el).cursor === "pointer";
    } catch {
      return false;
    }
  };
  function clickableNonLink(el) {
    if (el.tagName === "A") return hasHandlerAttr(el) || el.hasAttribute("tabindex") || pointerCursor(el);
    // A div or span: only with an explicit handler attribute, or focusable and
    // drawn as clickable — a cursor alone would turn every card into a button.
    return hasHandlerAttr(el) || (el.tabIndex >= 0 && el.hasAttribute("tabindex") && pointerCursor(el));
  }

  const TAG_ROLE = {
    A: (el) => (el.hasAttribute("href") ? "link" : clickableNonLink(el) ? "button" : "generic"),
    DIV: (el) => (clickableNonLink(el) ? "button" : null),
    SPAN: (el) => (clickableNonLink(el) ? "button" : null),
    VIDEO: () => "video",
    AUDIO: () => "audio",
    IFRAME: () => "iframe",
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
    const r = f ? f(el) : null;
    if (r) return r;
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
    // A video or audio element without a label: its file name.
    if (!n.trim() && (r === "video" || r === "audio")) {
      const src = el.currentSrc || el.getAttribute("src") || el.querySelector("source")?.getAttribute("src") || "";
      n = src.split(/[?#]/)[0].split("/").pop() || r;
    }
    if (!n.trim() && r === "iframe") n = el.getAttribute("name") || el.getAttribute("src") || "";
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
    // Toggle buttons (a colour swatch, bold in an editor) and the current
    // page in a nav: state a test needs to assert, not just pixels.
    const ap = el.getAttribute("aria-pressed");
    if (ap) s.pressed = ap === "mixed" ? "mixed" : ap === "true";
    const cur = el.getAttribute("aria-current");
    if (cur && cur !== "false") s.current = cur === "true" ? true : cur;
    if (el.tagName === "VIDEO" || el.tagName === "AUDIO") Object.assign(s, mediaState(el));
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
  // Media players are not controls, but an agent testing one needs to see them
  // and their state (a video that failed to load is otherwise invisible).
  const MEDIA = new Set(["video", "audio"]);
  function mediaState(el) {
    const s = {
      paused: el.paused,
      readyState: el.readyState,
      networkState: el.networkState,
      currentTime: Math.round(el.currentTime * 100) / 100,
    };
    if (Number.isFinite(el.duration)) s.duration = Math.round(el.duration * 100) / 100;
    if (el.error) s.error = { code: el.error.code, message: clip(el.error.message, 80) };
    return s;
  }

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
        // A frame from another origin cannot be looked inside, but it is a
        // thing on the page — often the very thing in the way (a captcha). It
        // gets a ref, so it can be screenshotted and named in a result.
        if (!visible(el)) continue;
        ref += 1;
        el.setAttribute("data-ab-ref", String(ref));
        AB.refs.set(ref, el);
        if (out.length < maxNodes)
          out.push({
            ref, depth, role: "iframe", name: clip(el.getAttribute("title") || el.src, 60), crossOrigin: true,
            ...(isCaptchaFrame(el) ? { captcha: true } : {}),
          });
        else omitted += 1;
        continue;
      }
      const r = role(el);
      if (!r || r === "generic" || r === "iframe") continue;
      if (!visible(el)) continue;
      const name = accName(el);
      const interactive = INTERACTIVE.has(r);
      const landmark = LANDMARK.has(r) || MEDIA.has(r);
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
      // Where a link goes and what an image shows, when asked: kept out of the
      // default snapshot, where it would double the size of a link-heavy page.
      if (opts.details) {
        const href = el.getAttribute("href");
        if (r === "link" && href) st.href = clip(el.href || href, 120);
        const src = el.currentSrc || el.getAttribute("src");
        if (src && (el.tagName === "IMG" || MEDIA.has(r))) st.src = clip(src, 120);
      }
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

  // A ref for any element, given on demand (an occluder, a dismiss button).
  function refFor(el) {
    const have = +el.getAttribute("data-ab-ref") || 0;
    if (have && AB.refs.get(have) === el) return have;
    const r = Math.max(0, ...AB.refs.keys()) + 1;
    el.setAttribute("data-ab-ref", String(r));
    AB.refs.set(r, el);
    return r;
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
    const wall = detectWall();
    if (wall) {
      snap.outcome = "needs_human";
      snap.needsHuman = wall;
    }
    Object.assign(snap, pageState());
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
      // Where the page sits on the screen, for input from the operating system.
      screenX, screenY, outerWidth, outerHeight,
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
      // Best match first: the exact name, then one that starts with it, then
      // any that contains it; controls before headings and landmarks. In page
      // order, "Play" found the heading "Player" before the Play button.
      if (want) {
        const rank = (m) => {
          const n = m.name.trim().toLowerCase();
          const g = m.group ? `${m.group} ${m.name}`.trim().toLowerCase() : "";
          const fit = n === want || g === want ? 0 : n.startsWith(want) ? 1 : 2;
          return fit * 2 + (INTERACTIVE.has(m.role) ? 0 : 1);
        };
        matches.sort((a, b) => rank(a) - rank(b));
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
      // Disabled inside a notice that a captcha guards: the button waits on a
      // human, not on the agent.
      const wall = detectWall();
      if (wall && AB.refs.get(wall.node.ref)?.contains(el)) throw wallError(wall, "the element is disabled");
      const e = new Error("NOT_ACTIONABLE: disabled"); e.code = "NOT_ACTIONABLE"; throw e;
    }
    // Coordinates relative to the element's own frame, so ask that frame's
    // document what is on top (the top page would only ever answer "the iframe").
    const b = el.getBoundingClientRect();
    const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
    const top = el.ownerDocument.elementFromPoint(cx, cy);
    if (top && top !== el && !el.contains(top) && !top.contains(el)) {
      const wall = detectWall();
      if (wall && (wall.reason === "captcha" || AB.refs.get(wall.node.ref)?.contains(top))) throw wallError(wall, "the element is covered");
      const e = new Error(`OCCLUDED: covered by ${selectorOf(top)}`);
      e.code = "OCCLUDED";
      e.detail = { occludedBy: selectorOf(top), occluder: nodeInfo(top) };
      throw e;
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
        e.code = "INVALID_VALUE";
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
      e.code = "NO_SUCH_OPTION";
      throw e;
    }
    el.value = opt.value;
    fire(el, "input");
    fire(el, "change");
  }

  async function act(p = {}) {
    // Whatever an earlier hover left marked ends with the next action, as it
    // would when the mouse moves on. Before the observer starts, so it is
    // not counted as this action's effect.
    if (AB.hovered || document.getElementById("__ab_hover")) clearHover();
    // A pointer sequence may have no target: then it acts on the page.
    const el = p.action === "pointer" && p.ref == null ? null : resolve(p.ref, p.gen); // throws STALE_SNAPSHOT / REF_NOT_FOUND
    if (!el) return { acted: true, action: "pointer", changed: true, signals: {}, ...(await pointerSequence(null, p)), snapshotStale: true };
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
    const credsBefore = (AB.credentials || []).length;
    let mutated = 0;
    let extra = {};
    // Our own markers (hover, gesture, refs) are not the page's doing.
    const ours = (r) =>
      (r.type === "attributes" && SELF_ATTRS.has(r.attributeName)) ||
      [...r.addedNodes, ...r.removedNodes].some((n) => n.id === "__ab_hover");
    const mo = new MutationObserver((recs) => (mutated += recs.filter((r) => !ours(r)).length));
    // Watch the element's own document too: a change inside an iframe is not
    // a mutation of the top page.
    for (const d of new Set([document, el.ownerDocument]))
      mo.observe(d.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    let hover = null;
    try {
      const { cx, cy } = await ensureActionable(el);
      switch (p.action) {
        case "click": await humanClick(el, cx, cy); break;
        case "hover": hover = await emulateHover(el, cx, cy); break;
        case "drag": extra = await drag(el, p); break;
        case "pointer": extra = await pointerSequence(el, p); break;
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
    const credentialStoreBlocked = (AB.credentials || []).slice(credsBefore);
    // A hover that changed no style and ran no handler did nothing a person
    // would see. Saying "acted" there was a lie an agent then reported.
    if (hover && !hover.styleChanged && mutated === 0) {
      clearHover();
      const e = new Error(
        "HOVER_NOT_EFFECTIVE: hovering changed nothing on the page" +
          (hover.unreadableStylesheets ? ` (${hover.unreadableStylesheets} stylesheet(s) from another origin could not be read, so their :hover rules could not be applied)` : "") +
          "; a real mouse hover cannot be made without CDP",
      );
      e.code = "HOVER_NOT_EFFECTIVE";
      e.detail = { hoverRules: hover.hoverRules, unreadableStylesheets: hover.unreadableStylesheets || 0 };
      throw e;
    }
    const { drag: dragInfo, rects, value: dragValue, valuenow, note, pointer, ...signalsExtra } = extra;
    return {
      acted: true,
      action: p.action,
      changed:
        before.url !== after.url || valueChanged || mutated > 0 || !!extra.submitted || dialogs.length > 0 || !!hover?.styleChanged ||
        (!!rects && JSON.stringify(rects.before) !== JSON.stringify(rects.after)),
      signals: { navigated: before.url !== after.url, domMutations: mutated, valueChanged, ...signalsExtra, ...(hover ? { hoverStyleChanged: hover.styleChanged } : {}) },
      ...(hover ? { hover: { emulated: true, hoverRules: hover.hoverRules, ...(hover.unreadableStylesheets ? { unreadableStylesheets: hover.unreadableStylesheets } : {}) } } : {}),
      ...(dragInfo ? { drag: dragInfo, rects, ...(dragValue ? { value: dragValue } : {}), ...(valuenow ? { valuenow } : {}), ...(note ? { note } : {}) } : {}),
      ...(pointer ? { pointer } : {}),
      ...(dialogs.length ? { dialogs } : {}),
      ...(credentialStoreBlocked.length ? { credentialStoreBlocked } : {}),
      ...(el.type === "password" && ["type", "fill"].includes(p.action) ? { passwordField: true, host: location.host } : {}),
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

  // ---- human walls: a captcha, or a notice that must be accepted, standing
  //      between the agent and the page. Without this an agent sees disabled
  //      or covered controls, gives up, and reports "no results".
  const CAPTCHA_SRC = /mtcaptcha|hcaptcha|recaptcha|turnstile|challenges\.cloudflare|arkoselabs|funcaptcha|geetest|captcha/i;
  const WALL_TEXT = /consent|cookie|notice to users|terms of (use|service)|verify|verification|are you human|not a robot|robot|captcha|驗證|验证|同意|通知|私隱|隱私|條款/i;
  const DISMISS = /^\s*(accept( all)?|agree|i agree|i accept|ok|okay|got it|allow( all)?|continue|close|dismiss|同意|接受|確定|确定|我同意|關閉|关闭|知道了)\s*$/i;

  function isCaptchaFrame(el) {
    const src = el.getAttribute("src") || el.getAttribute("title") || "";
    if (!CAPTCHA_SRC.test(src)) return false;
    // reCAPTCHA v3's corner badge is not a wall.
    if (el.closest(".grecaptcha-badge") || /size=invisible/.test(src)) return false;
    return visible(el);
  }

  // A short CSS-ish description of an element, to name it in a result.
  function selectorOf(el) {
    if (!el || el.nodeType !== 1) return "";
    const id = el.id ? `#${el.id}` : "";
    const cls = [...el.classList].slice(0, 2).map((c) => `.${c}`).join("");
    return clip(`${el.tagName.toLowerCase()}${id}${cls}`, 80);
  }

  const fixedAncestor = (el) => {
    for (let n = el; n && n.nodeType === 1 && n !== n.ownerDocument.body; n = n.parentElement) {
      const pos = getComputedStyle(n).position;
      if (pos === "fixed" || pos === "sticky") return n;
    }
    return null;
  };

  // Open dialogs and overlays: marked-up dialogs, and a fixed layer covering
  // the middle of the screen.
  function overlayRoots() {
    const found = new Set();
    document
      .querySelectorAll('dialog[open], [aria-modal="true"], [role="dialog"], [role="alertdialog"], .modal.show, .modal.in')
      .forEach((el) => visible(el) && found.add(el));
    for (const [x, y] of [[innerWidth / 2, innerHeight / 2], [innerWidth / 2, innerHeight - 24]]) {
      const hit = document.elementFromPoint(x, y);
      const f = hit && fixedAncestor(hit);
      if (f && f.getBoundingClientRect().width > innerWidth * 0.3) found.add(f);
    }
    // Innermost first is not wanted here: keep the outermost of nested ones.
    return [...found].filter((el) => ![...found].some((o) => o !== el && o.contains(el)));
  }

  function nodeInfo(el) {
    const v = viewRect(el);
    return {
      ref: refFor(el),
      role: role(el) || el.tagName.toLowerCase(),
      name: accName(el) || clip(el.innerText || el.getAttribute("src") || "", 80),
      rect: { x: Math.round(v.left), y: Math.round(v.top), width: Math.round(v.width), height: Math.round(v.height) },
    };
  }

  function detectWall() {
    const frames = [...document.querySelectorAll("iframe")].filter(isCaptchaFrame);
    const roots = overlayRoots();
    // A captcha is a wall wherever it is: no agent can pass it.
    if (frames.length) {
      const f = frames[0];
      const within = roots.find((r) => r.contains(f));
      const heading = within?.querySelector("h1,h2,h3,h4,h5,h6,[role=heading]");
      return {
        reason: "captcha",
        agentCanFix: false,
        node: nodeInfo(f),
        ...(within ? { within: selectorOf(within), ...(heading ? { title: clip(heading.textContent, 80) } : {}) } : {}),
      };
    }
    for (const root of roots) {
      // A notice or banner is short. A fixed layer holding a whole app is
      // not a wall, whatever words its content happens to contain.
      const full = root.innerText || "";
      if (full.length > 5000) continue;
      const headings = [...root.querySelectorAll("h1,h2,h3,h4,h5,h6,[role=heading],legend,strong")].map((h) => h.textContent).join(" ");
      const text = `${headings} ${clip(full, 300)}`;
      const buttons = [...root.querySelectorAll('button, [role=button], input[type=submit], input[type=button], a')].filter(visible);
      const name = (b) => accName(b) || clip(b.value || b.textContent, 40);
      const dismiss = buttons.filter((b) => DISMISS.test(name(b)));
      const enabled = dismiss.filter((b) => !b.disabled && b.getAttribute("aria-disabled") !== "true");
      // A notice whose only way out is disabled: something else (usually a
      // check the agent cannot do) must happen first.
      if (dismiss.length && !enabled.length)
        return { reason: "consent", agentCanFix: false, node: nodeInfo(root), dismiss: { ...nodeInfo(dismiss[0]), disabled: true } };
      if (WALL_TEXT.test(text) && enabled.length)
        return { reason: "consent", agentCanFix: true, node: nodeInfo(root), dismiss: nodeInfo(enabled[0]) };
    }
    return null;
  }

  const wallError = (wall, what) => {
    const e = new Error(
      `NEEDS_HUMAN: ${what} — ${wall.reason === "captcha" ? "a captcha" : "a notice"} blocks the page` +
        (wall.dismiss && wall.agentCanFix ? ` (dismiss it: ref ${wall.dismiss.ref} "${wall.dismiss.name}")` : ""),
    );
    e.code = wall.agentCanFix ? "OCCLUDED" : "NEEDS_HUMAN";
    e.detail = { needsHuman: wall };
    return e;
  };

  // ---- element capture: put the element where a screenshot can see all of
  //      it, and make sure nothing lies on top.
  async function prepareElementCapture(p = {}) {
    const el = resolve(p.ref, p.gen);
    const fits = el.getBoundingClientRect().height <= innerHeight - 16;
    // Centre, not top: a sticky header sits at the top, and an element
    // scrolled there ends up under it.
    el.scrollIntoView({ block: fits ? "center" : "start", inline: "nearest", behavior: "instant" });
    await nextPaint(250);
    const doc = el.ownerDocument;
    const b = el.getBoundingClientRect();
    const w = doc.defaultView;
    const xs = [b.left + 3, b.left + b.width / 2, b.right - 3].map((x) => Math.min(Math.max(x, 1), w.innerWidth - 1));
    const top = Math.min(Math.max(b.top + 3, 1), w.innerHeight - 1);
    const bottom = Math.min(Math.max(b.bottom - 3, 1), w.innerHeight - 1);
    const points = fits ? [...xs.map((x) => [x, top]), ...xs.map((x) => [x, bottom]), [xs[1], (top + bottom) / 2]] : xs.map((x) => [x, top]);
    const overlays = new Set();
    let blocker = null;
    for (const [x, y] of points) {
      const hit = doc.elementFromPoint(x, y);
      if (!hit || hit === el || el.contains(hit) || hit.contains(el)) continue;
      const f = fixedAncestor(hit);
      if (f && !f.contains(el)) overlays.add(f);
      else if (!f) blocker = blocker || hit;
    }
    if (blocker) {
      const wall = detectWall();
      if (wall && (wall.reason === "captcha" || AB.refs.get(wall.node.ref)?.contains(blocker))) throw wallError(wall, "the element is covered");
      const e = new Error(`OCCLUDED: the element is covered by ${selectorOf(blocker)}`);
      e.code = "OCCLUDED";
      e.detail = { occludedBy: selectorOf(blocker), occluder: nodeInfo(blocker) };
      throw e;
    }
    // Fixed and sticky bars over the element are hidden for the capture; the
    // caller restores them (restoreFixed) and the result names them.
    const hidden = AB.hiddenFixed || (AB.hiddenFixed = []);
    for (const o of overlays) {
      hidden.push([o, o.style.getPropertyValue("visibility"), o.style.getPropertyPriority("visibility")]);
      o.style.setProperty("visibility", "hidden", "important");
    }
    if (overlays.size) await nextPaint(150);
    return { ...rectOf(p), fits, hidOverlays: [...overlays].map(selectorOf) };
  }

  // ---- settled pages and change detection.
  function layoutHash() {
    const se = document.scrollingElement || document.documentElement;
    const parts = [se.scrollHeight, innerWidth];
    const add = (el) => {
      const r = el.getBoundingClientRect();
      parts.push(r.x | 0, (r.y + scrollY) | 0, r.width | 0, r.height | 0);
    };
    if (document.body) {
      add(document.body);
      const top = [...document.body.children].slice(0, 40);
      top.forEach(add);
      // An app mounted in one root element: its children are the layout.
      if (top.length <= 3) for (const t of top) [...t.children].slice(0, 40).forEach(add);
    }
    let h = 5381;
    for (const n of parts) h = ((h * 33) ^ n) >>> 0;
    return h.toString(36);
  }

  // documentGeneration: changes on every new document, every same-document
  // URL change, and every large DOM replacement (an SPA swapping its view).
  AB.docId = AB.docId || Math.random().toString(36).slice(2, 8);
  AB.majorGen = AB.majorGen || 0;
  if (!AB.genObserver && document.body) {
    AB.genObserver = new MutationObserver((recs) => {
      for (const r of recs)
        for (const n of r.removedNodes)
          if (n.nodeType === 1 && n.getElementsByTagName("*").length > 25) return void (AB.majorGen += 1);
    });
    AB.genObserver.observe(document.body, { childList: true, subtree: true });
  }
  function pageState() {
    if (AB.lastHref !== location.href) {
      if (AB.lastHref) AB.majorGen += 1;
      AB.lastHref = location.href;
    }
    const se = document.scrollingElement || document.documentElement;
    return { documentGeneration: `${AB.docId}.${AB.majorGen}`, layoutHash: layoutHash(), pageHeight: se.scrollHeight, scrollY: Math.round(scrollY), url: location.href };
  }

  // Wait until nothing is moving: fonts loaded, no finite animation running,
  // layout unchanged and no request finishing for quietMs. Bounded; says why
  // when it gives up. A capture of a page mid-animation is how two shots of
  // "the same page" once differed, and an agent took that for a bug fixed.
  async function settle(p = {}) {
    const maxMs = Math.min(p.maxMs ?? 3000, 15000);
    const quiet = p.quietMs ?? 300;
    const t0 = performance.now();
    let lastRes = t0;
    let po;
    try {
      po = new PerformanceObserver(() => (lastRes = performance.now()));
      po.observe({ type: "resource", buffered: false });
    } catch {}
    let hash = layoutHash();
    let lastChange = t0;
    const running = () =>
      document.getAnimations().filter((a) => {
        if (a.playState !== "running") return false;
        const end = a.effect?.getComputedTiming?.().endTime;
        return Number.isFinite(end);
      });
    let why = "";
    try {
      for (;;) {
        const now = performance.now();
        const h = layoutHash();
        if (h !== hash) {
          hash = h;
          lastChange = now;
        }
        const anims = running();
        why =
          document.readyState !== "complete" ? "the document is still loading"
          : document.fonts?.status === "loading" ? "fonts are still loading"
          : anims.length ? `${anims.length} animation${anims.length > 1 ? "s" : ""} still running`
          : now - lastChange < quiet ? "the layout is still moving"
          : now - lastRes < quiet ? "requests are still finishing"
          : "";
        if (!why) {
          const infinite = document.getAnimations().filter((a) => a.playState === "running").length;
          return { settled: true, settleMs: Math.round(now - t0), ...(infinite ? { infiniteAnimations: infinite } : {}) };
        }
        if (now - t0 >= maxMs) return { settled: false, settleMs: Math.round(now - t0), reason: why };
        await sleep(50);
      }
    } finally {
      po?.disconnect();
    }
  }

  // ---- hover. CSS :hover follows the real mouse, which a page script cannot
  //      move. So: copy every :hover rule the page's stylesheets can be read
  //      for as a [data-ab-hover] rule, and mark the element and its
  //      ancestors. Then check something actually changed; if not, say so.
  const HOVER_ATTR = "data-ab-hover";
  const SELF_ATTRS = new Set([HOVER_ATTR, "data-ab-gesture", "data-ab-captured", "data-ab-ref", "data-ab-dialog", "data-ab-dialog-text"]);
  function hoverCss(doc) {
    let unreadable = 0;
    let rules = 0;
    const collect = (list, out) => {
      for (const r of list) {
        const text = r.cssText;
        if (!text.includes(":hover")) continue;
        if (r.type === CSSRule.STYLE_RULE) {
          out.push(text.replace(/:hover\b/g, `[${HOVER_ATTR}]`));
          rules += 1;
        } else if (r.cssRules) {
          const inner = [];
          collect(r.cssRules, inner);
          if (inner.length) out.push(`${text.slice(0, text.indexOf("{"))}{${inner.join("\n")}}`);
        }
      }
    };
    const out = [];
    for (const sheet of [...doc.styleSheets, ...(doc.adoptedStyleSheets || [])]) {
      if (sheet.ownerNode?.id === "__ab_hover") continue;
      let list;
      try {
        list = sheet.cssRules;
      } catch {
        unreadable += 1; // another origin's stylesheet, served without CORS
        continue;
      }
      collect(list, out);
    }
    return { css: out.join("\n"), rules, unreadable };
  }
  const HOVER_PROPS = ["opacity", "visibility", "display", "background-image", "background-color", "color", "transform", "filter", "box-shadow", "border-color", "text-decoration-line", "outline-style"];
  function styleSnapshot(el) {
    const nodes = [el, ...[...el.querySelectorAll("*")].slice(0, 200)];
    return nodes.map((n) => {
      const cs = getComputedStyle(n);
      return HOVER_PROPS.map((p) => cs.getPropertyValue(p)).join("|");
    });
  }
  function clearHover() {
    for (const d of [document, ...(AB.frameDocs || [])]) {
      try {
        d.querySelectorAll(`[${HOVER_ATTR}]`).forEach((n) => n.removeAttribute(HOVER_ATTR));
        d.getElementById("__ab_hover")?.remove();
      } catch {}
    }
    if (AB.hovered?.isConnected) {
      fire(AB.hovered, "pointerout");
      fire(AB.hovered, "pointerleave", { bubbles: false });
      fire(AB.hovered, "mouseout");
      fire(AB.hovered, "mouseleave", { bubbles: false });
    }
    AB.hovered = null;
  }
  async function emulateHover(el, cx, cy) {
    const doc = el.ownerDocument;
    const before = styleSnapshot(el);
    const { css, rules, unreadable } = hoverCss(doc);
    if (css) {
      const style = doc.createElement("style");
      style.id = "__ab_hover";
      style.textContent = css;
      (doc.head || doc.documentElement).appendChild(style);
    }
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) n.setAttribute(HOVER_ATTR, "");
    AB.hovered = el;
    const at = { clientX: cx, clientY: cy };
    fire(el, "pointerover", at); fire(el, "pointerenter", { ...at, bubbles: false });
    fire(el, "mouseover", at); fire(el, "mouseenter", { ...at, bubbles: false });
    fire(el, "pointermove", at); fire(el, "mousemove", at);
    // Long enough for a transition to have visibly started.
    await sleep(180);
    const after = styleSnapshot(el);
    const styleChanged = after.some((v, i) => v !== before[i]);
    return { styleChanged, hoverRules: rules, ...(unreadable ? { unreadableStylesheets: unreadable } : {}) };
  }

  // ---- drag and pointer sequences. Synthetic events (isTrusted:false): the
  //      only kind a page script can make without CDP.
  function pointIn(el, at) {
    const b = el.getBoundingClientRect();
    const v = (spec, size, start) => {
      if (spec == null) return start + size / 2;
      const s = String(spec).trim();
      return start + (s.endsWith("%") ? (parseFloat(s) / 100) * size : parseFloat(s));
    };
    return { x: v(at?.x, b.width, b.left), y: v(at?.y, b.height, b.top) };
  }
  const captured = (doc) => doc.querySelector("[data-ab-captured]");
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  };
  const modifiersOf = (m = {}) => ({ shiftKey: !!m.shift, ctrlKey: !!m.ctrl, altKey: !!m.alt, metaKey: !!m.meta });

  async function drag(el, p) {
    const doc = el.ownerDocument;
    const steps = Math.max(1, Math.min(p.steps ?? 10, 100));
    const start = pointIn(el, p.at);
    // The target is found here, in the same pass as the source: a second
    // lookup from the server could re-index the page and renumber refs.
    let toEl = p.toRef != null ? resolve(p.toRef) : null;
    if (!toEl && p.toLocator) {
      const m = locate(p.toLocator).matches[0];
      if (!m) {
        const e = new Error(`NO_MATCH: no drop target matching role=${p.toLocator.role ?? "any"} name="${p.toLocator.name ?? ""}"`);
        e.code = "NO_MATCH";
        throw e;
      }
      toEl = AB.refs.get(m.ref);
    }
    const end = toEl ? pointIn(toEl, p.toAt) : p.toPoint ? { x: p.toPoint.x, y: p.toPoint.y } : null;
    if (!end) {
      const e = new Error("BAD_REQUEST: drag needs a target (to: name/ref, or a point)"); e.code = "BAD_REQUEST"; throw e;
    }
    const valueOf = (n) => ("value" in n ? n.value : undefined);
    const before = { from: box(el), ...(toEl ? { to: box(toEl) } : {}), value: valueOf(el), valuenow: el.getAttribute("aria-valuenow") };

    // A range input: its value is where the thumb ends up.
    if (el.tagName === "INPUT" && el.type === "range") {
      const b = el.getBoundingClientRect();
      const min = +el.min || 0, max = el.max === "" ? 100 : +el.max, step = el.step === "any" ? 0 : +el.step || 1;
      let v = min + Math.min(1, Math.max(0, (end.x - b.left) / b.width)) * (max - min);
      if (step) v = min + Math.round((v - min) / step) * step;
      nativeSetter(el).call(el, String(v));
      fire(el, "input");
      fire(el, "change");
    } else {
      const root = doc.documentElement;
      root.setAttribute("data-ab-gesture", "");
      const base = { pointerId: 1, pointerType: p.pointerType || "mouse", isPrimary: true, ...modifiersOf(p.modifiers) };
      const dnd = el.closest('[draggable="true"]') || (el.draggable && el.tagName !== "IMG" && el.tagName !== "A" ? el : null);
      try {
        const at = (x, y) => ({ clientX: x, clientY: y });
        fire(el, "pointerover", at(start.x, start.y)); fire(el, "pointerenter", { ...at(start.x, start.y), bubbles: false });
        fire(el, "pointerdown", { ...base, ...at(start.x, start.y), button: 0, buttons: 1 });
        fire(el, "mousedown", { ...at(start.x, start.y), button: 0, buttons: 1, ...modifiersOf(p.modifiers) });
        if (p.holdMs) await sleep(p.holdMs);
        let dt = null;
        let over = null;
        let accepted = false;
        if (dnd) {
          dt = new DataTransfer();
          dnd.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, composed: true, dataTransfer: dt, ...at(start.x, start.y) }));
        }
        let last = el;
        for (let i = 1; i <= steps; i++) {
          const x = start.x + ((end.x - start.x) * i) / steps;
          const y = start.y + ((end.y - start.y) * i) / steps;
          const hit = captured(doc) || doc.elementFromPoint(x, y) || last;
          if (dnd) {
            const target = doc.elementFromPoint(x, y) || last;
            if (target !== over) {
              target.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, composed: true, dataTransfer: dt, ...at(x, y) }));
              over?.dispatchEvent(new DragEvent("dragleave", { bubbles: true, composed: true, dataTransfer: dt, ...at(x, y) }));
              over = target;
            }
            accepted = !target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, composed: true, dataTransfer: dt, ...at(x, y) }));
            dnd.dispatchEvent(new DragEvent("drag", { bubbles: true, composed: true, dataTransfer: dt, ...at(x, y) }));
          } else {
            fire(hit, "pointermove", { ...base, ...at(x, y), buttons: 1 });
            fire(hit, "mousemove", { ...at(x, y), buttons: 1, ...modifiersOf(p.modifiers) });
          }
          last = hit;
          await sleep(16);
        }
        const finalTarget = captured(doc) || doc.elementFromPoint(end.x, end.y) || last;
        if (dnd) {
          // A browser drops only on a target that accepted the drag (cancelled dragover).
          if (accepted) over.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, composed: true, dataTransfer: dt, ...at(end.x, end.y) }));
          dnd.dispatchEvent(new DragEvent("dragend", { bubbles: true, composed: true, dataTransfer: dt, ...at(end.x, end.y) }));
        }
        fire(finalTarget, "pointerup", { ...base, ...at(end.x, end.y), button: 0, buttons: 0 });
        fire(finalTarget, "mouseup", { ...at(end.x, end.y), button: 0, buttons: 0, ...modifiersOf(p.modifiers) });
        if (dnd && !accepted) AB.dragNote = "the drop target did not accept the drag (no dragover handler cancelled it), so nothing was dropped";
      } finally {
        root.removeAttribute("data-ab-gesture");
        doc.querySelectorAll("[data-ab-captured]").forEach((n) => n.removeAttribute("data-ab-captured"));
      }
    }
    await sleep(60);
    const after = { from: box(el), ...(toEl ? { to: box(toEl) } : {}), value: valueOf(el), valuenow: el.getAttribute("aria-valuenow") };
    const note = AB.dragNote;
    AB.dragNote = null;
    return {
      drag: { start: { x: Math.round(start.x), y: Math.round(start.y) }, end: { x: Math.round(end.x), y: Math.round(end.y) }, steps },
      rects: { before: { from: before.from, to: before.to }, after: { from: after.from, to: after.to } },
      ...(before.value !== after.value ? { value: { before: before.value, after: after.value } } : {}),
      ...(before.valuenow !== after.valuenow ? { valuenow: { before: before.valuenow, after: after.valuenow } } : {}),
      ...(note ? { note } : {}),
    };
  }

  // An explicit sequence of pointer events: down / move / up / wheel.
  async function pointerSequence(el, p) {
    const doc = el ? el.ownerDocument : document;
    const root = doc.documentElement;
    root.setAttribute("data-ab-gesture", "");
    let last = el || doc.body;
    const done = [];
    try {
      for (const s of p.sequence || []) {
        const pt = s.x != null && s.y != null ? { x: s.x, y: s.y } : el ? pointIn(el, s.at) : null;
        if (!pt) {
          const e = new Error("BAD_REQUEST: each step needs x and y, or a target and `at`"); e.code = "BAD_REQUEST"; throw e;
        }
        const target = captured(doc) || doc.elementFromPoint(pt.x, pt.y) || last;
        const mods = modifiersOf(s.modifiers);
        const buttons = s.buttons ?? (s.type === "down" || (s.type === "move" && AB.pointerDown) ? 1 : 0);
        const init = { pointerId: 1, pointerType: s.pointerType || p.pointerType || "mouse", isPrimary: true, clientX: pt.x, clientY: pt.y, buttons, button: s.type === "move" || s.type === "wheel" ? -1 : 0, ...mods };
        const mouse = { clientX: pt.x, clientY: pt.y, buttons, button: init.button < 0 ? 0 : init.button, ...mods };
        if (s.type === "down") {
          AB.pointerDown = true;
          fire(target, "pointerdown", init); fire(target, "mousedown", mouse);
        } else if (s.type === "move") {
          fire(target, "pointermove", init); fire(target, "mousemove", mouse);
        } else if (s.type === "up") {
          AB.pointerDown = false;
          fire(target, "pointerup", init); fire(target, "mouseup", mouse);
        } else if (s.type === "wheel") {
          target.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, composed: true, clientX: pt.x, clientY: pt.y, deltaX: s.deltaX || 0, deltaY: s.deltaY || 0, ...mods }));
        } else {
          const e = new Error(`BAD_REQUEST: unknown pointer step type "${s.type}"`); e.code = "BAD_REQUEST"; throw e;
        }
        done.push({ type: s.type, x: Math.round(pt.x), y: Math.round(pt.y), target: selectorOf(target) });
        last = target;
        await sleep(s.waitMs ?? 16);
      }
    } finally {
      AB.pointerDown = false;
      root.removeAttribute("data-ab-gesture");
      doc.querySelectorAll("[data-ab-captured]").forEach((n) => n.removeAttribute("data-ab-captured"));
    }
    return { pointer: done };
  }

  // Whether the page's own hover styling applies to this element right now —
  // after real input, the honest check that the hover did something.
  function hoverState(p = {}) {
    const el = resolve(p.ref, p.gen);
    return { hovered: el.matches(":hover") };
  }

  // ---- inspect: what a test needs to assert about one element.
  function inspect(p = {}) {
    const el = resolve(p.ref, p.gen);
    const attrs = {};
    for (const a of el.attributes) {
      if (SELF_ATTRS.has(a.name)) continue;
      if (/^(aria-|data-state|data-selected|data-active)/.test(a.name) || ["id", "class", "href", "src", "alt", "title", "type", "name", "role", "disabled", "hidden", "tabindex", "placeholder"].includes(a.name))
        attrs[a.name] = clip(a.value, 200);
    }
    const cs = getComputedStyle(el);
    const b = el.getBoundingClientRect();
    const v = viewRect(el);
    const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
    const top = el.ownerDocument.elementFromPoint(cx, cy);
    const out = {
      ref: p.ref,
      tag: el.tagName.toLowerCase(),
      role: role(el),
      name: accName(el),
      attributes: attrs,
      box: { x: Math.round(v.left + scrollX), y: Math.round(v.top + scrollY), width: Math.round(v.width), height: Math.round(v.height) },
      inViewport: inViewport(el),
      style: { display: cs.display, visibility: cs.visibility, opacity: cs.opacity, pointerEvents: cs.pointerEvents },
      topmostAtCentre: !!top && (top === el || el.contains(top)),
      ...(!top || top === el || el.contains(top) ? {} : { coveredBy: selectorOf(top) }),
      text: clip(el.innerText || el.textContent || "", 300),
    };
    if ("value" in el && el.tagName !== "BUTTON") out.value = isRedacted(el) ? "[redacted]" : clip(String(el.value), 200);
    if (el.type === "checkbox" || el.type === "radio") out.checked = el.checked;
    if (el.tagName === "SELECT") out.selected = [...el.selectedOptions].map((o) => clip(o.text, 60));
    if (el.tagName === "IMG") Object.assign(out, { currentSrc: el.currentSrc, naturalWidth: el.naturalWidth, naturalHeight: el.naturalHeight, complete: el.complete });
    if (el.tagName === "VIDEO" || el.tagName === "AUDIO")
      Object.assign(out, { media: { ...mediaState(el), src: el.currentSrc || el.getAttribute("src") || "", ...(el.tagName === "VIDEO" ? { videoWidth: el.videoWidth, videoHeight: el.videoHeight } : {}), muted: el.muted, loop: el.loop } });
    if (el.tagName === "A") out.href = el.href;
    return out;
  }

  // ---- diagnostics from the page: console and exceptions (from the
  //      page-world hook on development hosts), media load failures (here).
  AB.diag = AB.diag || [];
  const pushDiag = (entry) => {
    const key = `${entry.ts}|${entry.kind}|${entry.text}`;
    if (AB.diag.some((d) => d.key === key)) return;
    AB.diag.push({ ...entry, key });
    if (AB.diag.length > 200) AB.diag.shift();
  };
  if (!AB.diagListening) {
    AB.diagListening = true;
    window.addEventListener("ab-diag", (e) => pushDiag(e.detail || {}));
    // A <video> or <audio> that fails to load fires `error` on itself (or its
    // <source>); it does not bubble, so listen while it travels down.
    document.addEventListener(
      "error",
      (e) => {
        const t = e.target;
        const media = t instanceof HTMLMediaElement ? t : t instanceof HTMLSourceElement ? t.parentElement : null;
        if (!media) return;
        pushDiag({
          ts: Date.now(),
          kind: "media",
          level: "error",
          text: `${media.tagName.toLowerCase()} failed to load${media.error ? ` (MediaError ${media.error.code}${media.error.message ? ": " + media.error.message : ""})` : ""}`,
          source: clip(t.currentSrc || t.src || t.getAttribute("src") || "", 200),
        });
      },
      true,
    );
    window.addEventListener("ab-credential", (e) => {
      AB.credentials = AB.credentials || [];
      AB.credentials.push(e.detail);
    });
    window.dispatchEvent(new CustomEvent("ab-diag-flush"));
  }
  function diagnostics(p = {}) {
    const since = p.since || 0;
    const list = AB.diag.filter((d) => d.ts >= since).map(({ key: _k, replay: _r, ...d }) => d);
    return { console: list.filter((d) => d.kind !== "media"), media: list.filter((d) => d.kind === "media") };
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
          sendResponse({ pong: true, url: location.href, title: document.title, ts: Date.now(), documentGeneration: pageState().documentGeneration });
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
        else if (m === "settle") sendResponse(await settle(msg.params));
        else if (m === "pageState") sendResponse(pageState());
        else if (m === "prepareElementCapture") sendResponse(await prepareElementCapture(msg.params));
        else if (m === "inspect") sendResponse(inspect(msg.params));
        else if (m === "hoverState") sendResponse(hoverState(msg.params));
        else if (m === "detectWall") sendResponse({ needsHuman: detectWall() });
        else if (m === "diagnostics") sendResponse(diagnostics(msg.params));
        else if (m === "clearMarks") {
          clearMarks();
          sendResponse({ ok: true });
        } else sendResponse({ error: `unknown engine method: ${m}` });
      } catch (e) {
        sendResponse({ error: String((e && e.message) || e), code: e && e.code, ...(e && e.detail ? { detail: e.detail } : {}) });
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
