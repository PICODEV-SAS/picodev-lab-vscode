import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { existsSync } from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  Contact, File, LabClient, LabError, Mode, Session, SessionStatus, Setup, SetupSheet, Simulation,
  SpecDraft, SpecFigure, SpecSection, ToolImage, Visibility, MAX_FIGURES, MAX_FIGURE_BYTES, MAX_PROGRAM,
} from 'picodev-lab-client';
import { compile, Diag, findCli, parseDiagnostics, run, verdict } from './compile';

const MCP_URL = 'https://lab.picodev.fr/mcp';
const LAB = 'https://lab.picodev.fr';
const SITE = 'https://picodev.fr';
const VELXIO = 'https://github.com/davidmonterocrespo24/velxio';
const SPEC = 'spec-projet.md'; // the same file as the Claude Code plugin's /lab-projet
// The headings spec-projet.md may carry (French, the plugin's fixed format, or English), by the ids of spec_draft and
// brief_submit: for reading the file only; what is shown (heading, what to look for, questions) comes from spec_draft
const SECTIONS: [id: string, fr: string, en: string][] = [
  ['envelope', 'Contexte du projet', 'Project context'],
  ['fonctionPrincipale', 'Fonction principale', 'Main function'],
  ['fonctions', 'Modules et fonctions', 'Modules and functions'],
  ['alimentation', 'Alimentation', 'Power supply'],
  ['format', 'Format et encombrement', 'Form factor and dimensions'],
  ['environnement', 'Environnement', 'Environment'],
  ['production', 'Production', 'Production'],
  ['preferences', 'Préférences techniques', 'Technical preferences'],
];
// The view's tabs, short names (French, English)
const TABS: [id: string, fr: string, en: string][] = [
  ['session', 'Session', 'Session'], ['challenge', 'Défi', 'Challenge'], ['bench', 'Banc réel', 'Real bench'],
  ['journal', 'Journal', 'Log'], ['project', 'Projet', 'Project'], ['share', 'Partage', 'Share'],
];
const SOURCES = /\.(ino|h|hpp|c|cpp)$/i; // same set as the Claude Code plugin's hook
const INO = /\.ino$/i;
const NAME_RE = /^[\w.-]{1,64}$/; // what the bench's editor accepts as a file name
const BLANK = 'void setup() {\n  Serial.begin(9600);\n}\n\nvoid loop() {\n}\n';
const GITIGNORE = '# build outputs (arduino-cli, the Arduino IDE)\nbuild/\n*.hex\n*.elf\n*.bin\n*.eep\n*.o\n';
const CLI_DOCS = 'https://arduino.github.io/arduino-cli/latest/installation/';
const t = vscode.l10n.t;
const CLAUDE = 'anthropic.claude-code';

type TestRow = { id: string; status: 'pending' | 'running' | 'passed' | 'failed'; detail?: string };

let client: LabClient;
let secrets: vscode.SecretStorage;
let key: string; // the SecretStorage key of `folder`'s session
let folder: vscode.WorkspaceFolder | undefined; // the session's folder: the active file's, else the first
let item: vscode.StatusBarItem;
let status: Partial<SessionStatus> = {}; // the last session_status, empty until the first poll
let tests: string | undefined; // "passed/total" of the level, from the last read_simulation
let timer: NodeJS.Timeout | undefined;
let busy = false;
const told = new Set<string>(); // notifications already given for this session
// The last read_simulation of the current run, its events kept across reads (for the view)
let sim: Simulation | undefined;
/** Where afterOpen wrote the bench's sketch when no folder was open: pushed from there too. */
let sketchDir: vscode.Uri | undefined;
let simRun: number | undefined;
let events: Simulation['events'] = [];
let lastT = 0;
let reading = false;
let journal: { at: string; tool: string; ok: boolean }[] = []; // this extension's calls to the lab
let view: vscode.WebviewView | undefined;
let dumped: ((text: string) => void) | undefined; // the integration test reads the view's text
let panel: vscode.WebviewPanel | undefined; // the "Lab" panel (V2.4)
let panelKey = '';
let sheet: SetupSheet | undefined; // read_setup of the session's setup, read once per session
let sheetFor = '';
let circuitError: string | null = null; // read_simulation gives it once: kept until the next run
let version = ''; // shown in the panel's footer, to tell which build is loaded
let images: { schema?: string } = {}; // data: URIs, posted to the view apart from the model (up to 700 KB)
let diagnostics: vscode.DiagnosticCollection; // the local compilation's errors, in the Problems panel
let output: vscode.OutputChannel; // the compilations' logs ("Show log")
let state: vscode.Memento; // the folders whose git repo the extension made: committed after each push
let specDone: string[] | null = null; // the filled sections of spec-projet.md (null: no file), for the Project tab
let testing = false; // the integration test: no browser opened
let cliFound: Promise<string | undefined> | undefined; // arduino-cli, looked for once per session
let sheetP: Promise<SetupSheet | undefined> | undefined;
let localErr = ''; // the last local compilation's errors, in the view until the next push
let lastLog = ''; // the last failed compilation's log (here or in the lab), for "Ask Copilot to fix"
let gaveCopilot = false; // the session was handed to Copilot (the view's next step)
let stale = false; // the last session_status failed: what is shown may be old
let mcp: vscode.McpServerDefinitionProvider<vscode.McpHttpServerDefinition>; // its headers follow the shown session
let mcpChanged: vscode.EventEmitter<void>;
let offers: Setup['benches'] = []; // the real bench offers of the session's setup (list_setups), read once per session
let offersFor = '';
const fr = vscode.env.language.startsWith('fr');
const language = fr ? 'fr' : 'en'; // the hub's texts and the PDF's headings

export async function activate(context: vscode.ExtensionContext) {
  extContext = context;
  version = context.extension.packageJSON.version;
  testing = context.extensionMode === vscode.ExtensionMode.Test;
  // the integration test's mock hub (test/run.js); never read outside a test run
  const url = (testing && process.env.PICODEV_LAB_TEST_MCP) || MCP_URL;
  client = new LabClient({ url, name: 'picodev-lab-vscode', version });
  // Declares the lab's public MCP server, so Copilot agent mode sees it as soon as the extension is installed. While the
  // active folder holds a session, its headers carry it (contract 0.20): Copilot's calls need neither session nor token.
  mcpChanged = new vscode.EventEmitter<void>();
  mcp = {
    onDidChangeMcpServerDefinitions: mcpChanged.event,
    provideMcpServerDefinitions: () => {
      const s = client.session;
      const headers: Record<string, string> = s ? { 'X-Lab-Session': s.session, 'X-Lab-Agent-Token': s.agent_token } : {};
      return [new vscode.McpHttpServerDefinition('picodev-lab', vscode.Uri.parse(url), headers, version)];
    },
  };
  context.subscriptions.push(mcpChanged, vscode.lm.registerMcpServerDefinitionProvider('picodev-lab', mcp));
  // ponytail: the agent log wraps the client's one entry point; session_status stays out, as in the bench's journal
  const call = client.call.bind(client);
  client.call = (name, args) => {
    const r = call(name, args);
    if (name === 'session_status') return r;
    const log = (ok: boolean) => {
      journal = [...journal, { at: new Date().toTimeString().slice(0, 8), tool: name, ok }].slice(-50);
      post();
    };
    return r.then((v) => (log(true), v), (e) => (log(false), Promise.reject(e)));
  };
  secrets = context.secrets;
  state = context.workspaceState;
  diagnostics = vscode.languages.createDiagnosticCollection('picodevLab');
  output = vscode.window.createOutputChannel('Picodev Lab');
  // one session per workspace folder: the one shown and polled follows the active file's folder
  folder = folderOf(vscode.window.activeTextEditor?.document.uri);
  key = keyOf(folder);
  item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  item.show();

  const cmd = (id: string, fn: (...a: any[]) => unknown) =>
    vscode.commands.registerCommand(id, async (...a: any[]) => {
      try {
        return await fn(...a);
      } catch (e) {
        report(e);
      }
    });

  const specWatch = vscode.workspace.createFileSystemWatcher(`**/${SPEC}`);
  context.subscriptions.push(
    item, diagnostics, output,
    { dispose: () => clearInterval(timer) },
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('picodevLab.arduinoCli') && (cliFound = undefined)),
    cmd('picodevLab.starter', starter),
    vscode.window.registerWebviewViewProvider('picodevLab.view', { resolveWebviewView: (v) => resolveView(v, context.extensionUri) }),
    cmd('picodevLab.open', (setup?: string) => open('free', setup)),
    cmd('picodevLab.challenge', (setup?: string) => open('challenge', setup)),
    cmd('picodevLab.push', (uri?: vscode.Uri) => push(uri ?? vscode.window.activeTextEditor?.document.uri)),
    cmd('picodevLab.visibility', visibility),
    cmd('picodevLab.panel', openPanel),
    cmd('picodevLab.brief', brief),
    cmd('picodevLab.specWorkspace', () => specWorkspace()),
    cmd('picodevLab.meeting', meeting),
    cmd('picodevLab.share', share),
    cmd('picodevLab.openBench', () => vscode.env.openExternal(vscode.Uri.parse(need().open_url))),
    cmd('picodevLab.tellCopilot', tellCopilot),
    cmd('picodevLab.next', nextLevel),
    cmd('picodevLab.end', async () => {
      need();
      await client.close_session();
      await hold(null);
      vscode.window.showInformationMessage(t('Lab session ended.'));
    }),
    vscode.workspace.onDidSaveTextDocument(onSave),
    vscode.window.onDidChangeActiveTextEditor((e) => {
      const f = e && vscode.workspace.getWorkspaceFolder(e.document.uri);
      if (f && !same(f, folder)) void switchTo(f).catch(report);
    }),
    // the Project tab follows spec-projet.md, however it changes (the interview, the agent, the visitor)
    specWatch,
    specWatch.onDidCreate(readSpec), specWatch.onDidChange(readSpec), specWatch.onDidDelete(readSpec),
  );
  void readSpec();
  // the spec workspace just opened (the window reloaded): what was asked before, run again here
  const pending = context.globalState.get<{ dir: string; then: 'brief' | 'interview' }>('picodevLab.pending');
  if (pending && vscode.workspace.workspaceFolders?.[0]?.uri.toString() === pending.dir) {
    void context.globalState.update('picodevLab.pending', undefined);
    void (pending.then === 'interview' ? copilotInterview() : brief()).catch(report);
  }

  const saved = await secrets.get(key);
  await hold(saved ? JSON.parse(saved) : null);
  // read by the integration test
  return {
    statusText: () => item.text,
    viewText: () => new Promise<string>((ok) => {
      if (!view) return ok('');
      dumped = ok;
      void view.webview.postMessage({ type: 'dump' });
      setTimeout(() => ok(''), 2000);
    }),
    parseSpec,
    setSection,
    figurePath,
    nextOf,
    parseDiagnostics,
    verdict,
    coalesce,
    panelHtml: () => panel?.webview.html ?? '',
    panelScripts: () => panel?.webview.options.enableScripts,
    showTab,
    mcp,
  };
}

export function deactivate() {}

class NoSession extends Error {}

