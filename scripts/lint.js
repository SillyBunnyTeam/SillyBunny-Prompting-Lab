import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const ignored = new Set(['.git', 'node_modules', 'playwright-report', 'test-results']);
const checkedExtensions = new Set(['.css', '.html', '.js', '.json', '.md', '.yml', '.yaml']);
const errors = [];

async function filesBelow(directory) {
    const result = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (ignored.has(entry.name)) {
            continue;
        }
        const location = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            result.push(...await filesBelow(location));
        } else if (checkedExtensions.has(path.extname(entry.name))) {
            result.push(location);
        }
    }
    return result;
}

for (const file of await filesBelow(root)) {
    const relative = path.relative(root, file);
    const content = await readFile(file, 'utf8');
    if (content.includes('\r')) {
        errors.push(`${relative}: use LF line endings`);
    }
    if (!content.endsWith('\n')) {
        errors.push(`${relative}: missing final newline`);
    }
    content.split('\n').forEach((line, index) => {
        if (/[ \t]+$/.test(line)) {
            errors.push(`${relative}:${index + 1}: trailing whitespace`);
        }
    });
    if (path.extname(file) === '.json') {
        try {
            JSON.parse(content);
        } catch (error) {
            errors.push(`${relative}: invalid JSON (${error.message})`);
        }
    }
    if (path.extname(file) === '.js') {
        const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
        if (check.status !== 0) {
            errors.push(`${relative}: ${check.stderr.trim() || 'syntax check failed'}`);
        }
    }
}

const packageData = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
if (packageData.version !== manifest.version) {
    errors.push('package.json and manifest.json versions differ');
}
if (packageData.license !== manifest.license) {
    errors.push('package.json and manifest.json licenses differ');
}

const indexSource = await readFile(path.join(root, 'index.js'), 'utf8');
for (const hook of Object.values(manifest.hooks ?? {})) {
    if (!new RegExp(`export\\s+(?:async\\s+)?function\\s+${hook}\\b`).test(indexSource)) {
        errors.push(`index.js does not export manifest hook ${hook}`);
    }
}

for (const file of (await filesBelow(path.join(root, 'src'))).filter(file => file.endsWith('.js'))) {
    if (path.basename(file) === 'host.js') {
        continue;
    }
    const source = await readFile(file, 'utf8');
    if (/\b(?:import|export)\s*(?:\(|[^;]*?from\s*)['"]\/scripts\//.test(source)) {
        errors.push(`${path.relative(root, file)}: deep host imports belong in src/host.js`);
    }
    if (/\.innerHTML\s*=/.test(source)) {
        errors.push(`${path.relative(root, file)}: render untrusted text with textContent`);
    }
}

if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
} else {
    console.log('Lint checks passed.');
}
