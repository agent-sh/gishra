'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo } = require('./helpers');

for (const command of ['git', 'gh']) {
  test(`a ${command} command inside a mutation refuses the whole CLI write`, (t) => {
    const h = makeRepo(t);
    h.init();
    h.ok(['task', 'add', '--title', 'Guard', '--acceptance', 'commands stay unlocked']);
    const before = fs.readFileSync(path.join(h.state, 'tasks.json'), 'utf8');
    const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8');
    const hook = path.join(__dirname, 'fixtures', 'locked-command.js');
    const r = h.run(['task', 'note', 'T1', 'must not be written'], { env: {
      TEST_LOCKED_COMMAND: command, NODE_OPTIONS: `--require=${JSON.stringify(hook)}`,
    } });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /cannot run inside a state mutation/);
    assert.equal(fs.readFileSync(path.join(h.state, 'tasks.json'), 'utf8'), before);
    assert.equal(fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8'), events);
    h.ok(['task', 'note', 'T1', 'guard released after refusal']);
  });
}
