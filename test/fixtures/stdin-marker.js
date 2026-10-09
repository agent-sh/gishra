'use strict';

// Loaded with --require before the hook bridge. It records the first read of
// fd 0, so a test can deliver hook input after the bridge is already reading.
const fs = require('node:fs');

for (const name of ['readFileSync', 'readSync']) {
  const read = fs[name];
  fs[name] = function readWithMarker(fd, ...args) {
    if (fd === 0) fs.writeFileSync(process.env.STDIN_MARKER, '');
    return read.call(this, fd, ...args);
  };
}
