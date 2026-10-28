// Page world (MAIN), at document_start: the few things the agent needs the
// page's own functions to do differently, and nothing a page can see.
//
//   - alert / confirm / prompt answer by themselves, as the agent chose for
//     the action in progress (accept by default), and say what they asked;
//   - beforeunload cannot hold the agent on a page;
//   - navigator.credentials.store saves nothing (this profile keeps everything);
//   - setPointerCapture accepts a synthetic pointer, so a slider or scrubber a
//     drag grabs follows it — and announces the capture the way the browser
//     does, with gotpointercapture, which is how the engine learns of it.
//
// Every replaced function is a Proxy of the original and reads as native code
// (the same disguise as net-hook.js, layered so either may load first). Nothing
// goes on window, on <html>, or out under a fixed event name: messages travel
// on the per-document channel the relay (net-relay.js) hands out.
(() => {
  const W = window;
  const apply = Reflect.apply;
  const FnProto = Function.prototype;
  const WM = WeakMap;
  const wmGet = WM.prototype.get;
  const wmSet = WM.prototype.set;
  const WS = WeakSet;
  const wsHas = WS.prototype.has;
  const wsAdd = WS.prototype.add;
  const wsDel = WS.prototype.delete;
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const now = Date.now;
  const dispatch = EventTarget.prototype.dispatchEvent;
  const addEL = EventTarget.prototype.addEventListener;
  const removeEL = EventTarget.prototype.removeEventListener;
  const CE = CustomEvent;
  const PE = W.PointerEvent;
  const P = Promise;
  const doc = document;
  const loc = location;
  const get = (m, k) => apply(wmGet, m, [k]);
  const put = (m, k, v) => apply(wmSet, m, [k, v]);
  const on = (t, type, fn, capture) => apply(addEL, t, [type, fn, capture]);

  try {
    if (W !== W.top && W.top.location.origin !== loc.origin) return;
  } catch {
    return;
  }

  // ---- disguise (a layer over whatever toString is there: native, or net-hook's)
  const originals = new WM();
  const prevToString = FnProto.toString;
  const tsProxy = new Proxy(prevToString, {
    apply(target, self, args) {
      const orig = get(originals, self);
      return apply(target, orig === undefined ? self : orig, args);
    },
  });
  put(originals, tsProxy, prevToString);
  FnProto.toString = tsProxy;
  const scrub = (e) => {
    try {
      if (e && typeof e.stack === "string" && e.stack.includes("chrome-extension://")) {
        e.stack = e.stack.split("\n").filter((l) => !l.includes("chrome-extension://")).join("\n");
      }
    } catch {}
    return e;
  };
  const disguise = (orig, handler) => {
    const p = new Proxy(orig, handler);
    put(originals, p, orig);
    return p;
  };

  // ---- channel (see net-hook.js for why not postMessage)
  let channel = null;
  const pending = [];
  const send = (rec) => {
    rec.ts ??= now();
    if (!channel) {
      if (pending.length < 50) pending.push(rec);
      return;
    }
    try {
      apply(dispatch, doc, [new CE(channel, { detail: stringify([rec]) })]);
    } catch {}
  };
  // What the agent chose for the action in progress: sent by the engine.
  const choice = { dialog: "accept", dialogText: undefined };
  const HELLO = "ab-net-hello";
  const onHello = (e) => {
    if (channel || typeof e.detail !== "string" || e.detail === "hook") return;
    let msg;
    try {
      msg = parse(e.detail);
    } catch {
      return;
    }
    if (!msg || typeof msg.channel !== "string") return;
    channel = msg.channel;
    apply(removeEL, doc, [HELLO, onHello]);
    on(doc, channel + ":cfg", (c) => {
      try {
        const m = parse(c.detail);
        if (m.dialog) choice.dialog = m.dialog === "dismiss" ? "dismiss" : "accept";
        if ("dialogText" in m) choice.dialogText = m.dialogText ?? undefined;
      } catch {}
    });
    for (const r of pending.splice(0)) send(r);
  };
  on(doc, HELLO, onHello);
  try {
    apply(dispatch, doc, [new CE(HELLO, { detail: "hook" })]);
  } catch {}
  on(doc, "DOMContentLoaded", () => apply(removeEL, doc, [HELLO, onHello]));

  // ---- native dialogs
  const str = (m) => {
    try {
      return String(m ?? "");
    } catch {
      return "";
    }
  };
  const report = (kind, message, answer) => send({ kind: "dialog", dialog: kind, message: str(message).slice(0, 500), answer });
  if (W.alert) {
    W.alert = disguise(W.alert, {
      apply(_t, _self, args) {
        report("alert", args[0], "ok");
      },
    });
  }
  if (W.confirm) {
    W.confirm = disguise(W.confirm, {
      apply(_t, _self, args) {
        const ok = choice.dialog !== "dismiss";
        report("confirm", args[0], ok ? "ok" : "cancel");
        return ok;
      },
    });
  }
  if (W.prompt) {
    W.prompt = disguise(W.prompt, {
      apply(_t, _self, args) {
        if (choice.dialog === "dismiss") {
          report("prompt", args[0], null);
          return null;
        }
        const text = choice.dialogText ?? (args[1] === undefined ? "" : str(args[1]));
        report("prompt", args[0], text);
        return text;
      },
    });
  }
  try {
    on(
      W,
      "beforeunload",
      (e) => {
        e.stopImmediatePropagation();
        try {
          delete e.returnValue;
        } catch {}
      },
      true,
    );
  } catch {}

  // ---- credentials.store, on the prototype (an own property would show)
  try {
    const CC = W.CredentialsContainer?.prototype;
    if (CC && typeof CC.store === "function") {
      CC.store = disguise(CC.store, {
        apply(_t, _self, args) {
          const cred = args[0];
          send({ kind: "credential", what: "credentials.store", type: str(cred?.type), id: str(cred?.id) });
          return P.resolve(undefined);
        },
      });
    }
  } catch {}

  // ---- pointer capture for synthetic pointers
  // The browser throws for a pointer it does not know, and every synthetic one
  // is unknown. Only then, and only when the pointer that went down was
  // synthetic, accept the capture: a person's pointer is untouched.
  const E = W.Element?.prototype;
  if (E && E.setPointerCapture && PE) {
    let lastSynthetic = false;
    on(W, "pointerdown", (e) => (lastSynthetic = !e.isTrusted), true);
    const captured = new WS();
    const announce = (el, type, pointerId) => {
      try {
        apply(dispatch, el, [new PE(type, { pointerId, bubbles: true, composed: true })]);
      } catch {}
    };
    E.setPointerCapture = disguise(E.setPointerCapture, {
      apply(target, el, args) {
        try {
          return apply(target, el, args);
        } catch (e) {
          if (!lastSynthetic) throw scrub(e);
          apply(wsAdd, captured, [el]);
          announce(el, "gotpointercapture", args[0]);
        }
      },
    });
    E.releasePointerCapture = disguise(E.releasePointerCapture, {
      apply(target, el, args) {
        if (apply(wsHas, captured, [el])) {
          apply(wsDel, captured, [el]);
          announce(el, "lostpointercapture", args[0]);
          return;
        }
        try {
          return apply(target, el, args);
        } catch (e) {
          throw scrub(e);
        }
      },
    });
    E.hasPointerCapture = disguise(E.hasPointerCapture, {
      apply(target, el, args) {
        return apply(wsHas, captured, [el]) || apply(target, el, args);
      },
    });
  }
})();