const keyOf = (f?: vscode.WorkspaceFolder) => `picodevLab.session:${f?.uri.toString() ?? ''}`;
const same = (a?: vscode.WorkspaceFolder, b?: vscode.WorkspaceFolder) => a?.uri.toString() === b?.uri.toString();
/** The workspace folder of `uri`, else the first one (none in a window with no folder). */
const folderOf = (uri?: vscode.Uri) => (uri && vscode.workspace.getWorkspaceFolder(uri)) || vscode.workspace.workspaceFolders?.[0];

/** Another folder of a multi-root window became active: its own session (or none) is shown and polled. */
async function switchTo(f: vscode.WorkspaceFolder) {
  const k = keyOf(f);
  folder = f;
  key = k;
  const saved = await secrets.get(k);
  if (key === k) await hold(saved ? JSON.parse(saved) : null); // unless another switch came meanwhile
}

function need(): Session {
  if (!client.session) throw new NoSession(t('No lab session: run "Picodev Lab: Open a session" first.'));
  return client.session;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** `fn` again on "Retry", as long as it fails; undefined when the person gives up. */
async function retry<T>(fn: () => Promise<T>): Promise<T | undefined> {
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      const again = t('Retry');
      if ((await vscode.window.showErrorMessage(`Picodev Lab: ${message(e)}`, again)) !== again) return undefined;
    }
  }
}

const kind = (e: unknown) => (e instanceof LabError ? e.kind : undefined);

function report(e: unknown) {
  if (kind(e) === 'gone') return void ended(); // the client has forgotten the session
  if (kind(e) === 'no_browser') return browserGone(t('No browser has the bench open: open it, it runs the simulation.'));
  if (e instanceof NoSession) {
    const openIt = t('Open a session');
    return void vscode.window.showErrorMessage(e.message, openIt).then((a) => a && vscode.commands.executeCommand('picodevLab.open'));
  }
  vscode.window.showErrorMessage(`Picodev Lab: ${message(e)}`);
}

function browserGone(msg: string) {
  const openIt = t('Open the bench');
  vscode.window.showWarningMessage(msg, openIt).then((a) => a && vscode.commands.executeCommand('picodevLab.openBench'));
}

/** Keeps a session (or none): SecretStorage, polling, status bar. */
async function hold(s: Session | null) {
  client.session = s;
  status = {};
  tests = undefined;
  sim = undefined;
  simRun = undefined;
  events = [];
  lastT = 0;
  journal = [];
  sheet = undefined;
  sheetFor = '';
  circuitError = null;
  images = {};
  sheetP = undefined;
  cliFound = undefined;
  localErr = '';
  lastLog = '';
  gaveCopilot = false;
  stale = false;
  offers = [];
  offersFor = '';
  diagnostics.clear();
  mcpChanged.fire(); // open, close, another folder's session: Copilot's server gets the new headers
  void vscode.commands.executeCommand('setContext', 'picodevLab.session', !!s);
  postImages();
  told.clear();
  clearInterval(timer);
  timer = undefined;
  if (s) {
    await secrets.store(key, JSON.stringify(s));
    timer = setInterval(refresh, 2000); // the contract's ceiling: every 2 s at most, only while a session is held
    void refresh();
  } else {
    await secrets.delete(key);
  }
  render();
}

async function ended() {
  await hold(null);
  const again = t('Open a session');
  vscode.window.showInformationMessage(t('The lab session has ended.'), again)
    .then((a) => a && vscode.commands.executeCommand('picodevLab.open'));
}

async function refresh() {
  if (!client.session || busy) return;
  busy = true;
  try {
    const prev = status;
    status = await client.status();
    if (prev.level !== undefined && status.level !== prev.level) {
      tests = undefined;
      sim = undefined;
    }
    if (status.setup && status.setup !== sheetFor) void readSheet(status.setup);
    if (status.setup && status.setup !== offersFor) readOffers(status.setup);
    // the first status, a new run or a new level: read the simulation (brief, tests); else only while watched
    if (status.run !== prev.run || status.level !== prev.level) void readTests(status.run);
    if (prev.owner && status.owner === false)
      browserGone(t('The browser left the bench: the session ends in 10 minutes unless you open it again.'));
    const left = (status.expires_at ?? Infinity) - Date.now() / 1000;
    if (left < 300 && !told.has('expires')) {
      told.add('expires');
      const again = t('Open a new session');
      vscode.window.showWarningMessage(t('The lab session ends in {0} min.', Math.max(1, Math.ceil(left / 60))), again)
        .then((a) => a && vscode.commands.executeCommand('picodevLab.open'));
    }
    stale = false;
  } catch (e) {
    if (kind(e) === 'gone') void ended();
    else stale = true; // network, hub restarting: shown as stale, the next poll tries again
  } finally {
    busy = false;
    render();
  }
}

/** After each compilation or level change: its result, then the level's tests, read again until they are decided. */
async function readTests(run: number | undefined, tries = 10) {
  if (!client.session || status.run !== run || reading) return;
  reading = true;
  try {
    const fresh = simRun !== run;
    const r = await client.read_simulation({ since_ms: fresh ? 0 : lastT }); // events of this run only
    events = [...(fresh ? [] : events), ...r.events].slice(-400);
    circuitError = r.circuit_error ?? (fresh ? null : circuitError);
    lastT = events.at(-1)?.t ?? (fresh ? 0 : lastT);
    sim = r;
    simRun = run;
  } catch (e) {
    if (kind(e) === 'gone') void ended(); // the client has forgotten the session: the poll stops by itself
    return;
  } finally {
    reading = false;
  }
  if (sim?.compile && !sim.compile.ok && !told.has(`compile:${run}`)) {
    told.add(`compile:${run}`);
    const lines = sim.compile.log.split('\n');
    compileFailed(t('The sketch does not compile: {0}', (lines.find((l) => /error/i.test(l)) ?? lines[0]).trim()), sim.compile.log);
  }
  const results = resultsOf();
  if (!results.length) return render();
  const passed = results.filter((r) => r.status === 'passed').length;
  tests = `${passed}/${results.length}`;
  render();
  const level: number = sim?.challenge?.level ?? sim?.state?.level ?? 0;
  if (passed === results.length && !told.has(`level:${level}`)) {
    told.add(`level:${level}`);
    const shareIt = t('Share'), next = t('Next level'), openIt = t('Open the bench');
    const last = nextOf(true, level, status.levels) === 'last';
    vscode.window.showInformationMessage(
      last ? t('Level {0} passed, in simulation: it was the last one. Finish in the bench.', level + 1) : t('Level {0} passed, in simulation.', level + 1),
      ...(last ? [openIt, shareIt] : [next, shareIt]),
    ).then((a) => a && (a === next ? vscode.commands.executeCommand('picodevLab.next') : a === openIt ? vscode.commands.executeCommand('picodevLab.openBench') : showTab('share')));
  } else if (tries > 1 && results.some((r) => r.status === 'pending' || r.status === 'running')) {
    setTimeout(() => readTests(run, tries - 1), 3000);
  }
}

/** What follows a level once all its tests pass: the next one, or the last level's end (left to the bench's "Finish"). */
function nextOf(all: boolean, level: number | null | undefined, levels: number | null | undefined): 'next' | 'last' | null {
  if (!all || level == null) return null;
  return levels != null && level + 1 >= levels ? 'last' : 'next'; // levels unknown: the hub says if it was the last
}

/** next_level: as the bench's "Next level" button; the hub refuses it unless every test of the level passed. */
async function nextLevel() {
  need();
  const r = await client.next_level();
  vscode.window.setStatusBarMessage(t('Level {0}/{1} sent to the bench.', r.level + 1, r.levels), 4000);
  void refresh(); // the level changes with the bench's next state; refresh() then reads the new level's tests
}

function resultsOf(): TestRow[] {
  const r = sim?.challenge?.results ?? sim?.state?.results;
  return Array.isArray(r) ? r : [];
}

function render() {
  post();
  renderPanel();
  item.tooltip = t('Show the Picodev Lab view');
  item.command = 'picodevLab.view.focus';
  if (!client.session) {
    item.text = '$(beaker) Lab';
    item.color = undefined;
    return;
  }
  const parts = ['$(beaker) Lab', status.setup ?? '…'];
  if (folder && (vscode.workspace.workspaceFolders?.length ?? 0) > 1) parts.splice(1, 0, folder.name); // which folder's session
  if (status.mode === 'challenge' && status.level != null)
    parts.push(status.levels ? t('Challenge {0}/{1}', status.level + 1, status.levels) : t('Challenge {0}', status.level + 1));
  if (tests) parts.push(t('tests {0}', tests));
  if (status.viewers) parts.push(status.viewers === 1 ? t('1 viewer') : t('{0} viewers', status.viewers));
  if (status.owner === false) parts.push(t('no browser'));
  if (stale) parts.push(`$(warning) ${t('lab unreachable')}`);
  item.text = parts.join(' · ');
  item.color = new vscode.ThemeColor('picodevLab.statusBarForeground');
}

async function open(mode: Mode, setup?: string) {
  if (client.session) {
    const end = t('End it and open a new one');
    if ((await vscode.window.showWarningMessage(t('A lab session is already open.'), { modal: true }, end)) !== end) return;
    await client.close_session().catch(() => undefined);
  }
  if (!setup) {
    const all = await retry(() => client.list_setups());
    if (!all) return;
    const pick = await vscode.window.showQuickPick(
      all.filter((s) => s.modes.includes(mode)).map((s) => {
        const en = fr ? undefined : s.i18n?.en; // a missing translation falls back to the French field
        return { label: en?.title ?? s.title ?? s.id, description: s.id, detail: en?.summary ?? s.summary, id: s.id };
      }),
      { placeHolder: mode === 'challenge' ? t('Setup of the challenge (the board and its parts, simulated)') : t('Setup to open (the board and its parts, simulated)') },
    );
    if (!pick) return;
    setup = pick.id;
  }
  const id = setup;
  const s = await retry(() => client.open_session({ setup: id, mode }));
  if (!s) return;
  await hold(s);
  // both are needed: the bench (it simulates) opens at once, the agent is the next step; the Lab panel shows it here
  if (!testing) {
    void vscode.env.openExternal(vscode.Uri.parse(s.open_url));
    openPanel();
  }
  const tell = t('Give it to {0}', agentName());
  vscode.window.showInformationMessage(
    t('Session open on {0}; the bench opens in your browser (it runs the simulation). Next: give the session to {1}.', setup, agentName()), tell,
  ).then((a) => a && vscode.commands.executeCommand('picodevLab.tellCopilot'));
  void afterOpen();
}

/**
 * After opening: the folder's sketch, or else the bench's own sketch written here (the workspace root, or
 * ~/picodev-lab/<setup> with no folder open) and opened, so that each save sends it (auto-push); then the
 * offer of a local git repo. A file already there is never overwritten.
 */
async function afterOpen() {
  const found = await sketch(vscode.window.activeTextEditor?.document.uri).catch(() => undefined);
  if (found) return offerGit(found.dir);
  const setup = status.setup ?? (await client.status().catch(() => undefined))?.setup;
  const files = await benchFiles();
  if (!setup || !files.some((f) => INO.test(f.name))) return;
  if (testing && !folder) return; // the suite writes nothing in the home folder
  const dir = folder?.uri ?? vscode.Uri.file(path.join(os.homedir(), 'picodev-lab', setup));
  await vscode.workspace.fs.createDirectory(dir);
  for (const f of files) {
    const u = vscode.Uri.joinPath(dir, f.name);
    if (!(await exists(u))) await vscode.workspace.fs.writeFile(u, new TextEncoder().encode(f.content));
  }
  sketchDir = dir;
  await vscode.window.showTextDocument(vscode.Uri.joinPath(dir, files.find((f) => INO.test(f.name))!.name));
  vscode.window.showInformationMessage(t('The bench\'s sketch is in {0}: edit it here, each save sends it to the bench.', dir.fsPath));
  if (client.session) await offerGit(dir);
}

