import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LeakDetector } from '../src/index.js';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('LeakDetector exports a class', () => {
    assert.strictEqual(typeof LeakDetector, 'function');
});

let tempDir;
test('setup temp dir', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'leak-detector-'));
});

const makeFile = (name) => {
    const p = join(tempDir, name);
    writeFileSync(p, 'data');
    return p;
};

await test('open and close tracks descriptors', async () => {
    const det = new LeakDetector();
    const path = makeFile('a.txt');
    const h = await det.open(path, 'r');
    assert.strictEqual(det.getOpenCount(), 1);
    await det.close(h);
    assert.strictEqual(det.getOpenCount(), 0);
});

await test('checkLeaks returns empty array when nothing is open', () => {
    const det = new LeakDetector();
    assert.deepStrictEqual(det.checkLeaks(), []);
});

await test('checkLeaks throws when open count exceeds threshold', async () => {
    const det = new LeakDetector({ threshold: 0 });
    const path = makeFile('b.txt');
    const h = await det.open(path, 'r');
    assert.throws(() => det.checkLeaks(), /File descriptor leak detected/);
    await det.close(h);
});

await test('checkLeaks passes when open count equals threshold', async () => {
    const det = new LeakDetector({ threshold: 1 });
    const path = makeFile('c.txt');
    const h = await det.open(path, 'r');
    const open = det.checkLeaks();
    assert.strictEqual(open.length, 1);
    await det.close(h);
});

await test('getOpenDescriptors reports path and flags', async () => {
    const det = new LeakDetector();
    const path = makeFile('d.txt');
    const h = await det.open(path, 'r');
    const desc = det.getOpenDescriptors();
    assert.strictEqual(desc.length, 1);
    assert.strictEqual(desc[0].path, path);
    assert.strictEqual(desc[0].flags, 'r');
    assert.strictEqual(typeof desc[0].fd, 'number');
    assert.strictEqual(typeof desc[0].openedAt, 'number');
    await det.close(h);
});

await test('uses injected clock for openedAt', async () => {
    let ticks = 1000;
    const now = () => { ticks += 500; return ticks; };
    const det = new LeakDetector({ now });
    const path = makeFile('e.txt');
    const h = await det.open(path, 'r');
    const desc = det.getOpenDescriptors();
    assert.strictEqual(desc[0].openedAt, 1500);
    await det.close(h);
});

await test('double close leaves registry clean', async () => {
    const det = new LeakDetector();
    const path = makeFile('f.txt');
    const h = await det.open(path, 'r');
    await det.close(h);
    assert.strictEqual(det.getOpenCount(), 0);
});

await test('cleanup closes all tracked descriptors', async () => {
    const det = new LeakDetector();
    const p1 = makeFile('g.txt');
    const p2 = makeFile('h.txt');
    await det.open(p1, 'r');
    await det.open(p2, 'r');
    assert.strictEqual(det.getOpenCount(), 2);
    const closed = await det.cleanup();
    assert.strictEqual(closed.length, 2);
    assert.strictEqual(det.getOpenCount(), 0);
});

await test('threshold must be non-negative finite number', () => {
    assert.throws(() => new LeakDetector({ threshold: -1 }), /threshold must be a non-negative finite number/);
    assert.throws(() => new LeakDetector({ threshold: Infinity }), /threshold must be a non-negative finite number/);
    assert.throws(() => new LeakDetector({ threshold: NaN }), /threshold must be a non-negative finite number/);
});

await test('open passes through mode argument', async () => {
    const det = new LeakDetector();
    const path = join(tempDir, 'mode-test.txt');
    // mode 0o600 = rw owner only; default file creation mode may differ.
    const h = await det.open(path, 'w', 0o600);
    assert.ok(h.fd >= 0);
    await det.close(h);
});

test('teardown temp dir', () => {
    rmSync(tempDir, { recursive: true, force: true });
});
