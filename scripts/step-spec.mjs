// `--step` for `npm run ab -- jobs start`, one per step, in order:
//
//   dismiss-consent               click the accept button of a cookie/consent banner, if one shows
//   click:Today                   click the element named "Today"
//   click?:Accept all             "?" — skip it when it is not there
//   fill:Search:jackets           type "jackets" into the field named "Search"
//   fill:Password:@shop-login     type the approved secret "shop-login" (npm run ab -- secrets set)
//   press:Search:Enter            press Enter in the field named "Search"
//   wait:Reading                  wait until "Reading" is on the page
//
// The name and value are split at the first two colons; a role can be given
// as name@role ("Today@tab").

const ACTIONS = new Set(["click", "fill", "type", "select", "check", "uncheck", "press", "wait", "dismiss-consent"]);

export function parseStep(spec) {
  const s = String(spec);
  const first = s.indexOf(":");
  let action = first < 0 ? s : s.slice(0, first);
  const rest = first < 0 ? "" : s.slice(first + 1);
  const optional = action.endsWith("?");
  if (optional) action = action.slice(0, -1);
  if (!ACTIONS.has(action)) throw new Error(`--step ${s}: the action is one of ${[...ACTIONS].join(", ")}`);
  const step = { action, ...(optional ? { optional: true } : {}) };
  if (action === "dismiss-consent") return step;
  if (action === "wait") return { ...step, text: rest };
  const second = rest.indexOf(":");
  let name = second < 0 ? rest : rest.slice(0, second);
  const value = second < 0 ? undefined : rest.slice(second + 1);
  const at = name.lastIndexOf("@");
  if (at > 0) {
    step.role = name.slice(at + 1);
    name = name.slice(0, at);
  }
  if (name) step.name = name;
  if (value !== undefined) {
    if (value.startsWith("@") && (action === "fill" || action === "type")) step.secret = value.slice(1);
    else step.value = value;
  }
  return step;
}