/** The sketch the bench shows (its state, once the browser has sent one), else the setup sheet's; [] if neither comes. */
async function benchFiles(): Promise<File[]> {
  const ok = (f: unknown): f is File => !!f && typeof (f as File).name === 'string' && typeof (f as File).content === 'string'
    && NAME_RE.test((f as File).name) && SOURCES.test((f as File).name);
  for (let i = 0; i < 10 && !Array.isArray(sim?.state?.files); i++) await new Promise((r) => setTimeout(r, 1000)); // the browser is opening
  const given = Array.isArray(sim?.state?.files) ? sim!.state!.files : (await setupSheet().catch(() => undefined))?.files ?? [];
  return (given as unknown[]).filter(ok).slice(0, 8);
}

/** The agent that gets the session: the picodevLab.agent setting; "auto" is Claude Code when it is installed. */
function claude() {
  const a = vscode.workspace.getConfiguration('picodevLab').get<string>('agent', 'auto');
  return a === 'claude' || (a === 'auto' && !!vscode.extensions.getExtension(CLAUDE));
}
const agentName = () => (claude() ? 'Claude Code' : 'Copilot');
const agentLong = () => (claude() ? 'Claude Code' : t('Copilot Chat, in Agent mode'));

/** How Claude Code reaches the lab: the picodev-lab plugin (MCP, mod, skills, hook), the lab's MCP alone, or not at all. */
async function claudeLab(): Promise<'plugin' | 'mcp' | undefined> {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const read = (f: string) => fs.readFile(f, 'utf8').catch(() => '');
  if ((await read(path.join(dir, 'plugins', 'installed_plugins.json'))).includes('"picodev-lab@')) return 'plugin';
  // ponytail: user-scope servers only (the file `claude mcp add --scope user` writes); a project-scope one is not seen
  const config = await read(process.env.CLAUDE_CONFIG_DIR ? path.join(dir, '.claude.json') : path.join(os.homedir(), '.claude.json'));
  try { if (JSON.parse(config || '{}').mcpServers?.['picodev-lab']) return 'mcp'; } catch { /* a file being written: asked again next time */ }
  return undefined;
}

/** Claude Code's own binary: the one in its extension, else `claude` on the PATH. */
function claudeBin() {
  const dir = vscode.extensions.getExtension(CLAUDE)?.extensionPath;
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const found = dir && [path.join(dir, 'resources', 'native-binaries', `${process.platform}-${process.arch}`, exe), path.join(dir, 'resources', 'native-binary', exe)].find(existsSync);
  return found || 'claude';
}

/** The agent's chat, prefilled (Copilot in Agent mode, or Claude Code); false (and a way to get it) when it is missing. */
async function chat(query: string) {
  if (claude()) return claudeChat(query);
  if (!(await vscode.commands.getCommands(true)).includes('workbench.action.chat.open')) {
    const get = t('Install Copilot Chat');
    if ((await vscode.window.showWarningMessage(t('No chat in this editor: Picodev Lab works with Copilot Chat, in Agent mode.'), get)) === get)
      await vscode.commands.executeCommand('workbench.extensions.search', 'GitHub.copilot-chat');
    return false;
  }
  // mode: VS Code versions that know it open the chat in Agent mode; the others ignore it
  await vscode.commands.executeCommand('workbench.action.chat.open', { query, isPartialQuery: true, mode: 'agent' });
  return true;
}

async function claudeChat(query: string) {
  if (!vscode.extensions.getExtension(CLAUDE)) {
    const get = t('Install Claude Code');
    if ((await vscode.window.showWarningMessage(t('Claude Code is not installed in this editor.'), get)) === get)
      await vscode.commands.executeCommand('workbench.extensions.search', CLAUDE);
    return false;
  }
  if (!(await claudeLab())) {
    const tools = t('Add the lab\'s tools');
    if ((await vscode.window.showWarningMessage(t('Claude Code does not reach the lab yet: add the lab\'s tools to it (its MCP server, as for Copilot)?'), tools)) !== tools) return false;
    const r = await run(claudeBin(), ['mcp', 'add', '--scope', 'user', '--transport', 'http', 'picodev-lab', MCP_URL], 30_000);
    if (r.exit !== 0) {
      output.appendLine(r.log);
      vscode.window.showErrorMessage(t('Could not add the lab\'s tools to Claude Code. By hand: claude mcp add --scope user --transport http picodev-lab {0}', MCP_URL));
      return false;
    }
    vscode.window.showInformationMessage(t('The lab\'s tools are added to Claude Code. A conversation already open sees them after a restart.'));
  }
  // (session, prompt): a new conversation, the prompt in its input box
  await vscode.commands.executeCommand('claude-vscode.editor.open', undefined, query);
  return true;
}

/**
 * One session for the extension and Copilot: the extension opens it and hands its id and token to Copilot
 * as a prompt prefilled in the chat, which the person sends. Nothing is written in the workspace.
 */
async function tellCopilot() {
  const s = need();
  // Copilot gets the session from the MCP server's headers (contract 0.20); Claude Code reaches the lab through its own
  // server, with no header: its prompt keeps the session and the token
  const intro = claude()
    ? t('A Picodev Lab session is already open: session {0}, agent_token {1}. Use them with the picodev-lab tools; do not call open_session.', s.session, s.agent_token)
    : t('A Picodev Lab session is already open, and the picodev-lab tools carry it by themselves: leave out session and agent_token, and do not call open_session.');
  const ok = await chat(`${intro} ${t(
    'The board and the libraries: read_setup with id "{0}" (board.fqbn, libraries). After each change of the sketch, compile it on this machine: arduino-cli compile --fqbn <board.fqbn> --output-dir <a temporary folder> <the sketch\'s folder>, then call push_program with hex (the text of <sketch>.ino.hex), files (all the sketch\'s files, the .ino first; 8 files, 64 KiB at most) and run: true. If the code does not compile, fix it and compile again: the lab would fail the same way. Only when the toolchain is missing (no arduino-cli, or the board\'s core or a library not installed and not installable), call push_to_editor with the same files and run: true: the lab compiles. Then read the result with read_simulation. Saving in the editor sends the sketch too, but do not count on it. In a challenge, a test whose spec is {"type":"answer"} is passed by the person\'s answer: ask for it, then call submit_answer with session, agent_token, test and value (current level only, one call per second); ok in the result is the verdict shown in the bench. The hints in read_simulation are only those the person revealed in the bench: never guess one, ask the person to reveal one there. In a challenge, when every test of the level is passed, say so, and call next_level if the person wants to go on; after the last level, the person finishes in the bench.',
    status.setup ?? '',
  )}`);
  if (!ok) return;
  gaveCopilot = true;
  render();
  vscode.window.showInformationMessage(claude() ? t('Send the message in Claude Code.') : t('In the chat, pick Agent mode (if it is not picked), then send the message.'));
}

/** The failed compilation's log to Copilot (it already has the session from "Give it to Copilot"). */
const fix = () => chat(`${t('The sketch does not compile. Fix it, compile it again with arduino-cli and send it with push_program (push_to_editor only if the toolchain is missing). The errors:')}\n${lastLog.trim().slice(-3000)}`);

/** A compilation's errors, in a notification with its ways out. */
function compileFailed(msg: string, log: string) {
  lastLog = log;
  output.appendLine(log);
  const show = t('Show log'), ask = t('Ask {0} to fix', agentName());
  vscode.window.showErrorMessage(msg, show, ask).then((a) => {
    if (a === show) output.show(true);
    else if (a === ask) void fix();
  });
}

function onSave(doc: vscode.TextDocument) {
  if (path.basename(doc.fileName) === SPEC) void readSpec(doc.uri); // the watcher does not see a folder outside the workspace
  if (!client.session || !SOURCES.test(doc.fileName)) return;
  const f = vscode.workspace.getWorkspaceFolder(doc.uri);
  if (f && !same(f, folder)) return; // another folder's sketch ("save all" in a multi-root window): its own session
  if (!vscode.workspace.getConfiguration('picodevLab').get('autoPush', true)) return;
  push(doc.uri).catch(report);
}

/** The sketch: the folder of `uri` if it holds an .ino, else the session's folder's; its sources, the .ino first. */
async function sketch(uri?: vscode.Uri) {
  const root = folder?.uri;
  for (const dir of [uri && vscode.Uri.joinPath(uri, '..'), root, sketchDir]) {
    if (!dir) continue;
    const names = (await vscode.workspace.fs.readDirectory(dir).then(undefined, () => []))
      .filter(([n, type]) => type === vscode.FileType.File && SOURCES.test(n))
      .map(([n]) => n)
      .sort((a, b) => Number(!INO.test(a)) - Number(!INO.test(b)) || a.localeCompare(b));
    if (!names.some((n) => INO.test(n))) continue;
    const bad = names.filter((n) => !NAME_RE.test(n));
    if (bad.length) throw new LabError(t('File name refused by the bench ({0}): letters, digits, . _ - only.', bad.join(', ')));
    const dec = new TextDecoder();
    const files: File[] = await Promise.all(names.map(async (name) => ({ name, content: dec.decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, name))) })));
    return { dir, files };
  }
  return undefined;
}

const exists = (u: vscode.Uri) => vscode.workspace.fs.stat(u).then(() => true, () => false);

/** A starter sketch at the workspace root: the setup's files (the bench's current ones first), or a blank .ino. */
async function starter() {
  const dir = folder?.uri;
  if (!dir) {
    const openIt = t('Open a folder');
    if ((await vscode.window.showInformationMessage(t('Open a folder first: the sketch is written in it.'), openIt)) === openIt)
      await vscode.commands.executeCommand('workbench.action.files.openFolder');
    return;
  }
  const ok = (f: unknown): f is File => !!f && typeof (f as File).name === 'string' && typeof (f as File).content === 'string'
    && NAME_RE.test((f as File).name) && SOURCES.test((f as File).name);
  const given = Array.isArray(sim?.state?.files) ? sim!.state!.files : sheet?.files ?? [];
  const setupFiles: File[] = (given as unknown[]).filter(ok).slice(0, 8);
  const items = [
    ...(setupFiles.some((f) => INO.test(f.name)) ? [{ label: t('The setup\'s sketch'), detail: setupFiles.map((f) => f.name).join(', '), files: setupFiles }] : []),
    { label: t('A blank sketch'), detail: 'sketch.ino', files: [{ name: 'sketch.ino', content: BLANK }] },
  ];
  const pick = items.length > 1 ? await vscode.window.showQuickPick(items, { placeHolder: t('Starter sketch') }) : items[0];
  if (!pick) return;
  for (const f of pick.files) {
    const u = vscode.Uri.joinPath(dir, f.name);
    if (!(await exists(u))) await vscode.workspace.fs.writeFile(u, new TextEncoder().encode(f.content)); // never overwritten
  }
  await vscode.window.showTextDocument(vscode.Uri.joinPath(dir, pick.files.find((f) => INO.test(f.name))!.name));
  if (client.session) await offerGit(dir);
}

