'use strict';

const S = require('../../lib/state');
const Commands = require('../../lib/commands');
const mutate = S.mutate;
S.mutate = (ctx, cmd, fn, ...args) => mutate(ctx, cmd, (st, emit) => {
  if (cmd === 'task note') {
    if (process.env.TEST_LOCKED_COMMAND === 'git') S.git(['status'], ctx.cwd);
    else Commands.spawnSync('gh', ['pr', 'view', '11'], { cwd: ctx.cwd });
  }
  return fn(st, emit);
}, ...args);
