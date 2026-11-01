export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function str(field: string): (args: unknown) => string | null {
  return (args) => {
    if (!isRecord(args)) return `${field}: expected object args`;
    const v = args[field];
    return typeof v === "string" && v.length > 0 ? null : `${field}: expected non-empty string`;
  };
}

export function strMax(field: string, maxLen: number): (args: unknown) => string | null {
  return (args) => {
    if (!isRecord(args)) return `${field}: expected object args`;
    const v = args[field];
    return typeof v === "string" && v.length > 0 && v.length <= maxLen
      ? null
      : `${field}: expected string of 1..${maxLen} chars`;
  };
}

export function optStr(field: string, maxLen = 100_000): (args: unknown) => string | null {
  return (args) => {
    if (!isRecord(args)) return `${field}: expected object args`;
    const v = args[field];
    if (v === undefined) return null;
    return typeof v === "string" && v.length <= maxLen
      ? null
      : `${field}: expected string <= ${maxLen} chars`;
  };
}

export function num(field: string): (args: unknown) => string | null {
  return (args) => {
    if (!isRecord(args)) return `${field}: expected object args`;
    const v = args[field];
    return typeof v === "number" && Number.isFinite(v) ? null : `${field}: expected number`;
  };
}

export function optNum(field: string): (args: unknown) => string | null {
  return (args) => {
    if (!isRecord(args)) return `${field}: expected object args`;
    const v = args[field];
    if (v === undefined) return null;
    return typeof v === "number" && Number.isFinite(v) ? null : `${field}: expected number`;
  };
}

export function bool(field: string): (args: unknown) => string | null {
  return (args) => {
    if (!isRecord(args)) return `${field}: expected object args`;
    return typeof args[field] === "boolean" ? null : `${field}: expected boolean`;
  };
}

export function optBool(field: string): (args: unknown) => string | null {
  return (args) => {
    if (!isRecord(args)) return `${field}: expected object args`;
    const v = args[field];
    if (v === undefined) return null;
    return typeof v === "boolean" ? null : `${field}: expected boolean`;
  };
}

export function oneOf(field: string, values: string[]): (args: unknown) => string | null {
  return (args) => {
    if (!isRecord(args)) return `${field}: expected object args`;
    const v = args[field];
    return typeof v === "string" && values.includes(v)
      ? null
      : `${field}: expected one of ${values.join(", ")}`;
  };
}

export function arr(
  field: string,
  itemCheck: (v: unknown, i: number) => string | null,
): (args: unknown) => string | null {
  return (args) => {
    if (!isRecord(args)) return `${field}: expected object args`;
    const v = args[field];
    if (!Array.isArray(v)) return `${field}: expected array`;
    for (let i = 0; i < v.length; i++) {
      const err = itemCheck(v[i], i);
      if (err) return `${field}[${i}]: ${err}`;
    }
    return null;
  };
}

// optArr validates an optional array field: absent is fine, present must match
// itemCheck for every entry.
export function optArr(
  field: string,
  itemCheck: (v: unknown, i: number) => string | null,
): (args: unknown) => string | null {
  return (args) => {
    if (!isRecord(args)) return `${field}: expected object args`;
    const v = args[field];
    if (v === undefined) return null;
    if (!Array.isArray(v)) return `${field}: expected array`;
    if (v.length > 100) return `${field}: too many entries (${v.length} > 100)`;
    for (let i = 0; i < v.length; i++) {
      const err = itemCheck(v[i], i);
      if (err) return `${field}[${i}]: ${err}`;
    }
    return null;
  };
}

export function compose(
  ...checks: ((args: unknown) => string | null)[]
): (args: unknown) => string | null {
  return (args) => {
    for (const c of checks) {
      const err = c(args);
      if (err) return err;
    }
    return null;
  };
}

export function rejectUnknown(maxKeys = 12): (args: unknown) => string | null {
  return (args) => {
    if (!isRecord(args)) return "expected object args";
    const keys = Object.keys(args);
    if (keys.length > maxKeys) return `too many arg fields (${keys.length} > ${maxKeys})`;
    return null;
  };
}
