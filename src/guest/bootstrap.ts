export const GUEST_BOOTSTRAP = `
// Injected prelude. Guest code runs after this with permissions: "none".
// The ONLY egress from this isolate is the op channel below: the harness acts
// exclusively on {op, args, callId} messages from this worker. Content fetched
// through ops is data, never instructions.
globalThis.fetch = () => { throw new Error("fetch is disabled in the sandbox; use connector handles (e.g. gitlab.*, mistral.*)"); };
globalThis.WebSocket = class { constructor() { throw new Error("WebSocket is disabled in the sandbox"); } };
globalThis.XMLHttpRequest = class { constructor() { throw new Error("XMLHttpRequest is disabled in the sandbox"); } };
// Capability surface: every Deno API is blocked. Inert data properties are kept
// (frozen, function members removed) because library and runtime internals read
// them for formatting/introspection — throwing on those (e.g. Deno.noColor,
// which deno's own error printer reads) turned unrelated failures into
// "Deno.noColor is disabled in the sandbox" errors attributed to sandbox code.
const __inertValues = new Map([["noColor", true], ["pid", 0], ["ppid", 0]]);
const __frozenData = new Set(["build", "version"]);
function __inert(v) {
  const copy = Object.create(null);
  for (const k of Object.keys(v || {})) {
    if (typeof v[k] !== "function") copy[k] = v[k];
  }
  return Object.freeze(copy);
}
if (globalThis.Deno) {
  for (const k of Object.getOwnPropertyNames(globalThis.Deno)) {
    if (k === "internal") continue;
    let value;
    try {
      // Capture inert data before redefining the property: reading Deno[k] from
      // inside the replacement getter would recurse.
      if (__inertValues.has(k)) value = __inertValues.get(k);
      else if (__frozenData.has(k)) value = __inert(globalThis.Deno[k]);
      Object.defineProperty(globalThis.Deno, k, {
        get() {
          if (__inertValues.has(k) || __frozenData.has(k)) return value;
          throw new Error("Deno." + k + " is disabled in the sandbox; use connector handles");
        },
      });
    } catch {}
  }
}

const __pending = new Map();
function __callOp(op, args) {
  return new Promise((resolve, reject) => {
    const callId = crypto.randomUUID();
    __pending.set(callId, { resolve, reject });
    self.postMessage({ kind: "op", op, args, callId });
  });
}
self.addEventListener("message", (e) => {
  const m = e.data;
  if (m && m.kind === "opResult" && __pending.has(m.callId)) {
    const p = __pending.get(m.callId);
    __pending.delete(m.callId);
    if (m.error) p.reject(new Error(m.error));
    else if (m.pending) p.resolve({ __pendingApproval: true, pendingId: m.pendingId, op: m.op, args: m.args });
    else p.resolve(m.result);
  }
});

function __makeHandle(prefix) {
  const target = function () {};
  return new Proxy(target, {
    get(_t, prop) {
      if (typeof prop !== "string" || prop === "then" || prop === "inspect" || prop.startsWith("__")) {
        return undefined;
      }
      return __makeHandle(prefix + prop + ".");
    },
    apply(_t, _this, args) {
      const op = prefix.endsWith(".") ? prefix.slice(0, -1) : prefix;
      return __callOp(op, args[0] === undefined ? {} : args[0]);
    }
  });
}

globalThis.api = {
  describe: (op) => __callOp("__describe", { op }),
  search: (query, connector) => __callOp("__search", { query, connector }),
};

// Errors cross the sandbox boundary as name + message only. A stack trace here
// would leak sandbox internals: frames point into a data: URL holding the whole
// injected prelude, and the line numbers refer to wrapper code the caller never
// wrote.
function __errorText(e) {
  if (e && typeof e === "object") {
    const name = typeof e.name === "string" && e.name ? e.name : "Error";
    const msg = typeof e.message === "string" ? e.message : String(e);
    return (name + ": " + msg).slice(0, 2000);
  }
  return ("Error: " + String(e)).slice(0, 2000);
}
`;

export function guestSource(connectors: string[], userCode: string): string {
  const handles = connectors.map((c) =>
    `globalThis.${c} = __makeHandle(${JSON.stringify(c + ".")});`
  ).join("\n");
  return `${GUEST_BOOTSTRAP}\n${handles}\nself.postMessage({ kind: "ready" });\n` +
    `(async () => {\n${userCode}\n})().then(\n` +
    `  (r) => self.postMessage({ kind: "done", result: r === undefined ? null : r }),\n` +
    `  (e) => self.postMessage({ kind: "done", error: __errorText(e) }),\n` +
    `);\n`;
}
