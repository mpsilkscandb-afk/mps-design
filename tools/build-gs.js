// Copies js/core.js to apps_script/Core.gs so the browser and the backend share one implementation.
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'js', 'core.js'), 'utf8');
fs.writeFileSync(path.join(root, 'apps_script', 'Core.gs'),
  '// GENERATED from js/core.js by tools/build-gs.js - do not edit here.\n' + src);
console.log('Core.gs written');
