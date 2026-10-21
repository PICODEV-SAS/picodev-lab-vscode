// npm test: checks the French bundle, then runs test/suite.js in a throwaway VS Code (under xvfb-run on a
// headless Linux). The suite talks to the live lab, https://lab.picodev.fr: it opens a session and ends it.
const fs = require('fs');
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

runTests({
  extensionDevelopmentPath: root,
  extensionTestsPath: path.join(__dirname, 'suite.js'),
  cachePath: process.env.VSCODE_TEST_CACHE, // an already downloaded VS Code, if any
  launchArgs: ['--disable-extensions', '--password-store=basic'],
}).catch(() => process.exit(1));