/** The sheet of the session's setup (components, schema.png, board, libraries): read once per session. */
function readSheet(id: string) {
  sheetFor = id;
  return (sheetP = client.read_setup({ id }).then((r) => {
    if (sheetFor !== id) return undefined; // another session meanwhile
    sheet = r;
    images.schema = dataUri(sheet.images?.[0]);
    postImages();
    render();
    return r;
  }, () => undefined));
}

/** The real bench offers of the session's setup: list_setups' `benches`, with their status (contract 0.20). */
function readOffers(id: string) {
  offersFor = id;
  client.list_setups().then((all) => {
    if (offersFor !== id) return; // another session meanwhile
    offers = all.find((x) => x.id === id)?.benches ?? [];
    render();
  }, () => (offersFor = '')); // read again at the next poll
}

/** queue_join on `kind` (one of the setup's open offers), or queue_leave: a place, or the turn, given back. */
async function queue(kind?: string) {
  need();
  if (kind) {
    const r = await client.queue_join({ kind });
    vscode.window.setStatusBarMessage(t('In the queue of the real bench: place {0}.', r.position), 4000);
  } else await client.queue_leave();
  offersFor = ''; // the counts changed: read again with the status
  void refresh();
}

/** The session's sheet, for compiling: read again once if the first read failed. */
async function setupSheet() {
  const id = status.setup ?? (await client.status()).setup;
  if (sheetFor !== id || !sheetP) void readSheet(id);
  return (await sheetP) ?? (await readSheet(id));
}

/** Only a PNG or JPEG in base 64 becomes a data: URI; the view's CSP allows no other image. */
const dataUri = (i?: ToolImage) =>
  i && /^image\/(png|jpeg)$/.test(i.mimeType) && /^[A-Za-z0-9+/]+={0,2}$/.test(i.data) ? `data:${i.mimeType};base64,${i.data}` : undefined;

// ── sending the sketch: compiled here (arduino-cli, push_program), or by the lab when the toolchain is missing ──

/** arduino-cli: the setting, else PATH, else the Arduino extension's bundled one (its usual place only). */
function cli() {
  const exe = process.platform === 'win32' ? 'arduino-cli.exe' : 'arduino-cli';
  const bundled = ['vscode-arduino.vscode-arduino-community', 'vsciot-vscode.vscode-arduino']
    .map((id) => vscode.extensions.getExtension(id)?.extensionPath)
    .filter((p): p is string => !!p)
    .map((p) => path.join(p, 'assets', 'platform', `${process.platform}-${process.arch}`, 'arduino-cli', exe));
  return (cliFound ??= findCli([vscode.workspace.getConfiguration('picodevLab').get<string>('arduinoCli', '').trim(), 'arduino-cli', ...bundled]));
}

/**
 * `fn` once per burst: the calls made while a run waits its turn (`ms` after the first, and never during another run)
 * join it, with the last argument. Only the call that started a run gets its outcome, so an error is told once.
 */
function coalesce<A>(fn: (a: A) => Promise<void>, ms: number) {
  let chain: Promise<unknown> = Promise.resolve();
  let next: { arg: A } | undefined;
  return (arg: A): Promise<void> => {
    if (next) return (next.arg = arg), Promise.resolve();
    const n = (next = { arg });
    const run = chain.then(() => new Promise((r) => setTimeout(r, ms))).then(() => {
      next = undefined;
      return fn(n.arg);
    });
    chain = run.catch(() => undefined);
    return run;
  };
}

/** A push per burst ("save all" of three files: one push), the sketch read when it goes; for the session it was asked in. */
const pushOnce = coalesce(async ({ uri, s }: { uri?: vscode.Uri; s: Session }) => {
  if (client.session !== s) return; // the session changed meanwhile
  const found = await sketch(uri);
  if (!found) {
    const make = t('Create a starter sketch');
    const a = await vscode.window.showWarningMessage(t('No .ino next to this file nor at the workspace root: nothing was sent.'), make);
    return void (a === make && (await starter()));
  }
  await send(found.dir, found.files);
}, 300);

const push = (uri?: vscode.Uri) => pushOnce({ uri, s: need() });

async function send(dir: vscode.Uri, files: File[], toLab = false) {
  const hex = toLab ? 'lab' : await compileHere(dir, files);
  if (hex === undefined) return; // a code error, or cancelled: nothing sent
  const names = files.map((f) => f.name).join(', ');
  if (hex === 'lab') {
    await client.push_to_editor({ files, run: true }); // the client refuses > 8 files or 64 KiB
    vscode.window.setStatusBarMessage(t('Sent to the lab, which compiles it ({0}).', names), 4000);
  } else {
    // ponytail: a hub older than v0.15 has no push_program: the lab compiles; drop once every hub has it
    const old = await client.push_program({ hex, files, run: true }).then(() => false, (e) => {
      if (kind(e) === 'hub' && /unknown tool/i.test(message(e))) return true;
      throw e;
    });
    if (old) return send(dir, files, true);
    vscode.window.setStatusBarMessage(t('Compiled on your machine, sent to the bench ({0}).', names), 4000);
  }
  localErr = '';
  void commit(dir, hex === 'lab');
  void refresh();
}

/** The HEX compiled here; 'lab' when the toolchain is missing; undefined on a code error (shown) or a cancel. */
async function compileHere(dir: vscode.Uri, files: File[]): Promise<string | undefined> {
  const exe = await cli();
  if (!exe) return noCli();
  const sh = await setupSheet();
  const fqbn = sh?.board?.fqbn;
  if (!fqbn) return 'lab'; // ponytail: the sheet unread (lab unreachable): the lab knows its board
  for (let tries = 0; ; tries++) {
    const r = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t('Compiling on your machine ({0})…', fqbn), cancellable: true },
      (_, token) => {
        const ac = new AbortController();
        token.onCancellationRequested(() => ac.abort());
        return compile(exe, fqbn, files, ac.signal);
      },
    );
    output.appendLine(`$ arduino-cli compile --fqbn ${fqbn}\n${r.log}`);
    if (r.exit === 'cancelled') {
      vscode.window.setStatusBarMessage(t('Compilation cancelled: nothing was sent.'), 4000);
      return undefined;
    }
    if (r.exit === 0) {
      diagnostics.clear();
      if (!r.hex) return 'lab'; // built without a .hex (a board that makes none): the lab compiles
      const size = new TextEncoder().encode(r.hex).length;
      if (size <= MAX_PROGRAM) return r.hex;
      // as the plugin: push_program takes 48 KiB of HEX text at most, the lab compiles a bigger program
      output.appendLine(t('Program of {0} KiB, push_program takes {1} at most: the lab compiles.', Math.ceil(size / 1024), MAX_PROGRAM / 1024));
      return 'lab';
    }
    const v = verdict(r.exit, r.log, files.map((f) => f.name));
    if (v.kind === 'code') return void showErrors(dir, v.diags, r.log);
    if (v.kind === 'toolchain' && tries === 0 && (v.reason === 'core' || v.reason === 'library') && (await install(exe, fqbn, sh!.libraries ?? []))) continue;
    output.appendLine(t('The toolchain is missing ({0}): the lab compiles.', v.kind === 'toolchain' ? v.missing ?? v.reason : ''));
    return 'lab';
  }
}

/** No arduino-cli: said once per session, then the lab compiles. */
function noCli() {
  if (!told.has('cli')) {
    told.add('cli');
    const get = t('Install arduino-cli'), set = t('Set its path');
    vscode.window.showInformationMessage(t('arduino-cli was not found: the lab compiles your sketch. Install it to compile on your machine.'), get, set)
      .then((a) => a === get ? vscode.env.openExternal(vscode.Uri.parse(CLI_DOCS))
        : a === set && vscode.commands.executeCommand('workbench.action.openSettings', 'picodevLab.arduinoCli'));
  }
  return 'lab';
}

/** The board's core and the setup's libraries, installed on a yes; asked once per session. */
async function install(exe: string, fqbn: string, libraries: string[]) {
  if (told.has('install')) return false;
  told.add('install');
  const core = fqbn.split(':').slice(0, 2).join(':');
  const what = [core, ...libraries].join(', ');
  const yes = t('Install');
  if ((await vscode.window.showInformationMessage(t('To compile on your machine, arduino-cli needs {0}. Install it? Otherwise the lab compiles.', what), yes)) !== yes) return false;
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: t('Installing {0}…', what), cancellable: true },
    async (_, token) => {
      const ac = new AbortController();
      token.onCancellationRequested(() => ac.abort());
      for (const args of [['core', 'update-index'], ['core', 'install', core], ...(libraries.length ? [['lib', 'install', ...libraries]] : [])]) {
        const r = await run(exe, args, 600000, ac.signal);
        output.appendLine(`$ arduino-cli ${args.join(' ')}\n${r.log}`);
        if (r.exit !== 0) return false;
      }
      return true;
    },
  );
}

