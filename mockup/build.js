// Assembles mockup/index.html from shell.html + design/tokens.css + screens/*.html
const fs = require('fs');
const path = require('path');

const root = __dirname;
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let out = read('shell.html');

out = out.replace('<!-- INLINE:TOKENS -->', '<style>\n' + read('design/tokens.css') + '\n</style>');

const screens = ['dashboard', 'work-orders', 'work-order-detail', 'vendors', 'admin'];
const missing = [];
for (const name of screens) {
  const marker = `<!-- INLINE:SCREEN:${name} -->`;
  const file = path.join(root, 'screens', name + '.html');
  if (!fs.existsSync(file)) { missing.push(name); continue; }
  out = out.replace(marker, fs.readFileSync(file, 'utf8'));
}

fs.writeFileSync(path.join(root, 'index.html'), out);
console.log('Wrote index.html (' + Math.round(out.length / 1024) + ' KB)');
if (missing.length) console.log('MISSING screens: ' + missing.join(', '));
