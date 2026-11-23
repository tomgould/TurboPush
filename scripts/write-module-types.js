/**
 * Marks the two build outputs with their module format.
 *
 * The package root has no "type" field, so Node and TypeScript need a
 * package.json in each folder to know that dist/esm holds ES modules and
 * dist/cjs holds CommonJS.
 */
const fs = require('fs');
const path = require('path');

const outputs = { esm: 'module', cjs: 'commonjs' };

for (const [folder, type] of Object.entries(outputs)) {
    const file = path.join(__dirname, '..', 'dist', folder, 'package.json');
    fs.writeFileSync(file, JSON.stringify({ type }, null, 2) + '\n');
}
