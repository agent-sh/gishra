'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function fragments(root = ROOT) {
  const dir = path.join(root, 'changelog.d');
  return fs.readdirSync(dir).filter((name) => name !== 'README.md').sort().map((name) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*\.md$/.test(name) || !fs.statSync(path.join(dir, name)).isFile()) {
      throw new Error(`invalid changelog fragment: ${name}`);
    }
    const text = fs.readFileSync(path.join(dir, name), 'utf8').replace(/\r\n/g, '\n').trim();
    if (!text.startsWith('- ') || text.includes('\u2014')) {
      throw new Error(`changelog.d/${name} must contain a nonempty Markdown bullet without em dashes`);
    }
    return { name, text };
  });
}

function assemble(root = ROOT) {
  const archive = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').replace(/\r\n/g, '\n');
  if (!archive.startsWith('# Changelog\n')) throw new Error('CHANGELOG.md needs its Changelog heading');
  const entries = fragments(root).map((fragment) => fragment.text);
  return '# Changelog\n\n' + [...entries, archive.slice('# Changelog\n'.length).trim()].filter(Boolean).join('\n\n') + '\n';
}

if (require.main === module) {
  try {
    if (process.argv.length !== 2) throw new Error('usage: node scripts/changelog.js');
    process.stdout.write(assemble());
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { fragments, assemble };
