import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../human-log.js', import.meta.url), 'utf8');

const listeners = new Map();
const elements = new Map();
const storage = new Map();
const fakeDocument = {
  addEventListener(type, fn) { listeners.set(type, fn); },
  getElementById(id) { return elements.get(id) || null; },
};
const fakeWindow = {
  localStorage: {
    getItem(key) { return storage.get(key) ?? null; },
    setItem(key, value) { storage.set(key, String(value)); },
  },
  navigator: { userAgent: 'human-log-test' },
  performance: { now: () => 1000 },
  URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
  addEventListener() {},
  console,
};

vm.runInNewContext(source, {
  window: fakeWindow,
  document: fakeDocument,
  performance: fakeWindow.performance,
  console,
  setTimeout,
  clearTimeout,
  Math,
  Date,
  JSON,
});

assert.equal(typeof fakeWindow.toggleHumanLog, 'function');
assert.equal(typeof fakeWindow.exportHumanLogs, 'function');
assert.equal(typeof fakeWindow.clearHumanLogs, 'function');
assert.equal(typeof fakeWindow.humanLogBeginTurn, 'function');
assert.equal(typeof fakeWindow.humanLogRecordControl, 'function');
assert.equal(typeof fakeWindow.humanLogRecordPlacedBoard, 'function');
assert.equal(typeof fakeWindow.humanLogRecordWave, 'function');
assert.equal(typeof fakeWindow.humanLogFinishTurn, 'function');
assert.equal(typeof fakeWindow.humanLogGameOver, 'function');
assert.equal(typeof fakeWindow.humanLogRecordEvent, 'function');

// Disabled by default: control calls must be harmless and must not throw.
fakeWindow.humanLogRecordControl('left');
fakeWindow.humanLogRecordControl('hardDrop');

assert.match(source, /puyoAI-human-logs/);
assert.match(source, /boardBeforePlacement|boardAfterPlacement/);
assert.match(source, /upcomingPairs/);
assert.match(source, /humanLogRecordWave/);
assert.match(source, /benchmark-zip\.js/);

console.log('human log module smoke test passed');
