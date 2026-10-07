'use strict';

// Runs a credential helper command named in the user's claude settings, read
// when claude asks for it. An agent home names this script instead of copying
// the command, which may hold the credential itself.
//
// usage: node auth-helper.js <settings.json> <apiKeyHelper|awsAuthRefresh|awsCredentialExport>

const fs = require('node:fs');
const cp = require('./commands');

const [file, key] = process.argv.slice(2);
let command;
try {
  command = JSON.parse(fs.readFileSync(file, 'utf8'))[key];
} catch (e) {
  process.stderr.write(`tower-crane: cannot read ${key} from ${file} (${e.message})\n`);
  process.exit(1);
}
if (typeof command !== 'string' || !command.trim()) {
  process.stderr.write(`tower-crane: ${file} no longer sets ${key}\n`);
  process.exit(1);
}
const r = cp.spawnSync(command, { shell: true, stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