/** The local compilation's errors: in the Problems panel, the view and a notification; nothing goes to the lab. */
function showErrors(dir: vscode.Uri, diags: Diag[], log: string) {
  diagnostics.clear();
  const byFile = new Map<string, vscode.Diagnostic[]>();
  for (const d of diags) {
    const range = new vscode.Range(d.line - 1, Math.max(0, d.col - 1), d.line - 1, Math.max(0, d.col - 1) + 1);
    const x = new vscode.Diagnostic(range, d.message, d.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
    x.source = 'arduino-cli';
    byFile.set(d.file, [...(byFile.get(d.file) ?? []), x]);
  }
  for (const [file, list] of byFile) diagnostics.set(vscode.Uri.joinPath(dir, file), list); // ponytail: the core's own files point at the sketch's folder
  const errors = log.split('\n').filter((l) => /error/i.test(l));
  localErr = errors.slice(-6).join('\n') || log.trim().split('\n').slice(-6).join('\n');
  render();
  const first = diags.find((d) => d.severity === 'error');
  compileFailed(t('The sketch does not compile on your machine: {0}', first ? `${first.file}:${first.line}: ${first.message}` : errors[0]?.trim() ?? ''), log);
}

// ── the sketch's local git repo: offered once per folder, committed after each push; nothing goes to a host ──

const gitOn = () => vscode.workspace.getConfiguration('picodevLab').get('git', true);
const ours = () => state.get<string[]>('picodevLab.gitRepos', []);

async function offerGit(dir: vscode.Uri) {
  if (!gitOn() || dir.scheme !== 'file' || told.has('git')) return;
  told.add('git');
  const inRepo = await run('git', ['-C', dir.fsPath, 'rev-parse', '--is-inside-work-tree'], 10000);
  if (inRepo.exit === 0 || inRepo.exit === 'ENOENT') return; // already a repo, or no git
  const yes = t('Create'), never = t('Never');
  const a = await vscode.window.showInformationMessage(
    t('Create a git repo for your sketch? Each successful push is then committed, on your computer only: nothing is sent to a git host.'), yes, never,
  );
  if (a === never) return void vscode.workspace.getConfiguration('picodevLab').update('git', false, vscode.ConfigurationTarget.Global);
  if (a !== yes) return;
  const ignore = vscode.Uri.joinPath(dir, '.gitignore');
  if (!(await exists(ignore))) await vscode.workspace.fs.writeFile(ignore, new TextEncoder().encode(GITIGNORE));
  // the built-in git extension's API when it is there (the repo shows in Source Control at once), else git itself
  const git = vscode.extensions.getExtension('vscode.git');
  const api = await git?.activate().then((x: any) => x?.getAPI?.(1), () => undefined);
  if (api?.init) await api.init(dir);
  else {
    const r = await run('git', ['init', '-q', dir.fsPath], 20000);
    if (r.exit !== 0) throw new LabError(t('git init failed: {0}', r.log.trim()));
  }
  await state.update('picodevLab.gitRepos', [...new Set([...ours(), dir.fsPath])]);
}

async function commit(dir: vscode.Uri, byLab: boolean) {
  if (!gitOn() || !ours().includes(dir.fsPath)) return;
  const git = (...a: string[]) => run('git', ['-C', dir.fsPath, ...a], 20000);
  await git('add', '-A', '--', '.');
  const r = await git('commit', '-q', '-m', byLab ? t('Sent to Picodev Lab, compiled by the lab') : t('Sent to Picodev Lab, compiled on my machine'));
  if (r.exit !== 0 && !/nothing to commit|nothing added/i.test(r.log) && !told.has('commit')) {
    told.add('commit');
    vscode.window.showWarningMessage(t('The sketch was sent, but the git commit failed: {0}', r.log.trim().split('\n')[0] ?? ''));
  }
}

async function visibility(v?: Visibility) {
  need();
  if (v) {
    await client.set_visibility({ visibility: v }); // a click in the view: its title says it cuts off the viewers
    return refresh();
  }
  const levels: { label: string; detail: string; v: Visibility }[] = [
    { label: t('Private'), detail: t('Nobody can watch.'), v: 'private' },
    { label: t('Link'), detail: t('Whoever has the viewer link can watch.'), v: 'link' },
    { label: t('Public'), detail: t('Listed on the lab, anyone can watch.'), v: 'public' },
  ];
  const pick = await vscode.window.showQuickPick(levels, {
    placeHolder: t('Who can watch your bench? Changing it cuts off the viewers watching now.'),
  });
  if (!pick) return;
  const r = await client.set_visibility({ visibility: pick.v });
  void refresh();
  if (!r.viewer_url) return vscode.window.showInformationMessage(t('Visibility: {0}.', pick.label));
  await vscode.env.clipboard.writeText(r.viewer_url);
  vscode.window.showInformationMessage(t('Visibility: {0}. Viewer link copied.', pick.label));
}

async function share() {
  need();
  let url = (await client.status()).viewer_url;
  if (!url) {
    const allow = t('Allow link viewers');
    if ((await vscode.window.showInformationMessage(t('The session is private: nobody can watch it.'), allow)) !== allow) return;
    url = (await client.set_visibility({ visibility: 'link' })).viewer_url;
    void refresh();
  }
  if (!url) return;
  await vscode.env.clipboard.writeText(url);
  vscode.window.showInformationMessage(t('Viewer link copied: {0}', url));
}

// ── the "Picodev Lab" view (V2.1 to V2.5): the host computes every string, the webview lays them out ──

function resolveView(v: vscode.WebviewView, ext: vscode.Uri) {
  view = v;
  const media = vscode.Uri.joinPath(ext, 'media');
  const w = v.webview;
  w.options = { enableScripts: true, localResourceRoots: [media] };
  const nonce = randomBytes(16).toString('base64');
  const src = (f: string) => w.asWebviewUri(vscode.Uri.joinPath(media, f));
  w.html = `<!DOCTYPE html><html lang="${fr ? 'fr' : 'en'}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${src('view.css')}"></head>
<body><main id="root"></main><script nonce="${nonce}" src="${src('view.js')}"></script></body></html>`;
  w.onDidReceiveMessage(onMessage);
  v.onDidChangeVisibility(() => (post(), postImages()));
  v.onDidDispose(() => (view = undefined));
}

const ACTIONS: Record<string, string> = {
  open: 'picodevLab.open', challenge: 'picodevLab.challenge', push: 'picodevLab.push', openBench: 'picodevLab.openBench',
  end: 'picodevLab.end', brief: 'picodevLab.brief', meeting: 'picodevLab.meeting', panel: 'picodevLab.panel',
  next: 'picodevLab.next', copilot: 'picodevLab.tellCopilot', starter: 'picodevLab.starter',
  openFolder: 'workbench.action.files.openFolder',
};

/** A message of the webview: untrusted, each type checked and its argument matched against a fixed set. */
function onMessage(m: unknown) {
  if (!m || typeof m !== 'object') return;
  const { type, arg } = m as { type?: unknown; arg?: unknown };
  if (typeof type !== 'string') return;
  if (type === 'ready') {
    void view?.webview.postMessage({ type: 'init', l: labels() });
    postImages();
    return post();
  }
  if (type === 'dump') return dumped?.(String(arg).slice(0, 20000));
  if (Object.hasOwn(ACTIONS, type)) return void vscode.commands.executeCommand(ACTIONS[type]);
  if (type === 'visibility' && (arg === 'private' || arg === 'link' || arg === 'public'))
    return void vscode.commands.executeCommand('picodevLab.visibility', arg);
  if (type === 'autoPush') {
    const c = vscode.workspace.getConfiguration('picodevLab');
    return void c.update('autoPush', !c.get('autoPush', true), vscode.ConfigurationTarget.Global).then(post);
  }
  if (type === 'interview') return void copilotInterview();
  if (type === 'specPdf') return void specAction('pdf').catch(report);
  if (type === 'specSend') return void specAction('send').catch(report);
  if (type === 'fix') return void fix();
  if (type === 'queueLeave') return void queue().catch(report);
  if (type === 'queueJoin' && offers.some((o) => o.kind === arg && o.status !== 'soon')) return void queue(arg as string).catch(report);
  if (type === 'log') return output.show(true);
  if (type === 'walkthrough') return void vscode.commands.executeCommand('workbench.action.openWalkthrough', 'picodev.picodev-lab#picodevLab.start', false);
  if (type === 'copy' && arg === 'viewer') return void vscode.commands.executeCommand('picodevLab.share');
  const sh = shareOf();
  if (type === 'copy' && arg === 'share' && sh)
    return void vscode.env.clipboard.writeText(sh.link).then(() => vscode.window.setStatusBarMessage(t('Link copied: {0}', sh.link), 4000));
  const links: Record<string, string | undefined> = { picodev: SITE, velxio: VELXIO, ...(sh && shareUrls(sh.text, sh.link)) };
  if (type === 'link' && typeof arg === 'string' && Object.hasOwn(links, arg) && links[arg])
    return void vscode.env.openExternal(vscode.Uri.parse(links[arg]!));
}

/** Shows the view on one of its tabs. */
async function showTab(tab: string) {
  await vscode.commands.executeCommand('picodevLab.view.focus');
  void view?.webview.postMessage({ type: 'tab', tab }); // ponytail: lost if the view's script is not loaded yet; it opens on its last tab
}

function post() {
  if (view?.visible) void view.webview.postMessage({ type: 'state', m: model() });
}

function postImages() {
  if (view?.visible) void view.webview.postMessage({ type: 'images', i: images });
}

const hm = (s: number) => {
  const m = Math.max(0, Math.round(s / 60));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
};
const minSec = (s: number) => {
  const r = Math.max(0, Math.round(s));
  return r < 60 ? `${r} s` : `${Math.floor(r / 60)} min ${String(r % 60).padStart(2, '0')} s`;
};

/** Levels passed (the current level's index, plus one when all its tests are green) and the time spent. */
function progress() {
  const results = resultsOf();
  const all = results.length > 0 && results.every((r) => r.status === 'passed');
  const level = status.level ?? sim?.challenge?.level ?? null;
  return {
    all,
    level,
    levels: level == null ? 0 : level + (all ? 1 : 0),
    seconds: status.created_at ? Date.now() / 1000 - status.created_at : 0,
  };
}

// The signed share the hub gives in session_status (contract 0.20): /p/<setup>.<mode>.<levels>.<seconds>.<signature>
const SIGNED = /^\/p\/([a-z0-9][a-z0-9-]*)\.(free|challenge)\.(\d{1,2})\.(\d{1,5})\.[A-Za-z0-9_-]{16}$/;

/** The share of P5.3, as the Claude Code plugin: the hub's /p/ page (signed by the hub when it gives one) and the text. */
function shareOf() {
  if (!client.session || !status.setup || !status.mode) return undefined;
  const signed = SIGNED.exec(status.share ?? '');
  const p = progress();
  // signed: the levels and the time the hub recorded, so that the text says what the page and its image say
  const levels = signed ? Number(signed[3]) : Math.min(99, p.levels);
  const secs = signed ? Number(signed[4]) : Math.min(86400, Math.round(p.seconds));
  if (status.mode === 'challenge' && levels < 1) return undefined;
  const link = `${LAB}${fr ? '' : '/en'}${signed ? status.share : `/p/${encodeURIComponent(status.setup)}.${status.mode}.${levels}.${secs}`}`;
  const text = status.mode === 'free'
    ? t('I programmed an Arduino on the simulated bench of Picodev Lab, driven by my agent.')
    : levels === 1
      ? t('I passed 1 level of an Arduino challenge in {0} on the simulated bench of Picodev Lab, driven by my agent.', minSec(secs))
      : t('I passed {0} levels of an Arduino challenge in {1} on the simulated bench of Picodev Lab, driven by my agent.', levels, minSec(secs));
  return { link, text, levels, secs };
}

const shareUrls = (text: string, link: string) => ({
  linkedin: 'https://www.linkedin.com/sharing/share-offsite/?url=' + encodeURIComponent(link),
  x: 'https://x.com/intent/post?text=' + encodeURIComponent(text) + '&url=' + encodeURIComponent(link),
});

/** A component's properties when they fit on a line ("value=220"), else nothing. */
const props = (p?: Record<string, unknown>) => {
  const s = Object.entries(p ?? {}).map(([k, v]) => `${k}=${v}`).join(', ');
  return s.length <= 40 ? s : '';
};

function model() {
  const autoPush = vscode.workspace.getConfiguration('picodevLab').get('autoPush', true);
  const s = client.session;
  if (!s) return { session: null, autoPush, main: 'challenge', folder: !!vscode.workspace.workspaceFolders?.length, project: projectOf() };
  const p = progress();
  const results = resultsOf();
  const brief = sim?.challenge?.brief;
  // The sheet's English (i18n.en) when VS Code is not in French; a missing translation falls back to the French field
  const en = fr ? undefined : sheet?.i18n?.en;
  const lv = brief ? en?.levels?.[brief.id] : undefined;
  // Only the hints the visitor revealed in the bench (contract 0.21); the sheet's English hints no longer apply
  const hints = brief?.hints ?? [];
  const challenge = status.mode === 'challenge';
  const share = shareOf();
  const levelText = p.level == null ? '…' : status.levels ? `${p.level + 1} / ${status.levels}` : String(p.level + 1);
  const compile = sim?.compile;
  const next = challenge ? nextOf(p.all, p.level, status.levels) : null;
  // coral is the real next step, never the sales action; the line under the tabs says it in words
  const q = status.queue; // absent from a hub older than contract 0.20
  const [main, step] = !status.owner ? ['openBench', t('Next: open the bench in your browser; it runs the simulation.')]
    : q?.state === 'turn' ? ['openBench', t('Your turn on the real bench: it runs in the bench, in your browser.')]
    : !gaveCopilot ? ['copilot', t('Next: give the session to {0}.', agentName())]
      : next === 'next' ? ['next', t('Next: go to the next level.')]
        : next === 'last' ? ['openBench', t('Last level passed: finish in the bench.')]
          : challenge ? ['push', t('Next: make the tests pass. Ask {0}, or push the sketch yourself.', agentName())]
            : ['push', t('Next: ask {0} to change the sketch, or push it yourself: it is compiled and run on the bench.', agentName())];
  return {
    autoPush,
    main,
    step,
    stale: stale ? t('The lab does not answer: trying again every 2 s. What is shown may be out of date.') : '',
    session: {
      free: !challenge,
      setup: status.setup ?? '…',
      mode: status.mode === 'free' ? t('Free · simulation') : t('Challenge · simulation'),
      short: `${status.setup ?? '…'} · ${status.mode === 'free' ? t('Free') : t('Challenge')}`,
      browser: !!status.owner,
      browserText: status.owner ? t('connected') : t('waiting: open the bench'),
      end: status.expires_at ? hm(status.expires_at - Date.now() / 1000) : '…',
      visibility: status.visibility ?? null,
      viewers: status.viewers === 1 ? t('1 viewer') : t('{0} viewers', status.viewers ?? 0),
      viewerUrl: !!status.viewer_url,
      circuit: sim?.circuit_modified ? t('Circuit changed from the sheet.') : '',
      circuitError: circuitError ? t('Circuit refused by the bench: {0}', circuitError) : '',
    },
    setup: sheet ? {
      title: en?.title ?? sheet.title,
      parts: (sheet.circuit?.components ?? []).map((c) => ({ type: c.type, id: c.id, props: props(c.properties) })),
      // ponytail: probes only; the sheet's levels (hints, couplings) stay out, they give challenge answers away
      probes: (sheet.probes ?? []).map((p) => ({
        label: p.label, kind: p.kind === 'logic' ? t('Logic') : p.kind === 'scope' ? t('Scope') : String(p.kind),
      })),
    } : null,
    challenge: challenge ? {
      head: t('Challenge · level {0}', levelText),
      passed: p.all,
      waiting: status.owner === false,
      title: lv?.title ?? brief?.title ?? '',
      brief: lv?.brief ?? brief?.brief ?? '',
      hints: Array.isArray(hints) ? hints.map(String) : [],
      tests: results.map((r) => ({ s: r.status, id: String(r.id), detail: r.detail ? String(r.detail) : '' })),
      done: p.all ? t('Passed in simulation, in {0}.', minSec(p.seconds)) : '',
      next,
    } : null,
    sim: {
      // a local error first (nothing was sent), else the last read_simulation's state
      compile: localErr ? t('errors, on your machine') : compile ? (compile.ok ? t('ok') : t('errors')) : sim?.state?.running ? t('running') : '—',
      ok: localErr ? false : compile ? compile.ok : null,
      origin: localErr || !compile?.origin ? '' : compile.origin === 'agent' ? t('compiled on your machine') : t('compiled by the lab'),
      log: localErr || (compile && !compile.ok ? compile.log.trim().split('\n').slice(-6).join('\n') : ''),
    },
    bench: offers.length || (q && q.state !== 'none') ? {
      queued: !!q && q.state !== 'none',
      turn: q?.state === 'turn',
      state: q?.state === 'waiting'
        ? t('Place {0} of {1} in the queue of {2}', q.position ?? '…', q.waiting ?? '…', q.kind ?? '')
          + (q.eta_s ? ` · ${t('about {0}', minSec(q.eta_s))}` : '')
        : q?.state === 'turn' ? t('Your turn on {0}: {1} left.', q.kind ?? '', minSec((q.ends_at ?? 0) - Date.now() / 1000)) : '',
      offers: offers.map((o) => ({
        kind: o.kind, soon: o.status === 'soon',
        text: o.status === 'soon' ? t('soon') : t('{0}/{1} free · {2} waiting', o.free, o.benches, o.waiting),
      })),
    } : null,
    journal,
    project: projectOf(),
    share: share ? {
      text: share.text,
      link: share.link.replace(/^https:\/\//, ''),
      summary: status.mode === 'free' ? t('Result obtained in simulation, in your browser.')
        : share.levels === 1 ? t('1 level passed · {0} · in simulation, in your browser', minSec(share.secs))
          : t('{0} levels passed · {1} · in simulation, in your browser', share.levels, minSec(share.secs)),
    } : null,
  };
}

/** The view's fixed words; the sentences with values come in the model. */
function labels() {
  return {
    noSession: t('No lab session. Picodev Lab needs three things:'),
    need1: t('A folder with your sketch (an .ino file).'),
    need2: t('The bench: a page in your browser that simulates the board and its parts. It opens with the session.'),
    need3: t('{0}: it writes the code and drives the bench.', agentLong()),
    openFolder: t('Open a folder'), starter: t('Create a starter sketch'), getStarted: t('Get started (walkthrough)'),
    openChallenge: t('Open a challenge'), openSession: t('Open a session'), copilot: t('Give it to {0}', agentName()), push: t('Push the sketch'),
    pushHelp: t('Push: send the sketch to the bench, compiled on your machine (or by the lab), and run it.'),
    autoPushHelp: t('Auto-push: push the sketch each time you save one of its files.'),
    setupHelp: t('The setup: the board and the parts wired to it, simulated in your browser.'),
    benchHelp: t('The bench: the lab page in your browser that runs the simulation.'),
    viewersHelp: t('Viewers: people watching your bench through its link.'),
    probesHelp: t('Probes: the pins the lab measures. Logic: high or low, and when. Scope: the voltage over time.'),
    compiled: t('Compiled'), fix: t('Ask {0} to fix', agentName()), showLog: t('Show log'),
    session: t('Session'), setup: t('Setup'), mode: t('Mode'), browser: t('Browser'), ends: t('Ends in'),
    visibility: t('Visibility'), private: t('Private'), link: t('Link'), public: t('Public'),
    visHint: t('Who can watch your bench? Changing it cuts off the viewers watching now.'),
    copyLink: t('Copy the link'), openBench: t('Open the bench'), end: t('End'), panel: t('Lab panel'),
    waiting: t('No browser has the bench open: open it, it runs the simulation.'),
    passed: t('passed'), pushTest: t('Push and test'), nextLevel: t('Next level'),
    lastPassed: t('Last level passed: finish in the bench.'), hint: t('Hint {0}/{1}'), hintN: t('Hint {0}: {1}'),
    compilation: t('Compilation'),
    journal: t('Calls to the lab'), noCalls: t('No call to the lab yet in this session.'),
    copilotCalls: t('{0}\'s own calls show in the bench\'s journal, in your browser.', agentName()),
    parts: t('Parts'), probes: t('Probes'), schemaAlt: t('Schema of the setup'),
    share: t('Share'),
    realBench: t('Real bench'),
    realBenchHelp: t('A real board, wired as the setup and filmed: take a turn of a few minutes, in a queue. Your program runs on it.'),
    offers: t('Offers'), noOffer: t('No real bench for this setup.'), join: t('Join the queue'),
    leave: t('Leave the queue'), giveBack: t('Give back the turn'), camera: t('Camera (Lab panel)'),
    project: t('Got a project?'),
    projectText: t('A circuit board, a connected device, a setup to make reliable: describe it here, in your own words, and we help you formalize it. The interview asks our engineers\' questions, one at a time, and writes the specification: what the product does, its power, its size, its environment, its production. What is still unclear is marked "to be specified".'),
    projectKeep: t('The spec stays on your machine (spec-projet.md, and a PDF). If you want, send it to Picodev: we read it and get back to you about what comes next (study, prototype, production).'),
    spec: t('Specification'), noSpec: t('No spec-projet.md in this folder yet.'), inProgress: t('in progress'),
    describe: t('Describe my project'), resume: t('Resume the spec'), interview: t('Let {0} interview me', agentName()),
    specPdf: t('PDF preview'), specSend: t('Send to Picodev…'), specSendNeeds: t('Send: one section written at least.'),
    aiNote: t('Written with the help of an AI · read by our engineers'),
    figure1: t('1 illustration'), figuresN: t('{0} illustrations'),
    contactYes: t('contact details in the document'), contactNo: t('no contact details in the document'),
    direct: t('Or directly'), meeting: t('Meeting / questions'),
    consentNote: t('Nothing is sent without your consent.'),
    autoPush: t('Auto-push'),
    // short names, to fit one line of the sidebar (fixed pairs, as SECTIONS: "Share" is already the button's word);
    // the full name is the tab's title and accessible name
    tabs: Object.fromEntries(TABS.map(([id, f, e]) => [id, fr ? f : e])),
    tabTitles: { session: t('Session'), challenge: t('Challenge'), bench: t('Real bench'), journal: t('Calls to the lab'), project: t('Your project'), share: t('Share') },
    simIn: t('Simulation in your browser · powered by'), velxio: 'Velxio (AGPLv3)',
  };
}

// ── "What about your project?" (V2.5): the hub's interview (spec_draft), brief_submit and request_meeting ──
// Nothing is sent without the consent click; spec_draft sends nothing and keeps nothing.

const fold = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const EMPTY = new Set(['a preciser', 'to be specified']);
const MAX_SECTION = 4000;

/** The section id of a `## <heading>` line (French or English heading, or the id); `contact` for the contact details (0.16). */
function idOf(line: string) {
  const head = fold(line.slice(3));
  if (head.startsWith('coordonnees') || head.startsWith('contact')) return 'contact';
  return SECTIONS.find(([id, f, e]) => head.startsWith(fold(f)) || head.startsWith(fold(e)) || head === id.toLowerCase())?.[0];
}

/** The language of a heading: 'fr' or 'en' when its words say so, else nothing ("Production", "Contact"). */
function headingLanguage(line: string) {
  const head = fold(line.slice(3));
  if (head.startsWith('coordonnees')) return 'fr';
  if (head.startsWith('contact details')) return 'en';
  for (const [, f, e] of SECTIONS) {
    if (fold(f) === fold(e)) continue;
    if (head.startsWith(fold(f))) return 'fr';
    if (head.startsWith(fold(e))) return 'en';
  }
}

const FIGURE_LINE = /^\s*!\[([^\]]*)\]\(\s*([^)\s]+)\s*\)\s*$/;

