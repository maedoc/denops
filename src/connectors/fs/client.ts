import type { JsonValue } from "../../harness/types.ts";
import type { FsRootConfig } from "./manifest.ts";

interface FsClientOpts {
  roots: FsRootConfig[];
  maxFileSize: number;
  maxOutput: number;
  execTimeoutSec: number;
  maxConcurrentExec: number;
}

interface ExecResult {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
}

// killExecGroup SIGKILLs the process group of a setsid-spawned exec child.
//
// `<pid>` is the pid of a child spawned through /usr/bin/setsid, which
// guarantees it leads its own process group (setsid only forks when the child
// already is a group leader, which cannot happen for a freshly spawned child).
// The negative pid therefore names that child's group and nothing else: if the
// guarantee ever broke, the group would simply not exist and kill would be a
// no-op. Pids 0 and 1 are never passed, so the kill can never reach our own
// group or init.
//
// The `--` separator is load-bearing. Passing a negative pid without it is
// unsafe: Ubuntu's /bin/kill is procps-ng, which re-parses such an argument and
// truncates it to its first digit, so `kill -KILL -19567` becomes
// kill(-1, SIGKILL) — SIGKILL to every process the caller may signal, which
// takes the whole login session (and any detached runs) down with it.
//
// /bin/kill is tried first because the server runs with a scoped --allow-run
// list that does not cover Deno.kill; Deno.kill covers setups where kill(1) is
// not on that list.
function killExecGroup(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    new Deno.Command("/bin/kill", {
      args: ["-KILL", "--", "-" + String(pid)],
      stdout: "null",
      stderr: "null",
    }).outputSync();
    return true;
  } catch { /* kill(1) not permitted, or gone */ }
  try {
    Deno.kill(-pid, "SIGKILL");
    return true;
  } catch {
    return false;
  }
}

// FSClient implements the host side of the fs.* ops. Confinement: every path
// is resolved against the configured root's real path; anything escaping it
// (traversal or symlink) is rejected. Exec runs with a scrubbed environment so
// no process env (incl. secrets) leaks into child processes.
export class FSClient {
  private roots = new Map<string, { cfg: FsRootConfig; real: string }>();
  private execSlots: Promise<void>[] = [];
  private execRunning = 0;

  constructor(private opts: FsClientOpts) {
    for (const r of opts.roots) {
      this.roots.set(r.name, { cfg: r, real: "" });
    }
  }

  private async rootReal(name: string): Promise<{ cfg: FsRootConfig; real: string }> {
    const entry = this.roots.get(name);
    if (!entry) throw new Error(`unknown fs root: ${JSON.stringify(name)}`);
    if (!entry.real) {
      entry.real = await Deno.realPath(entry.cfg.path);
    }
    return entry;
  }

