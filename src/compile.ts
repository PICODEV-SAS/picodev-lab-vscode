// Compiling on the visitor's machine (architecture "Binaire d'abord", v0.15): arduino-cli, then push_program;
// the lab compiles (push_to_editor) only when the toolchain is missing. Pure functions first: they are tested.
import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

/** A path's last part, whichever the separator (the log may come from Windows). */
const base = (p: string) => p.split(/[\\/]/).pop()!;

export type Diag = { file: string; line: number; col: number; severity: 'error' | 'warning'; message: string };

/** gcc's `file:line:col: error: message` lines (col may be missing, as in the linker's), file reduced to its name. */
export function parseDiagnostics(log: string): Diag[] {
  const out: Diag[] = [];
  for (const m of log.matchAll(/^(.+?):(\d+):(?:(\d+):)?\s*(fatal error|error|warning):\s*(.+)$/gm))
    out.push({ file: base(m[1]), line: +m[2], col: +(m[3] ?? 1), severity: m[4] === 'warning' ? 'warning' : 'error', message: m[5].trim() });
  return out;
}

export type Verdict =
  | { kind: 'ok' }
  | { kind: 'code'; diags: Diag[] } // the visitor's code: shown, never sent to the lab (it would fail there too)
  | { kind: 'toolchain'; reason: 'cli' | 'core' | 'library' | 'timeout' | 'unknown'; missing?: string };

/**
 * What a compilation's end means. `sources`: the sketch's own file names (a missing header among them is the code's
 * fault, not a missing library). `exit`: the exit code, 'ENOENT' when the CLI is not there, 'timeout' when killed.
 */
export function verdict(exit: number | 'ENOENT' | 'timeout', log: string, sources: string[] = []): Verdict {
  if (exit === 0) return { kind: 'ok' };
  if (exit === 'ENOENT') return { kind: 'toolchain', reason: 'cli' };
  if (exit === 'timeout') return { kind: 'toolchain', reason: 'timeout' };
  if (/platform not installed|Platform '[^']+' not found|Invalid FQBN|Unknown FQBN|core not found/i.test(log))
    return { kind: 'toolchain', reason: 'core', missing: /Platform '([^']+)'/.exec(log)?.[1] };
  const header = /fatal error:\s*([\w./-]+\.h(?:pp)?):\s*No such file or directory/i.exec(log)?.[1];
  if (header && !sources.includes(base(header))) return { kind: 'toolchain', reason: 'library', missing: header };
  const diags = parseDiagnostics(log);
  if (diags.some((d) => d.severity === 'error') || /undefined reference to/.test(log)) return { kind: 'code', diags };
  return { kind: 'toolchain', reason: 'unknown' }; // ponytail: an error arduino-cli words otherwise: the lab tries
}

export type Run = { exit: number | 'ENOENT' | 'timeout' | 'cancelled'; log: string };

/** execFile without a shell, bounded in time, cancellable; the log is stdout and stderr together. */
export function run(cli: string, args: string[], timeout: number, signal?: AbortSignal): Promise<Run> {
  return new Promise((ok) => {
    // English whatever the visitor's locale (verdict() matches the messages), and no colours in the log
    const env = { ...process.env, LC_ALL: 'C', LANG: 'C', ARDUINO_LOCALE: 'en', NO_COLOR: '1' };
    execFile(cli, args, { timeout, signal, env, maxBuffer: 8 << 20, windowsHide: true }, (e, stdout, stderr) => {
      const log = `${stdout}${stderr}`.replace(/\x1b\[[0-9;]*m/g, '');
      const err = e as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
      if (!err) return ok({ exit: 0, log });
      if (err.code === 'ENOENT') return ok({ exit: 'ENOENT', log });
      if (signal?.aborted || err.name === 'AbortError') return ok({ exit: 'cancelled', log });
      if (err.killed) return ok({ exit: 'timeout', log });
      ok({ exit: typeof err.code === 'number' ? err.code : 1, log: log || err.message });
    });
  });
}

/** The first of `candidates` that answers `version`. */
export async function findCli(candidates: string[]): Promise<string | undefined> {
  for (const c of candidates) if (c && (await run(c, ['version'], 10000)).exit === 0) return c;
  return undefined;
}

/**
 * The sketch compiled in a temporary folder named after its .ino (arduino-cli wants the folder and the .ino to
 * match): the files compiled are exactly those sent. Returns the HEX text when it built.
 */
export async function compile(cli: string, fqbn: string, files: { name: string; content: string }[], signal?: AbortSignal) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'picodev-lab-'));
  try {
    const ino = files[0].name; // the .ino first (sketch())
    const dir = path.join(tmp, ino.replace(/\.ino$/i, ''));
    await fs.mkdir(dir);
    for (const f of files) await fs.writeFile(path.join(dir, f.name), f.content);
    const out = path.join(tmp, 'out');
    const r = await run(cli, ['compile', '--fqbn', fqbn, '--output-dir', out, dir], 180000, signal);
    const hex = r.exit === 0 ? await fs.readFile(path.join(out, `${path.basename(dir)}.ino.hex`), 'utf8').catch(() => undefined) : undefined;
    return { ...r, hex };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}
