import { caldavConnector } from "../src/connectors/caldav/manifest.ts";
import { davConnector } from "../src/connectors/dav/manifest.ts";
import { deployConfigFrom, deployConnector } from "../src/connectors/deploy/manifest.ts";
import { devConnector, devRootsFromConfig } from "../src/connectors/dev/manifest.ts";
import { denopsConnector } from "../src/connectors/denops/manifest.ts";
import { forgeConnector } from "../src/connectors/forge/manifest.ts";
import { fsConnector } from "../src/connectors/fs/manifest.ts";
import { imapConnector } from "../src/connectors/imap/manifest.ts";
import { mistralConnector } from "../src/connectors/mistral/manifest.ts";
import { webConnector } from "../src/connectors/web/manifest.ts";
import type { Connector } from "../src/harness/types.ts";
import { stubPort } from "./forge_stub.ts";

/**
 * One registry-shaped set of every connector family, for the doc-drift tests.
 *
 * It lives here rather than inside one test file because two gates need the same
 * answer: SKILL.md (the prompt-facing sheet) and README.md (the human-facing one).
 * Duplicating the list is how the README came to claim `gitlab (27 ops)` a release
 * after that family was renamed to `forge`, and how `calendar` went unverified.
 */
export async function allConnectors(): Promise<Connector[]> {
  const tmp = await Deno.makeTempDir();
  const devRoots = devRootsFromConfig([{
    name: "devroot",
    path: tmp,
    tasks: { test: ["/usr/bin/true"] },
  }]);
  const deploy = deployConfigFrom(
    { enabled: true, liveDir: tmp, devBranch: "main" },
    devRoots,
    tmp,
  );
  const skillPath = new URL("../SKILL.md", import.meta.url).pathname;
  return [
    forgeConnector({
      accounts: [{
        id: "ebrains",
        flavor: "gitlab",
        origin: "https://gitlab.example",
        apiPath: "/api/v4",
        token: "t",
        maxLimit: 100,
      }],
      buildPort: () => stubPort(),
    }),
    mistralConnector({ apiKey: "k", origin: "https://api.mistral.ai", apiPath: "/v1" }),
    imapConnector({
      accounts: [{
        id: "a",
        host: "imap.example.org",
        port: 993,
        tls: true,
        user: "u",
        password: "p",
        draftsMailbox: "Drafts",
      }],
    }),
    fsConnector({
      roots: [{ name: "r", path: tmp, write: true, exec: false }],
      maxFileSize: 1024,
      maxOutput: 1024,
      execTimeoutSec: 5,
      maxConcurrentExec: 1,
    }),
    devConnector({ roots: devRoots }),
    webConnector({ allowedHosts: ["example.org"] }),
    davConnector({
      accounts: [{
        id: "nc",
        origin: "https://nc.example.org",
        shareRoot: "/remote.php/dav/files/u",
        user: "u",
        auth: "basic",
        password: "p",
        writable: true,
        nextcloud: true,
      }],
      stagingRoot: tmp,
    }),
    caldavConnector({
      accounts: [{
        id: "cal",
        origin: "https://cal.example.org",
        user: "u",
        auth: "basic",
        password: "p",
      }],
    }),
    ...(deploy ? [deployConnector(deploy)] : []),
    denopsConnector({ skillPath, version: "0.3.0", connectors: () => [] }),
  ];
}
