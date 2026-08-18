import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
    renderDocument,
    STYLE_FILES,
    SCRIPT_FILES
} from './build.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const current = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
    .replace(/\r\n/g, '\n');
const rendered = renderDocument();

if (current !== rendered) {
    throw new Error('index.html does not match the current source files');
}

for (const marker of [
    '<!-- @inject styles -->',
    '<!-- @inject templates -->',
    '<!-- @inject application -->'
]) {
    if (current.includes(marker)) {
        throw new Error(`Generated document still contains ${marker}`);
    }
}

function assertInlineSource(tagName, file) {
    const marker = `<${tagName} data-source="${file}"`;
    const start = current.indexOf(marker);
    if (start < 0) throw new Error(`Missing generated ${tagName} block: ${file}`);

    const contentStart = current.indexOf('>', start) + 1;
    const contentEnd = current.indexOf(`</${tagName}>`, contentStart);
    const actual = current.slice(contentStart, contentEnd).replace(/^\n/, '');
    const expected = fs.readFileSync(path.join(ROOT, file), 'utf8')
        .replace(/\r\n/g, '\n')
        .replace(/\n?$/, '\n');

    if (actual !== expected) {
        throw new Error(`Generated ${tagName} content differs from ${file}`);
    }
}

for (const file of STYLE_FILES) assertInlineSource('style', file);
for (const file of SCRIPT_FILES) assertInlineSource('script', file);

for (const file of SCRIPT_FILES) {
    const result = spawnSync(process.execPath, ['--check', path.join(ROOT, file)], {
        encoding: 'utf8'
    });
    if (result.status !== 0) {
        process.stderr.write(result.stderr || result.stdout);
        throw new Error(`JavaScript syntax check failed: ${file}`);
    }
}

const generatedSources = (current.match(/data-source="([^"]+)"/g) || []).length;
const expectedSources = SCRIPT_FILES.length + 4;
if (generatedSources !== expectedSources) {
    throw new Error(`Expected ${expectedSources} generated source blocks, found ${generatedSources}`);
}

console.log(`Generated file and ${SCRIPT_FILES.length} JavaScript sources are valid`);
