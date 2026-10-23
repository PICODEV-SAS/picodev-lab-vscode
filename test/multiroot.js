// Runs inside the test VS Code, in a workspace of two folders a and b (test/run.js): one session per folder, the one
// shown following the active file's folder.
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
  const api = await vscode.extensions.getExtension('picodev.picodev-lab').activate();
  const [a, b] = vscode.workspace.workspaceFolders;
  const show = (f) => vscode.window.showTextDocument(vscode.Uri.joinPath(f.uri, 'sketch.ino'));
  await show(a);
  await vscode.commands.executeCommand('picodevLab.challenge', 'setup-a');
  await until(`a's session: ${api.statusText()}`, () => /^\$\(beaker\) Lab · a · setup-a/.test(api.statusText()));
  // Copilot's server definition follows the folder: a's session in its headers, none for b (contract 0.20)
  const headers = () => api.mcp.provideMcpServerDefinitions()[0].headers;
  let changes = 0;
  const sub = api.mcp.onDidChangeMcpServerDefinitions(() => changes++);
  const mine = headers()['X-Lab-Session'];
  assert.ok(mine);
  await show(b);
  await until(`b has none: ${api.statusText()}`, () => api.statusText() === '$(beaker) Lab');
  assert.deepStrictEqual(headers(), {});
  await show(a);
  await until(`a's session back: ${api.statusText()}`, () => /^\$\(beaker\) Lab · a · setup-a/.test(api.statusText()));
  assert.strictEqual(headers()['X-Lab-Session'], mine);
  assert.ok(changes >= 2, `definitions changed on each switch: ${changes}`);
  sub.dispose();
  await vscode.commands.executeCommand('picodevLab.end');
  assert.strictEqual(api.statusText(), '$(beaker) Lab');
};
