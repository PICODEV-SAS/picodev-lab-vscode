// npm test: checks the French bundle, then runs test/suite.js in a throwaway VS Code (under xvfb-run on a
// headless Linux). The suite opens a session and ends it on a local mock hub (test/mock-hub.js);
// PICODEV_LAB_LIVE=1 runs it against the live lab, https://lab.picodev.fr, instead.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { runTests } = require('@vscode/test-electron');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'src/extension.ts'), 'utf8');
const fr = require('../l10n/bundle.l10n.fr.json');
const keys = [...src.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\(.)/g, '$1'));
assert.deepStrictEqual(keys.filter((k) => !(k in fr)), [], 'strings missing from l10n/bundle.l10n.fr.json');
assert.deepStrictEqual(Object.keys(fr).filter((k) => !keys.includes(k)), [], 'unused strings in l10n/bundle.l10n.fr.json');
const nls = (f) => Object.keys(require(path.join(root, f))).sort();
assert.deepStrictEqual(nls('package.nls.fr.json'), nls('package.nls.json'), 'package.nls.fr.json out of step');

(async () => {
  const mock = process.env.PICODEV_LAB_LIVE ? undefined : await require('./mock-hub').start();
  try {
    const run = (suite, ...args) => runTests({
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, suite),
      extensionTestsEnv: mock ? { PICODEV_LAB_TEST_MCP: mock.url } : {},
      cachePath: process.env.VSCODE_TEST_CACHE, // an already downloaded VS Code, if any
      launchArgs: [...args, '--disable-extensions', '--password-store=basic'],
    });
    await run('suite.js');
    // a multi-root workspace: two folders with a sketch each, no git offer, no push on save
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'picodev-lab-test-'));
    for (const d of ['a', 'b']) {
      fs.mkdirSync(path.join(ws, d));
      fs.writeFileSync(path.join(ws, d, 'sketch.ino'), 'void setup() {}\nvoid loop() {}\n');
    }
    const file = path.join(ws, 'lab.code-workspace');
    fs.writeFileSync(file, JSON.stringify({ folders: [{ path: 'a' }, { path: 'b' }], settings: { 'picodevLab.git': false, 'picodevLab.autoPush': false } }));
    await run('multiroot.js', file);
    fs.rmSync(ws, { recursive: true, force: true });
  } catch {
    process.exitCode = 1;
  } finally {
    mock?.close();
  }
})();
