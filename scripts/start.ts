const configPath = Deno.args[0] ?? "config.yaml";

function parseYaml(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const stack: { indent: number; obj: Record<string, unknown> }[] = [{ indent: -1, obj: root }];
  for (const raw of text.split("\n")) {
    const noComment = raw.replace(/\s+#.*$/, "");
    if (!noComment.trim()) continue;
    const indent = noComment.length - noComment.trimStart().length;
    const line = noComment.trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].obj;
    const m = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!m) continue;
    if (m[2] === "") {
      const child: Record<string, unknown> = {};
      parent[m[1]] = child;
      stack.push({ indent, obj: child });
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
for (const [name, c] of Object.entries(connectors)) {
  if (c.enabled !== true && c.enabled !== "true") continue;
  if (c.origin) netHosts.add(new URL(String(c.origin)).host);
  if (name === "imap") {
    for (const acc of (c.accounts ?? []) as Array<Record<string, unknown>>) {
      netHosts.add(`${acc.host}:${acc.port ?? 993}`);
    }
  }
}

const allowNet = [...netHosts].join(",");
const args = [
  "run",
  "--unstable-worker-options",
  `--allow-net=${allowNet}`,
  "--allow-read=config.yaml,secrets.json,data/,deno.json,deno.lock,src/,scripts/",
  "--allow-write=data/",
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
