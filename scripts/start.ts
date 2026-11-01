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
      const rest = line.slice(2);
      const im = rest.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
      if (!im) {
        (top.obj as unknown[]).push(rest.replace(/^"(.*)"$/, "$1"));
        continue;
      }
      const item: Record<string, unknown> = {};
      (top.obj as unknown[]).push(item);
      item[im[1]] = im[2] === "" ? {} : im[2].replace(/^"(.*)"$/, "$1");
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
  if (name === "mistral") {
    // documents.stage writes into the staging root; signed URLs point at Azure blob
    // storage, which is a different host from the API origin.
    const staging = String(c.stagingRoot ?? "data/staging");
    fsReadPaths.add(staging);
    fsWritePaths.add(staging);
    netHosts.add("*.blob.core.windows.net");
  }
  if (name === "dev" || name === "deploy") {
    for (const r of (c.roots ?? []) as Array<Record<string, unknown>>) {
      const p = String(r.path);
      fsReadPaths.add(p);
      fsWritePaths.add(p);
    }
    if (c.path) fsReadPaths.add(String(c.path));
  }
  if (name === "deploy" && c.liveDir) {
    fsReadPaths.add(String(c.liveDir));
    fsWritePaths.add(String(c.liveDir));
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
  "SKILL.md",
  "src/",
  "scripts/",
  ...fsReadPaths,
].join(",");
const allowWrite = ["data/", ...fsWritePaths].join(",");
// fs.exec spawns `/bin/sh` and, on Linux, wraps it in `/usr/bin/setsid` so the
// timeout can kill the whole process group; `/bin/kill` is the fallback used to
// signal that group when Deno.kill is not permitted.
const execBins = [
  "/bin/sh",
  ...(Deno.build.os === "linux" ? ["/usr/bin/setsid", "/bin/kill"] : []),
];
// dev runs a project's declared argv tables (deno/git/…); deploy runs git and the
// dev root's test task. Both are explicit connector opt-ins, never defaults.
const connectorBins: string[] = [];
if (connectors.dev?.enabled === true || connectors.dev?.enabled === "true") {
  connectorBins.push("deno", "git");
}
if (connectors.deploy?.enabled === true || connectors.deploy?.enabled === "true") {
  connectorBins.push("deno", "git");
}
const allowRun = [...new Set([...(fsExecRoots.size > 0 ? execBins : []), ...connectorBins])];
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