/** The Project tab: the sections of spec-projet.md, filled, the next one, or still to write. */
function projectOf() {
  const done = (specDone ?? []).filter((id) => SECTIONS.some(([s]) => s === id)); // `contact` is not one of the 8
  const cur = SECTIONS.find(([id]) => !done.includes(id))?.[0];
  return {
    exists: specDone !== null,
    count: done.length,
    figures: specFigures,
    contact: !!specDone?.includes('contact'),
    sections: SECTIONS.map(([id, f, e]) => ({ name: fr ? f : e, s: done.includes(id) ? 'done' : id === cur && specDone !== null ? 'current' : 'todo' })),
  };
}

/** Reads spec-projet.md again (activation, a save, a change on disk) for the Project tab. */
async function readSpec(changed?: vscode.Uri) {
  if (changed && path.basename(changed.fsPath) === SPEC) specFile = changed;
  const r = specHome();
  const text = r && (await vscode.workspace.fs.readFile(vscode.Uri.joinPath(r, SPEC)).then((b) => new TextDecoder().decode(b), () => undefined));
  const parsed = text === undefined ? undefined : parseSpec(text);
  specDone = parsed ? Object.keys(parsed.sections) : null;
  specFigures = parsed?.figures.length ?? 0;
  render();
}

/** The Project tab's PDF and send buttons: on spec-projet.md as it is, without the interview's menu. */
async function specAction(what: 'pdf' | 'send') {
  const dir = await root();
  if (!dir) return;
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(dir, SPEC));
  if (what === 'pdf') return preview(dir, doc);
  return sendBrief(doc);
}