  private async resolve(rootName: string, rel: string): Promise<string> {
    if (typeof rel !== "string" || rel.trim() === "") throw new Error("path must not be empty");
    if (rel.startsWith("/") || rel.includes("\\")) {
      throw new Error(`path must be relative to the root, got ${JSON.stringify(rel)}`);
    }
    const { real } = await this.rootReal(rootName);
    const kept: string[] = [];
    for (const seg of rel.split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") {
        if (kept.length === 0) {
          throw new Error(`path ${JSON.stringify(rel)} escapes root ${JSON.stringify(rootName)}`);
        }
        kept.pop();
        continue;
      }
      kept.push(seg);
    }
    const naive = kept.join("/");
    const norm = naive === "" ? real : `${real}/${naive}`;
    let resolved: string;
    try {
      resolved = await Deno.realPath(norm);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
      // Target does not exist yet (write case): resolve the deepest existing
      // ancestor, then re-append the remainder.
      const segments = naive.split("/").filter(Boolean);
      let resolvedParent = await Deno.realPath(real);
      let i = 0;
      while (i < segments.length) {
        try {
          resolvedParent = await Deno.realPath(`${resolvedParent}/${segments[i]}`);
          i++;
        } catch (e) {
          if (!(e instanceof Deno.errors.NotFound)) throw e;
          break;
        }
      }
      resolved = [resolvedParent, ...segments.slice(i)].join("/");
    }
    if (resolved !== real && !resolved.startsWith(real + "/")) {
      throw new Error(`path ${JSON.stringify(rel)} escapes root ${JSON.stringify(rootName)}`);
    }
    return resolved;
  }

  private rootCfg(name: string): FsRootConfig {
    const entry = this.roots.get(name);
    if (!entry) throw new Error(`unknown fs root: ${JSON.stringify(name)}`);
    return entry.cfg;
  }

  private requireWrite(rootName: string, op: string): void {
    const cfg = this.rootCfg(rootName);
    if (!cfg.write) {
      throw new Error(
        `root ${JSON.stringify(rootName)} is read-only (write not enabled); ${op} rejected`,
      );
    }
  }

  private requireExec(rootName: string): void {
    const cfg = this.rootCfg(rootName);
    if (!cfg.exec) {
      throw new Error(`root ${JSON.stringify(rootName)} does not allow exec; fs.exec rejected`);
    }
  }

  private arg<T>(args: JsonValue, key: string): T {
    return (args as Record<string, T>)[key];
  }

  glob(args: JsonValue): Promise<JsonValue> {
    const root = this.arg<string>(args, "root");
    const pattern = this.arg<string>(args, "pattern");
    const maxEntries = Math.min(Math.max(this.arg<number>(args, "maxEntries") ?? 500, 1), 5000);
    return this.globImpl(root, pattern, maxEntries);
  }

  private async globImpl(root: string, pattern: string, maxEntries: number): Promise<JsonValue> {
    const { real } = await this.rootReal(root);
    const re = globToRegExp(pattern);
    const matches: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      if (matches.length >= maxEntries) return;
      let entries: Deno.DirEntry[];
      try {
        entries = [...Deno.readDirSync(dir)];
      } catch {
        return;
      }
      for (const e of entries) {
        if (matches.length >= maxEntries) return;
        const p = `${dir}/${e.name}`;
        const rel = p.slice(real.length + 1);
        if (e.isDirectory) {
          if (!e.name.startsWith(".") && e.name !== "node_modules" && e.name !== ".git") {
            await walk(p);
          }
        } else if (e.isFile && re.test(rel)) {
          matches.push(rel);
        }
      }
    };
    await walk(real);
    matches.sort();
    return {
      root,
      pattern,
      truncated: matches.length >= maxEntries,
      entries: matches,
    } as JsonValue;
  }

  async list(args: JsonValue): Promise<JsonValue> {
    const root = this.arg<string>(args, "root");
    const rel = this.arg<string>(args, "path") ?? ".";
    const recursive = this.arg<boolean>(args, "recursive") ?? false;
    const abs = await this.resolve(root, rel);
    const info = await Deno.stat(abs);
    if (!info.isDirectory) throw new Error(`${JSON.stringify(rel)} is not a directory`);
    const { real } = await this.rootReal(root);
    const out: string[] = [];
    if (recursive) {
      const walk = async (dir: string): Promise<void> => {
        for (const e of Deno.readDirSync(dir)) {
          const p = `${dir}/${e.name}`;
          const r = p.slice(real.length + 1);
          if (e.isDirectory) {
            if (e.name.startsWith(".") || e.name === "node_modules") continue;
            out.push(r + "/");
            await walk(p);
          } else if (e.isFile) {
            out.push(r);
          }
        }
      };
      await walk(abs);
      out.sort();
    } else {
      for (const e of Deno.readDirSync(abs)) {
        out.push(e.name + (e.isDirectory ? "/" : ""));
      }
      out.sort();
    }
    return { root, path: rel, entries: out } as JsonValue;
  }

  async read(args: JsonValue): Promise<JsonValue> {
    const root = this.arg<string>(args, "root");
    const rel = this.arg<string>(args, "path");
    let offset = this.arg<number>(args, "offset") ?? 0;
    const limit = this.arg<number>(args, "limit") ?? 0;
    const abs = await this.resolve(root, rel);
    const info = await Deno.stat(abs);
    if (info.isDirectory) throw new Error(`${JSON.stringify(rel)} is a directory, not a file`);
    if (info.size > this.opts.maxFileSize) {
      throw new Error(
        `file ${
          JSON.stringify(rel)
        } is ${info.size} bytes, exceeds limit of ${this.opts.maxFileSize}`,
      );
    }
    const data = await Deno.readTextFile(abs);
    const lines = data.split("\n");
    if (offset < 0) offset = 0;
    if (offset > lines.length) offset = lines.length;
    let segment = lines.slice(offset);
    if (limit > 0 && limit < segment.length) segment = segment.slice(0, limit);
    return {
      root,
      path: rel,
      content: segment.join("\n"),
      offset,
      returnedLines: segment.length,
      totalLines: lines.length,
      hasMore: offset + segment.length < lines.length,
    } as JsonValue;
  }

  async write(args: JsonValue): Promise<JsonValue> {
    const root = this.arg<string>(args, "root");
    this.requireWrite(root, "fs.write");
    const rel = this.arg<string>(args, "path");
    const content = this.arg<string>(args, "content");
    if (new TextEncoder().encode(content).length > this.opts.maxFileSize) {
      throw new Error(`content exceeds limit of ${this.opts.maxFileSize} bytes`);
    }
    const abs = await this.resolve(root, rel);
    await Deno.mkdir(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(abs, content, { mode: 0o644 });
    return {
      root,
      path: rel,
      written: true,
      bytes: new TextEncoder().encode(content).length,
    } as JsonValue;
  }

  private async readForEdit(root: string, rel: string): Promise<{ abs: string; data: string }> {
    const abs = await this.resolve(root, rel);
    const info = await Deno.stat(abs);
    if (info.isDirectory) throw new Error(`${JSON.stringify(rel)} is a directory, not a file`);
    if (!info.isFile) throw new Error(`${JSON.stringify(rel)} is not a regular file`);
    if (info.size > this.opts.maxFileSize) {
      throw new Error(`file is ${info.size} bytes, exceeds limit of ${this.opts.maxFileSize}`);
    }
    return { abs, data: await Deno.readTextFile(abs) };
  }

  async edit(args: JsonValue): Promise<JsonValue> {
    const root = this.arg<string>(args, "root");
    this.requireWrite(root, "fs.edit");
    const rel = this.arg<string>(args, "path");
    const oldText = this.arg<string>(args, "oldText");
    const newText = this.arg<string>(args, "newText");
    if (oldText === "") throw new Error("oldText must not be empty");
    const { abs, data } = await this.readForEdit(root, rel);
    const count = data.split(oldText).length - 1;
    if (count === 0) throw new Error("oldText not found in file");
    if (count > 1) throw new Error(`oldText matches ${count} locations, must be unique`);
    const updated = data.replace(oldText, newText);
    if (new TextEncoder().encode(updated).length > this.opts.maxFileSize) {
      throw new Error(`edited file would exceed limit of ${this.opts.maxFileSize} bytes`);
    }
    await Deno.writeTextFile(abs, updated, { mode: 0o644 });
    return { root, path: rel, edited: true } as JsonValue;
  }

  async editRegex(args: JsonValue): Promise<JsonValue> {
    const root = this.arg<string>(args, "root");
    this.requireWrite(root, "fs.editRegex");
    const rel = this.arg<string>(args, "path");
    const pattern = this.arg<string>(args, "pattern");
    const replacement = this.arg<string>(args, "replacement");
    let re: RegExp;
    try {
      re = new RegExp(pattern, "g");
    } catch (err) {
      throw new Error(`invalid pattern: ${err instanceof Error ? err.message : String(err)}`);
    }
    const { abs, data } = await this.readForEdit(root, rel);
    const matches = [...data.matchAll(re)];
    if (matches.length === 0) throw new Error("pattern has no matches in file");
    if (matches.length > 1) {
      throw new Error(`pattern matches ${matches.length} locations, must be unique`);
    }
    const m = matches[0];
    const updated = data.slice(0, m.index) +
      data.slice(m.index, m.index + m[0].length).replace(re, replacement) +
      data.slice(m.index + m[0].length);
    if (new TextEncoder().encode(updated).length > this.opts.maxFileSize) {
      throw new Error(`edited file would exceed limit of ${this.opts.maxFileSize} bytes`);
    }
    await Deno.writeTextFile(abs, updated, { mode: 0o644 });
    return { root, path: rel, edited: true } as JsonValue;
  }

  async exec(args: JsonValue): Promise<JsonValue> {
    const root = this.arg<string>(args, "root");
    this.requireExec(root);
    const command = this.arg<string>(args, "command");
    if (command.trim() === "") throw new Error("command must not be empty");
    let timeoutSecs = this.arg<number>(args, "timeout") ?? 0;
    if (timeoutSecs <= 0 || timeoutSecs > this.opts.execTimeoutSec) {
      timeoutSecs = this.opts.execTimeoutSec;
    }

    while (this.execRunning >= this.opts.maxConcurrentExec) {
      await Promise.race(this.execSlots);
    }
    this.execRunning++;
    const slot = (async () => {
      try {
        await new Promise((r) => setTimeout(r, 0));
      } finally {
        this.execRunning--;
      }
    })();
    this.execSlots.push(slot);
    try {
      const { real } = await this.rootReal(root);
      const res = await this.runExec(real, command, timeoutSecs * 1000);
      return { root, ...res } as JsonValue;
    } finally {
      this.execSlots = this.execSlots.filter((s) => s !== slot);
    }
  }

  private runExec(cwd: string, command: string, timeoutMs: number): Promise<ExecResult> {
    const started = Date.now();
    // On Linux the command runs as its own process-group leader (setsid), so
    // the timeout can SIGKILL the whole group — sh and all its children — and
    // collect the shell immediately. On macOS setsid is unavailable, so we
    // spawn directly and kill the process (children may linger briefly).
    // See killExecGroup for how the group is signalled, and why it is never
    // done by passing a negative pid to kill(1).
    const useSetsid = Deno.build.os === "linux";
    const cmd = useSetsid
      ? new Deno.Command("/usr/bin/setsid", {
        args: ["/bin/sh", "-c", command],
        cwd,
        env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: cwd, TMPDIR: "/tmp" },
        clearEnv: true,
        stdout: "piped",
        stderr: "piped",
      })
      : new Deno.Command("/bin/sh", {
        args: ["-c", command],
        cwd,
        env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: cwd, TMPDIR: "/tmp" },
        clearEnv: true,
        stdout: "piped",
        stderr: "piped",
      });
    const proc = cmd.spawn();
    const stdout = this.cappedRead(proc.stdout, this.opts.maxOutput);
    const stderr = this.cappedRead(proc.stderr, this.opts.maxOutput);
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      if (useSetsid) killExecGroup(proc.pid);
      try {
        proc.kill("SIGKILL");
      } catch { /* already exited */ }
    }, timeoutMs);
    return (async () => {
      const [out, err, status] = await Promise.all([stdout, stderr, proc.status]);
      clearTimeout(timer);
      return {
        command,
        stdout: out,
        stderr: err + (killed ? `\n[command timed out after ${timeoutMs} ms]` : ""),
        exitCode: killed ? -1 : (status.code ?? -1),
        durationMs: Date.now() - started,
        timedOut: killed,
      };
    })();
  }

  private async cappedRead(stream: ReadableStream<Uint8Array>, limit: number): Promise<string> {
    const reader = stream.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let dropped = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = limit - buf.length;
      if (room > 0) {
        const chunk = dec.decode(value, { stream: true });
        if (chunk.length <= room) buf += chunk;
        else {
          buf += chunk.slice(0, room);
          dropped += chunk.length - room;
        }
      } else {
        dropped += value.byteLength;
      }
    }
    if (dropped > 0) buf += `\n...[output truncated, ${dropped} bytes dropped]`;
    return buf;
  }
}

// globToRegExp converts a simple glob (*, **, ?, [...]) into a RegExp matched
// against root-relative paths. ** matches across separators, * does not.
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end === -1) {
        re += "\\[";
      } else {
        re += glob.slice(i, end + 1);
        i = end;
      }
    } else {
      re += c.replace(/[.+^${}()|\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}
