import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyRuntimePackages } from '../scripts/check-documentation.mjs';

test('fresh installation checks match each verified version regardless of npm hoisting', t => {
    const root = fs.mkdtempSync(path.join(tmpdir(), 'mcp-runtime-check-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    function pkg(directory, version) {
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'fixture', version }));
        fs.writeFileSync(path.join(directory, 'index.js'), `export default ${JSON.stringify(version)};`);
        fs.writeFileSync(path.join(directory, '.npmignore'), 'fixture-only\n');
    }
    const first = path.join(root, 'first'), second = path.join(root, 'second'), application = path.join(root, 'application');
    pkg(first, '1.0.0'); pkg(second, '2.0.0');
    // Source and fresh consumer legitimately resolve a different version at the root.
    pkg(path.join(first, 'node_modules/fixture'), '2.0.0');
    pkg(path.join(application, 'node_modules/fixture'), '2.0.0');
    pkg(path.join(application, 'node_modules/parent/node_modules/fixture'), '1.0.0');
    fs.writeFileSync(path.join(application, 'node_modules/.package-lock.json'), JSON.stringify({ packages: {
        'node_modules/fixture': { version: '2.0.0' }, 'node_modules/parent/node_modules/fixture': { version: '1.0.0' },
    } }));
    const entries = [{ manifest: { name: 'fixture', version: '1.0.0' }, source: first },
        { manifest: { name: 'fixture', version: '2.0.0' }, source: second }];
    verifyRuntimePackages(application, entries);
    const module = path.join(application, 'node_modules/fixture');
    fs.unlinkSync(path.join(module, '.npmignore'));
    assert.throws(() => verifyRuntimePackages(application, entries), /Unexpected package files/);
    fs.writeFileSync(path.join(module, '.npmignore'), 'fixture-only\n');
    fs.writeFileSync(path.join(module, 'index.js'), 'changed');
    assert.throws(() => verifyRuntimePackages(application, entries), /Package bytes differ/);
    pkg(module, '3.0.0');
    assert.throws(() => verifyRuntimePackages(application, entries), /Unverified runtime package/);
});
