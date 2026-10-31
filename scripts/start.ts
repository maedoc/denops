const configPath = Deno.args[0] ?? "config.yaml";

function parseYaml(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const stack: {
    indent: number;
    obj: Record<string, unknown> | unknown[];
    parent?: Record<string, unknown>;
    key?: string;
  }[] = [{ indent: -1, obj: root }];
  for (const raw of text.split("\n")) {
    const noComment = raw.replace(/\s+#.*$/, "");
    if (!noComment.trim()) continue;
    const indent = noComment.length - noComment.trimStart().length;
    const line = noComment.trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const top = stack[stack.length - 1];
    if (line.startsWith("- ")) {
      if (!Array.isArray(top.obj)) {
        if (top.parent === undefined || Object.keys(top.obj).length > 0) continue;
        const arr: unknown[] = [];
        top.parent[top.key as string] = arr;
        top.obj = arr;
      }
      const item: Record<string, unknown> = {};
      (top.obj as unknown[]).push(item);
      const im = line.slice(2).match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
      if (im) item[im[1]] = im[2] === "" ? {} : im[2].replace(/^"(.*)"$/, "$1");
      stack.push({ indent: indent + 1, obj: item });
      continue;
    }
    const parent = top.obj as Record<string, unknown>;
    const m = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!m) continue;
    if (m[2] === "") {
      const child: Record<string, unknown> = {};
      parent[m[1]] = child;
      stack.push({ indent, obj: child, parent, key: m[1] });
    } else {
      parent[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
    }
  }
  return root;
}

const configText = await Deno.readTextFile(configPath);
const cfg = parseYaml(configText);
const server = (cfg.server ?? {}) as Record<string, unknown>;
const host = String(server.host ?? "127.0.0.1");
const port = String(server.port ?? "3100");
const connectors = (cfg.connectors ?? {}) as Record<string, Record<string, unknown>>;

const netHosts = new Set<string>([`${host}:${port}`]);
const fsReadPaths = new Set<string>();
const fsWritePaths = new Set<string>();
const fsExecRoots = new Set<string>();
for (const [name, c] of Object.entries(connectors)) {
  if (c.enabled !== true && c.enabled !== "true") continue;
  if (c.origin) netHosts.add(new URL(String(c.origin)).host);
  if (name === "imap") {
    for (const acc of (c.accounts ?? []) as Array<Record<string, unknown>>) {
      netHosts.add(`${acc.host}:${acc.port ?? 993}`);
    }
  }
  if (name === "fs") {
    for (const r of (c.roots ?? []) as Array<Record<string, unknown>>) {
      const p = String(r.path);
      fsReadPaths.add(p);
      if (r.write === true || r.write === "true") fsWritePaths.add(p);
      if (r.exec === true || r.exec === "true") fsExecRoots.add(p);
    }
  }
}

const allowNet = [...netHosts].join(",");
const allowRead = [
  "config.yaml",
  "secrets.json",
  "data/",
  "deno.json",
  "deno.lock",
  "src/",
  "scripts/",
  ...fsReadPaths,
].join(",");
const allowWrite = ["data/", ...fsWritePaths].join(",");
const allowRun = fsExecRoots.size > 0 ? ["/bin/sh", ...[...fsExecRoots].map(() => "/bin/sh")] : [];
const args = [
  "run",
  "--unstable-worker-options",
  `--allow-net=${allowNet}`,
  `--allow-read=${allowRead}`,
  `--allow-write=${allowWrite}`,
  "--allow-env",
  "--allow-sys",
  ...(allowRun.length > 0 ? [`--allow-run=${[...new Set(allowRun)].join(",")}`] : []),
  "--no-prompt",
  "src/server.ts",
  configPath,
  "secrets.json",
];

console.error(`[denops] starting with --allow-net=${allowNet}`);
const cmd = new Deno.Command(Deno.execPath(), {
  args,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
const proc = cmd.spawn();
const status = await proc.status;
Deno.exit(status.code ?? 1);
