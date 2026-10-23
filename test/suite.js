// Runs inside the test VS Code: open a session (on the mock hub, or the live lab with PICODEV_LAB_LIVE=1), read the status bar and the view, end the session.
const assert = require('assert');
const vscode = require('vscode');

const until = async (what, ok) => {
  for (let i = 0; i < 40; i++) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.fail(what);
};

exports.run = async () => {
  const ext = vscode.extensions.getExtension('picodev.picodev-lab');
  const api = await ext.activate();
  assert.strictEqual(api.statusText(), '$(beaker) Lab');

  // what brief_submit would get from spec-projet.md: the title, the filled sections only
  // "Next level" only once every test passed, and not after the last level (level is 0-based)
  assert.strictEqual(api.nextOf(false, 0, 3), null);
  assert.strictEqual(api.nextOf(true, null, 3), null);
  assert.strictEqual(api.nextOf(true, 0, 3), 'next');
  assert.strictEqual(api.nextOf(true, 2, 3), 'last');
  assert.strictEqual(api.nextOf(true, 1, undefined), 'next'); // levels unknown: the hub refuses the last one

  // arduino-cli's output: gcc's diagnostics, and what sends the sketch to the lab instead (the toolchain only)
  const log = [
    '/tmp/picodev-lab-x/sketch/sketch.ino: In function \'void loop()\':',
    '/tmp/picodev-lab-x/sketch/sketch.ino:7:3: error: \'digitalWrit\' was not declared in this scope',
    '/tmp/picodev-lab-x/sketch/util.h:2:10: warning: unused variable \'x\' [-Wunused-variable]',
    'C:\\Users\\a\\sketch\\sketch.ino:12: error: expected \';\' before \'}\' token',
  ].join('\n');
  assert.deepStrictEqual(api.parseDiagnostics(log).map((d) => [d.file, d.line, d.col, d.severity]),
    [['sketch.ino', 7, 3, 'error'], ['util.h', 2, 10, 'warning'], ['sketch.ino', 12, 1, 'error']]);
  assert.strictEqual(api.parseDiagnostics(log)[0].message, "'digitalWrit' was not declared in this scope");
  assert.deepStrictEqual(api.verdict(0, ''), { kind: 'ok' });
  assert.strictEqual(api.verdict('ENOENT', '').reason, 'cli');
  assert.strictEqual(api.verdict('timeout', '').reason, 'timeout');
  assert.strictEqual(api.verdict(1, log).kind, 'code'); // a code error is never a fallback
  assert.strictEqual(api.verdict(1, "Error during build: Platform 'arduino:avr' not found: platform not installed").reason, 'core');
  const noLib = '/tmp/x/sketch/sketch.ino:1:10: fatal error: Servo.h: No such file or directory';
  assert.deepStrictEqual(api.verdict(1, noLib, ['sketch.ino']), { kind: 'toolchain', reason: 'library', missing: 'Servo.h' });
  assert.strictEqual(api.verdict(1, noLib.replace('Servo.h', 'util.h'), ['sketch.ino', 'util.h']).kind, 'code'); // the sketch's own header
  assert.strictEqual(api.verdict(1, 'sketch.ino.cpp.o: In function `loop\': undefined reference to `foo()\'').kind, 'code');
  assert.strictEqual(api.verdict(1, 'Error: something else').reason, 'unknown');

  // pushes: one per burst ("save all"), the last argument; a call during a run queues one more, never overlapping
  const calls = [];
  const once = api.coalesce(async (a) => { calls.push(a); await new Promise((r) => setTimeout(r, 60)); }, 30);
  const burst = once(1); once(2); once(3);
  await burst;
  assert.deepStrictEqual(calls, [3]);
  const running = once(4);
  await new Promise((r) => setTimeout(r, 50)); // 4 is running
  const queued = once(5); once(6);
  await running; await queued;
  assert.deepStrictEqual(calls, [3, 4, 6]);

  const spec = api.parseSpec('# Robot\n\n## Contexte du projet\nUn robot.\n\n## Power supply\nTo be specified\n\n## preferences\nESP32\n');
  assert.deepStrictEqual(spec, { title: 'Robot', sections: { envelope: 'Un robot.', preferences: 'ESP32' }, figures: [], language: undefined });
  // contract 0.16: a figure line leaves its section's text, the contact details are their own section, the headings give the language
  const ill = api.parseSpec('# Robot\n\n## Format et encombrement\nBoîtier 10 cm.\n![Le boîtier sur un mur](spec-figures/boitier.svg)\n\n## Alimentation\nUSB\n\n## Coordonnées\nAna, ana@exemple.fr\n');
  assert.deepStrictEqual(ill.sections, { format: 'Boîtier 10 cm.', alimentation: 'USB', contact: 'Ana, ana@exemple.fr' });
  assert.deepStrictEqual(ill.figures, [{ section: 'format', caption: 'Le boîtier sur un mur', path: 'spec-figures/boitier.svg' }]);
  assert.strictEqual(ill.language, 'fr');
  assert.strictEqual(api.parseSpec('# R\n\n## Power supply\nUSB\n\n## Contact details\nAna\n').language, 'en');
  // a figure is a .png or .svg in the spec's folder, nothing else
  assert.ok(api.figurePath('/w/p', 'spec-figures/a.png'));
  for (const bad of ['../x.png', '/etc/a.png', 'spec-figures/a.jpg', 'https://x/a.png', 'spec-figures/../../a.svg']) assert.strictEqual(api.figurePath('/w/p', bad), undefined, bad);

  // contract 0.20: Copilot's server definition carries the session in its headers, renewed on open and close
  assert.deepStrictEqual(api.mcp.provideMcpServerDefinitions()[0].headers, {});
  let changes = 0;
  const sub = api.mcp.onDidChangeMcpServerDefinitions(() => changes++);

  await vscode.commands.executeCommand('picodevLab.challenge', 'setup-a');
  await until(`status bar after open: ${api.statusText()}`, () => /setup-a/.test(api.statusText()));
  console.log('status bar:', api.statusText());
  assert.match(api.statusText(), /^\$\(beaker\) Lab · setup-a · no browser$/);

  await vscode.commands.executeCommand('picodevLab.view.focus');
  let text = '';
  await until(`view after open: ${text}`, async () => /setup-a/.test((text = await api.viewText())) && /Velxio/.test(text));
  console.log('view:', text.replace(/\s+/g, ' ').slice(0, 300));
  assert.match(text, /Challenge · simulation/);
  assert.match(text, /waiting: open the bench/);
  assert.match(text, /Challenge · level/i); // summaries are uppercased by the CSS
  // the tabs: a challenge is open, so Défi has a tab; no Sim tab (the bench shows the run); Share only once there is one
  assert.match(text, /^Session\s+Challenge\s+(Real bench\s+)?Log\s+Project\s/i); // Real bench: with the setup's offers
  assert.match(text, /Next: open the bench in your browser/); // the next step, coral on "Open the bench"
  assert.match(text, /Give it to Copilot/);

  const [def] = api.mcp.provideMcpServerDefinitions();
  assert.ok(changes >= 1, 'definitions changed on open');
  assert.deepStrictEqual(Object.keys(def.headers).sort(), ['X-Lab-Agent-Token', 'X-Lab-Session']);
  assert.match(def.headers['X-Lab-Session'], /^\w+$/);
  assert.strictEqual(def.version, ext.packageJSON.version);
  if (process.env.PICODEV_LAB_TEST_MCP) {
    // the headers alone open the session's tools on the mock hub: a place in the real bench's queue, as Copilot would take it
    assert.strictEqual(def.uri.toString(true), process.env.PICODEV_LAB_TEST_MCP);
    const call = (name, args) => fetch(def.uri.toString(true), {
      method: 'POST', headers: { ...def.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    }).then((r) => r.json());
    const joined = await call('queue_join', { kind: 'nano' });
    assert.ok(!joined.result.isError, JSON.stringify(joined));
    const without = await call('queue_status', { session: 'nope' }); // an argument wins over the header
    assert.strictEqual(without.result._meta['lab.picodev.fr/error'], 'gone');
    // the Real bench tab: the setup's offer, the place; the Share tab: the hub's signed share
    await until(`real bench tab: ${text.slice(0, 400)}`, async () => /Place 1 of 1 in the queue of nano/.test((text = await api.viewText())));
    assert.match(text, /^Session\s+Challenge\s+Real bench\s+Log\s+Project\s+Share\s/i);
    assert.match(text, /nano\s+0\/1 free · 0 waiting/);
    assert.match(text, /Leave the queue/);
    assert.match(text, /lab\.picodev\.fr\/en\/p\/setup-a\.challenge\.1\.42\.A{16}/);
    assert.match(text, /1 level passed · 42 s/);
  }
  await api.showTab('project');
  await until(`tab after showTab: ${text.slice(-40)}`, async () => /\[tab project\]$/.test((text = await api.viewText())));
  assert.match(text, /Got a project\?/i);
  assert.match(text, /we help you formalize it/);
  assert.match(text, /Main function/); // the spec's sections, from spec-projet.md or still to write
  assert.doesNotMatch(text, /Bluesky/);

  // the Setup card (read_setup, once): setup-a's parts, and its schema.png decoded under the view's CSP (img-src data:)
  await until(`setup card: ${text.slice(-400)}`, async () =>
    /servo-arm/.test((text = await api.viewText())) && /\[image Schema of the setup [1-9]\d*x[1-9]\d*\]/.test(text));
  console.log('setup card:', /\[image Schema[^\]]*\]/.exec(text)[0]);
  assert.match(text, /Setup A · servo arm/); // the sheet's i18n.en title: the test VS Code is in English
  assert.match(text, /led-state/);
  assert.match(text, /value=220/);
  assert.match(text, /Probes\s+[\s\S]*D9\s+Scope/); // setup-a's probe D9, kind scope

  // the Lab panel frames the spectator page only; its scripts run only if the webview's sandbox allows scripts
  await vscode.commands.executeCommand('picodevLab.panel');
  await until(`panel: ${api.panelHtml().slice(0, 200)}`, () => /<iframe src="https:\/\/lab\.picodev\.fr\/w\/[^"]+#v=/.test(api.panelHtml()));
  assert.match(api.panelHtml(), /frame-src https:\/\/lab\.picodev\.fr;/);
  assert.strictEqual(api.panelScripts(), true);
  assert.match(api.panelHtml(), / · v\d+\.\d+\.\d+<\/footer>/); // which build is loaded
  assert.doesNotMatch(api.panelHtml(), /script-src|<script/); // the webview itself still runs none
  const src = () => /<iframe src="([^"]+)"/.exec(api.panelHtml())?.[1];
  const first = src();
  await vscode.commands.executeCommand('picodevLab.visibility', 'private');
  await until('panel when private', () => /private/.test(api.panelHtml()) && !src());
  await vscode.commands.executeCommand('picodevLab.visibility', 'link'); // a new viewer token: a new frame
  await until('panel back to link', () => src() && src() !== first);

  const before = changes;
  await vscode.commands.executeCommand('picodevLab.end');
  assert.strictEqual(api.statusText(), '$(beaker) Lab');
  assert.ok(changes > before, 'definitions changed on close');
  assert.deepStrictEqual(api.mcp.provideMcpServerDefinitions()[0].headers, {});
  sub.dispose();
  await until('panel after end', () => !/<iframe/.test(api.panelHtml()));
  await until('view after end', async () => /No lab session/.test((text = await api.viewText())));
  assert.match(text, /needs three things/);
  assert.match(text, /Create a starter sketch/);
};