/**
 * spec-projet.md: `# title`, one `## <section>` each, `## Coordonnées` (or Contact) for the contact details; a figure is
 * a line `![caption](spec-figures/x.png)` in its section, taken out of the text (contract 0.16). `language`: what the
 * headings are written in, when they say.
 */
function parseSpec(text: string) {
  let title = '', cur: string | undefined, fr = 0, en = 0;
  const body: Record<string, string> = {};
  const figures: { section: string; caption: string; path: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const fig = cur && FIGURE_LINE.exec(line);
    if (line.startsWith('# ') && !title) title = line.slice(2).trim();
    else if (line.startsWith('## ')) {
      cur = idOf(line);
      const l = headingLanguage(line);
      if (l === 'fr') fr++;
      else if (l === 'en') en++;
      if (cur) body[cur] = '';
    } else if (fig) {
      if (cur !== 'contact') figures.push({ section: cur!, caption: fig[1].trim(), path: fig[2] });
    } else if (cur) body[cur] += line + '\n';
  }
  const sections: Record<string, string> = {};
  for (const [id, v] of Object.entries(body)) if (v.trim() && !EMPTY.has(fold(v))) sections[id] = v.trim();
  const lang: 'fr' | 'en' | undefined = fr > en ? 'fr' : en > fr ? 'en' : undefined;
  return { title, sections, figures, language: lang };
}

/** A figure's path inside the spec's folder, or undefined (absolute, `..` out of it, not .png or .svg). */
function figurePath(dir: string, rel: string) {
  if (path.isAbsolute(rel) || /^[a-z][\w+.-]*:/i.test(rel)) return;
  const full = path.resolve(dir, rel);
  const inside = path.relative(dir, full);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside) || !/\.(png|svg)$/i.test(full)) return;
  return full;
}

/** The spec's figures as the hub takes them: read beside the spec, 3 at most, 200 KiB each; a bad one is said. */
async function figuresOf(doc: vscode.TextDocument): Promise<SpecFigure[]> {
  const dir = path.dirname(doc.uri.fsPath);
  const out: SpecFigure[] = [];
  for (const f of parseSpec(doc.getText()).figures.slice(0, MAX_FIGURES)) {
    const full = figurePath(dir, f.path);
    if (!full) throw new LabError(t('Figure {0}: a .png or .svg file in the spec\'s folder.', f.path));
    const data = await vscode.workspace.fs.readFile(vscode.Uri.file(full)).then((b) => b, () => undefined);
    if (!data) throw new LabError(t('Figure {0}: file not found.', f.path));
    if (data.byteLength > MAX_FIGURE_BYTES) throw new LabError(t('Figure {0}: {1} KiB at most.', f.path, MAX_FIGURE_BYTES / 1024));
    out.push({ section: f.section, caption: f.caption.slice(0, 120) || path.basename(full), type: full.toLowerCase().endsWith('.svg') ? 'svg' : 'png', data: Buffer.from(data).toString('base64') });
  }
  return out;
}

/** The spec's language: its headings', else VS Code's. */
const specLanguage = (doc: vscode.TextDocument) => parseSpec(doc.getText()).language ?? language;
const specArgs = (doc: vscode.TextDocument) => {
  const { title, sections } = parseSpec(doc.getText());
  return { title, sections, language: specLanguage(doc) };
};

/** `text` with the body of section `id` replaced, or the section added at the end under `heading`. */
function setSection(text: string, id: string, heading: string, body: string) {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => l.startsWith('## ') && idOf(l) === id);
  if (at < 0) return `${text.trimEnd()}\n\n## ${heading}\n\n${body}\n`;
  const end = lines.findIndex((l, i) => i > at && l.startsWith('## '));
  lines.splice(at + 1, (end < 0 ? lines.length : end) - at - 1, '', body, '');
  return lines.join('\n');
}

let specDir: vscode.Uri | undefined; // the folder picked for the spec when none is open (this window only)
let specFigures = 0; // the spec's figures, for the Project tab
let specFile: vscode.Uri | undefined; // the spec-projet.md last seen changing (the agent may write it in a subfolder)
const specHome = () => (specFile ? vscode.Uri.joinPath(specFile, '..') : vscode.workspace.workspaceFolders?.[0]?.uri ?? specDir);
let extContext: vscode.ExtensionContext;

/** Where spec-projet.md lives: the open folder, else one the visitor picks once; undefined when they cancel. */
async function root() {
  const r = specHome();
  if (r) return r;
  const ws = t('Create a spec workspace'), here = t('Write it in a folder of mine');
  const pick = await vscode.window.showQuickPick([
    { label: ws, detail: t('A new folder for your project: spec-projet.md and spec-figures/ for the illustrations. It opens here.') },
    { label: here, detail: t('spec-projet.md in a folder you pick; no folder is opened.') },
  ], { title: t('No folder is open: where should spec-projet.md be written?'), ignoreFocusOut: true });
  if (!pick) return;
  if (pick.label === ws) return void (await specWorkspace(pendingAction));
  const [dir] = (await vscode.window.showOpenDialog({
    canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
    title: t('No folder is open: where should spec-projet.md be written?'), openLabel: t('Write my spec here'),
  })) ?? [];
  if (!dir) return;
  specDir = dir;
  // outside the workspace, the ** watcher does not see it: one of its own
  const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, SPEC));
  extContext.subscriptions.push(w, w.onDidCreate(readSpec), w.onDidChange(readSpec), w.onDidDelete(readSpec));
  void readSpec();
  return dir;
}

/** Writes the open document and saves it: the visitor's unsaved edits are kept, not overwritten from the disk. */
async function write(doc: vscode.TextDocument, text: string) {
  const e = new vscode.WorkspaceEdit();
  e.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), text);
  await vscode.workspace.applyEdit(e);
  await doc.save();
}

const draft = async (doc: vscode.TextDocument, pdf = false) =>
  client.spec_draft({ ...specArgs(doc), pdf, ...(pdf ? { figures: await figuresOf(doc) } : {}) });
const headings = (s: SpecSection[]) => s.map((x) => x.heading).join(', ');

// What to run again once the spec workspace opens (the window reloads): kept in globalState for that folder
let pendingAction: 'brief' | 'interview' = 'brief';

async function brief() {
  pendingAction = 'brief';
  const dir = await root();
  if (!dir) return;
  const uri = vscode.Uri.joinPath(dir, SPEC);
  const exists = await vscode.workspace.fs.stat(uri).then(() => true, () => false);
  let doc = exists ? await vscode.workspace.openTextDocument(uri) : undefined;
  if (!doc || !parseSpec(doc.getText()).title) {
    const title = await vscode.window.showInputBox({
      title: t('Describe my project'), prompt: t('The title of your project, in one line.'), ignoreFocusOut: true, validateInput: line(true),
    });
    if (!title) return;
    if (!doc) {
      const r = await client.spec_draft({ language });
      const md = r.sections.map((s) => `## ${s.heading}\n\n${t('To be specified')}\n`).join('\n');
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(`# ${title.trim()}\n\n${md}`));
      doc = await vscode.workspace.openTextDocument(uri);
    } else await write(doc, `# ${title.trim()}\n\n${doc.getText()}`);
  }
  await vscode.window.showTextDocument(doc, { preview: false });
  for (;;) {
    const r = await draft(doc);
    const open = r.sections.filter((s) => s.state !== 'filled');
    const next = r.sections.find((s) => s.id === r.next);
    const pick = await vscode.window.showQuickPick([
      ...(next ? [{ label: t('Answer here, one question at a time'), detail: t('Starting with: {0}.', next.heading), id: 'ask' }] : []),
      { label: t('Let {0} interview me', agentName()), detail: t('{0} asks the lab\'s questions and writes spec-projet.md.', agentName()), id: 'copilot' },
      { label: t('Make the PDF'), detail: t('A preview in spec-projet.pdf: nothing is sent.'), id: 'pdf' },
      { label: t('Send to Picodev…'), detail: t('Your contact details and the spec, after your consent.'), id: 'send' },
    ], {
      title: t('Describe my project'), ignoreFocusOut: true,
      placeHolder: !open.length ? t('Every section is filled.')
        : r.ready ? t('Enough for Picodev to start. Still open: {0}.', headings(open)) : t('Still open: {0}.', headings(open)),
    });
    if (!pick) return;
    if (pick.id === 'copilot') return copilotInterview();
    if (pick.id === 'pdf') return preview(dir, doc);
    if (pick.id === 'send') return sendBrief(doc);
    if (!(await interview(doc, r))) return;
  }
}

/** The hub's questions in input boxes, `next` first, each answer written in its section; false on Esc. */
async function interview(doc: vscode.TextDocument, r: SpecDraft) {
  const asked = new Set<string>(); // ponytail: a section asked once per round, even if still thin; the next round asks it again
  for (;;) {
    const s = r.sections.find((x) => x.id === r.next && !asked.has(x.id)) ?? r.sections.find((x) => x.state !== 'filled' && !asked.has(x.id));
    if (!s) return true;
    asked.add(s.id);
    const qs = s.questions ?? [];
    for (const [i, q] of qs.entries()) {
      const a = await vscode.window.showInputBox({
        title: `${s.heading} (${i + 1}/${qs.length})`, prompt: s.look_for ? `${q} — ${s.look_for}` : q,
        placeHolder: t('Empty: skip the question. Esc: stop, your answers are kept.'), ignoreFocusOut: true,
        validateInput: (v) => (v.length > MAX_SECTION ? t('{0} characters at most.', MAX_SECTION) : undefined),
      });
      if (a === undefined) return false;
      if (!a.trim()) continue;
      const prev = parseSpec(doc.getText()).sections[s.id];
      await write(doc, setSection(doc.getText(), s.id, s.heading, prev ? `${prev}\n\n${a.trim()}` : a.trim()));
    }
    r = await draft(doc);
  }
}

/** The agent's interview, on the file the Project tab follows: its path is in the prompt. */
async function copilotInterview() {
  pendingAction = 'interview';
  const dir = await root();
  if (!dir) return;
  const file = vscode.Uri.joinPath(dir, SPEC).fsPath;
  await chat([
    t('Help me describe my electronics project for Picodev in the file {0} (create it if it does not exist: "# " and the project\'s title, then one "## " heading per section), with the spec_draft tool of picodev-lab: call it with the sections of the file, follow its rules, ask me one question at a time and update the file after each answer. Do not send anything.', file),
    t('Language: the one I answer in. If I answer in French, call spec_draft with language "fr" and write the headings and the text in French; else "en".'),
    t('Once the required sections are filled, offer to illustrate the project: the product in use (mise en situation), a proposal of shape or size, a block diagram. Draw it as an SVG, with no external reference and no script; never put a dimension or a choice I did not give. Save it in spec-figures/ beside the file, show it to me, and keep it only if I say yes explicitly: then add the line ![caption](spec-figures/<name>.png) (or .svg) in its section. Three at most, 200 KiB each.'),
    t('Ask me whether I want my contact details in the document; if yes, write them under a "## Coordonnées" heading (in English "## Contact details").'),
    t('When I ask for the PDF, or when the spec is ready, tell me to press "PDF preview" in the Project tab of the Picodev Lab view. When the spec is ready, also propose to send it to Picodev (contact@picodev.fr): "Send to Picodev…" in the same tab, which shows what goes and asks my consent.'),
  ].join('\n\n'));
}

