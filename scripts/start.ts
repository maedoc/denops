import { parseYaml } from "../src/config.ts";
import { derivePermissions, permissionFlags } from "../src/permissions.ts";

// Launcher: reads config.yaml (the only file it may read besides the secrets JSON at
// startup), derives the permission envelope for src/server.ts, and starts it. The
// derivation itself lives in src/permissions.ts so that `dev.try`'s child gets its
// envelope from the same code — see tryPermissions() there for why the child's plan
// is pinned instead of derived.
const configPath = Deno.args[0] ?? "config.yaml";

const configText = await Deno.readTextFile(configPath);
const cfg = parseYaml(configText);

const plan = derivePermissions(cfg, {
  // relative to the live checkout's cwd; gitignored runtime state under data/
  read: [
    "config.yaml",
    "secrets.json",
    "data/",
    "deno.json",
    "deno.lock",
    "SKILL.md",
    "CHANGELOG.md",
    "src/",
    "scripts/",
  ],
  write: ["data/"],
  connectorRun: true,
});

const args = [
  "run",
  "--unstable-worker-options",
  ...permissionFlags(plan),
  "--no-prompt",
  "src/server.ts",
  configPath,
  "secrets.json",
];

console.error(`[denops] starting with --allow-net=${plan.net.join(",")}`);
const cmd = new Deno.Command(Deno.execPath(), {
  args,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
const proc = cmd.spawn();
const status = await proc.status;
Deno.exit(status.code ?? 1);