/**
 * A folder for the spec (contract 0.16, "Espace de la spec et skill d'illustration"): spec-projet.md (a skeleton when
 * absent) and spec-figures/; then it is opened in this window, and `then` runs again there.
 */
async function specWorkspace(then?: 'brief' | 'interview') {
  const [parent] = (await vscode.window.showOpenDialog({
    canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
    title: t('Where should the spec workspace be created?'), openLabel: t('Create it here'),
  })) ?? [];
  if (!parent) return;
  const name = await vscode.window.showInputBox({
    title: t('Create a spec workspace'), prompt: t('The folder\'s name.'), value: fr ? 'mon-projet-picodev' : 'my-picodev-project',
    ignoreFocusOut: true, validateInput: (v) => (NAME_RE.test(v.trim()) ? undefined : t('Letters, digits, ".", "_" or "-" only.')),
  });
  if (!name) return;
  const dir = vscode.Uri.joinPath(parent, name.trim());
  const fs = vscode.workspace.fs;
  const read = (u: vscode.Uri) => fs.readFile(u).then((b) => new TextDecoder().decode(b), () => undefined);
  const put = (u: vscode.Uri, text: string) => fs.writeFile(u, new TextEncoder().encode(text));
  await fs.createDirectory(vscode.Uri.joinPath(dir, 'spec-figures'));
  const spec = vscode.Uri.joinPath(dir, SPEC);
  if ((await read(spec)) === undefined)
    await put(spec, SECTIONS.map(([, f, e]) => `## ${fr ? f : e}\n\n${t('To be specified')}\n`).join('\n'));
  if (then) await extContext.globalState.update('picodevLab.pending', { dir: dir.toString(), then });
  await vscode.commands.executeCommand('vscode.openFolder', dir, { forceNewWindow: false });
}

/** spec_draft(pdf=true): the PDF with Picodev Lab's template, written beside the spec; counted as a preview by the hub. */
async function preview(dir: vscode.Uri, doc: vscode.TextDocument) {
  const r = await draft(doc, true);
  const pdf = vscode.Uri.joinPath(dir, 'spec-projet.pdf'); // a fixed name: the hub's filename is not used as a path
  if (typeof r.pdf === 'string') await vscode.workspace.fs.writeFile(pdf, Buffer.from(r.pdf, 'base64'));
  const open = r.sections.filter((s) => s.state !== 'filled');
  const need = open.filter((s) => s.required);
  const missing = (open.length ? ' ' + t('To be specified: {0}.', headings(open)) : '')
    + (need.length ? ' ' + t('Picodev needs these to start: {0}.', headings(need)) : '');
  const openIt = t('Open the PDF'), send = t('Send to Picodev…');
  const a = await vscode.window.showInformationMessage(`${t('Spec PDF written: spec-projet.pdf. Nothing was sent.')}${missing}`, openIt, send);
  if (a === openIt) await vscode.env.openExternal(pdf);
  if (a === send) await sendBrief(doc);
}

async function sendBrief(doc: vscode.TextDocument) {
  const { title, sections, language: lang } = specArgs(doc);
  const figures = await figuresOf(doc);
  const pick = await vscode.window.showQuickPick([
    { label: t('Send the spec'), detail: t('Your contact details, the title and the spec go to Picodev.'), nda: false },
    { label: t('NDA first'), detail: t('Only your contact details, the title and "NDA wanted" go; the spec stays on your computer.'), nda: true },
  ], { placeHolder: t('Do you want a non-disclosure agreement (NDA) before sending your project?'), ignoreFocusOut: true });
  if (!pick) return;
  const contact = await askContact();
  if (!contact) return;
  const what = pick.nda
    ? t('Sent: your contact details, the title "{0}" and "NDA wanted". The spec stays on your computer.', title)
    : t('Sent: your contact details, the title "{0}" and the spec ({1} of 8 sections), as in spec-projet.pdf.', title, Object.keys(sections).filter((k) => k !== 'contact').length);
  if (!(await consent(`${what}\n${who(contact)}`))) return;
  const r = await client.brief_submit({ title, contact, nda: pick.nda, consent: true, send: true, language: lang, ...(pick.nda ? {} : { sections, figures }) });
  vscode.window.showInformationMessage(String(r?.next ?? t('Sent to Picodev.')));
}

/** request_meeting: a meeting, or a question to Picodev (the question goes in `context`). */
async function meeting() {
  const title = t('Meeting or question for Picodev');
  const lab = client.session && status.setup ? t('Tried Picodev Lab ({0}). ', status.setup) : '';
  const context = await vscode.window.showInputBox({
    title, value: lab, ignoreFocusOut: true,
    prompt: t('Your question, or your project in a few sentences: what you want to make, where you are.'),
    validateInput: (v) => (!v.trim() ? t('Required.') : v.length > 2000 ? t('{0} characters at most.', 2000) : undefined),
  });
  if (!context) return;
  const when = await vscode.window.showInputBox({
    title, ignoreFocusOut: true, prompt: t('When can Picodev reach you? A sentence, e.g. "Tuesday mornings".'),
    validateInput: (v) => (!v.trim() ? t('Required.') : undefined),
  });
  if (!when) return;
  const contact = await askContact();
  if (!contact) return;
  if (!(await consent(`${t('Sent: your contact details, your message and your availabilities.')}\n${who(contact)}\n\n${context}\n${when}`))) return;
  // no with_session: the context says what the visitor chose to say about the lab
  const r = await client.request_meeting({ contact, context: context.trim(), availabilities: { text: when.trim() }, consent: true });
  vscode.window.showInformationMessage(String(r?.next ?? t('Sent to Picodev.')));
}

const who = (c: Contact) => `${c.name} <${c.email}>${c.company ? `, ${c.company}` : ''}`;

/** A one-line field of 120 characters at most (the hub's limit). */
const line = (required: boolean) => (v: string) =>
  required && !v.trim() ? t('Required.') : v.length > 120 || /[\r\n]/.test(v) ? t('One line, {0} characters at most.', 120) : undefined;

/** Name, e-mail, company: asked each time, kept nowhere. */
async function askContact(): Promise<Contact | undefined> {
  const title = t('Your contact details, for Picodev to answer you');
  const name = await vscode.window.showInputBox({ title, prompt: t('Your name'), ignoreFocusOut: true, validateInput: line(true) });
  if (!name) return;
  const email = await vscode.window.showInputBox({
    title, prompt: t('Your e-mail: Picodev answers there; the lab never writes to it.'), ignoreFocusOut: true,
    validateInput: (v) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) && v.length <= 254 ? undefined : t('A valid e-mail address.')),
  });
  if (!email) return;
  const company = await vscode.window.showInputBox({ title, prompt: t('Your company (optional)'), ignoreFocusOut: true, validateInput: line(false) });
  if (company === undefined) return;
  return { name: name.trim(), email: email.trim(), ...(company.trim() ? { company: company.trim() } : {}) };
}

/** What goes, then the consent text of the architecture ("Vers Picodev"), word for word; true only on the click. */
async function consent(what: string) {
  const agree = t('I agree, send');
  const detail = `${what}\n\n${t('I agree that my contact details and the description of my project are sent to Picodev by e-mail, so that they can answer me. Picodev keeps them for 3 years after our last exchange and uses them for nothing else. Details: lab.picodev.fr/en/privacy')}`;
  return (await vscode.window.showInformationMessage(t('Send to Picodev?'), { modal: true, detail }, agree)) === agree;
}

// ── the "Lab" panel (V2.4): the session's spectator page beside the code, read only ──
// The lab lets VS Code frame /w/ only (frame-ancestors); the bench page itself is never framed: it opens in the browser.

const WATCH = `${LAB}/w/`;

function openPanel() {
  if (panel) return panel.reveal(vscode.ViewColumn.Beside);
  panel = vscode.window.createWebviewPanel('picodevLab.panel', t('Lab'), vscode.ViewColumn.Beside, {
    // VS Code sandboxes this webview's frame without allow-scripts unless this is set, and a nested frame inherits
    // its parent's sandbox: the spectator page would run no script and stay an empty dark page. This webview's own
    // CSP (default-src 'none', no script-src) still runs no script of ours; frame-src admits the lab only.
    enableScripts: true,
    enableCommandUris: ['picodevLab.share', 'picodevLab.openBench', 'picodevLab.open'],
    localResourceRoots: [],
    retainContextWhenHidden: true, // the spectator page keeps its live channel while the tab is hidden
  });
  panel.onDidDispose(() => {
    panel = undefined;
    panelKey = '';
  });
  renderPanel();
}

const esc = (s: string) => s.replace(/[&"'<>]/g, (c) => `&#${c.charCodeAt(0)};`);

/** The frame of `viewer_url` (only a lab spectator page), or why there is none. Rewritten when the link changes. */
function renderPanel() {
  if (!panel) return;
  const url = status.viewer_url;
  const ok = typeof url === 'string' && url.startsWith(WATCH);
  const state = !client.session ? 'none' : ok ? url : status.visibility === undefined ? 'wait' : 'private';
  if (state === panelKey) return;
  panelKey = state;
  const nonce = randomBytes(16).toString('base64');
  const a = (cmd: string, label: string) => `<a href="command:${cmd}">${esc(label)}</a>`;
  const body = state === 'none' ? `<p>${esc(t('No lab session: open one, and this panel shows its spectator page.'))} ${a('picodevLab.open', t('Open a session'))}</p>`
    : state === 'wait' ? `<p>${esc(t('Reading the session…'))}</p>`
      : state === 'private' ? `<p>${esc(t('The session is private: nobody can watch it, this panel neither. This panel shows the spectator page, which needs a viewer link: allowing it lets anyone you give the link to watch too.'))} ${a('picodevLab.share', t('Allow link viewers'))}</p>`
        : `<iframe src="${esc(state)}" title="${esc(t('Spectator page of the session'))}" sandbox="allow-scripts allow-same-origin" referrerpolicy="no-referrer"></iframe>`;
  panel.webview.html = `<!DOCTYPE html><html lang="${fr ? 'fr' : 'en'}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${LAB}; style-src 'nonce-${nonce}';">
<style nonce="${nonce}">html,body{height:100%;margin:0}body{display:flex;flex-direction:column;color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size)}
iframe{flex:1;border:0;width:100%}p{margin:0;padding:8px 12px}a{color:var(--vscode-textLink-foreground)}footer{padding:4px 12px;color:var(--vscode-descriptionForeground)}</style></head>
<body>${body}<footer>${esc(t('Spectator page, in simulation; the bench itself runs in your browser.'))} ${a('picodevLab.openBench', t('Open the bench'))} · v${esc(version)}</footer></body></html>`;
}
