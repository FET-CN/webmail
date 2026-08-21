import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCUMENT = 'src/document.html';
const TEMPLATES = 'src/templates/app.html';
export const GENERATED_DOCUMENTS = [
    'index.html',
    'backend/public/index.html'
];

export const STYLE_FILES = [
    'src/styles/base.css',
    'src/styles/shell.css',
    'src/styles/mail.css',
    'src/styles/overlays.css'
];

// Classic scripts intentionally remain in dependency order so the generated
// file keeps the same runtime model as the original single-file application.
export const SCRIPT_FILES = [
    'src/js/mail/imap-client.js',
    'src/js/mail/imap-mailbox.js',
    'src/js/mail/message.js',
    'src/js/mail/message-headers.js',
    'src/js/mail/smtp-client.js',
    'src/js/storage/settings.js',
    'src/js/storage/indexed-db.js',
    'src/js/storage/migrate.js',
    'src/js/mail/format.js',
    'src/js/platform/logging.js',
    'src/js/platform/status.js',
    'src/js/platform/notifications.js',
    'src/js/platform/template-registry.js',
    'src/js/platform/prompts.js',
    'src/js/ui/view.js',
    'src/js/ui/login-view.js',
    'src/js/ui/account-view.js',
    'src/js/ui/address-manage-view.js',
    'src/js/ui/admin-approvals-view.js',
    'src/js/ui/mailbox-view.js',
    'src/js/ui/message-view.js',
    'src/js/ui/compose-view.js',
    'src/js/ui/storage-view.js',
    'src/js/ui/mailbox-manage-view.js',
    'src/js/ui/settings-view.js',
    'src/js/ui/logs-view.js',
    'src/js/config.js',
    'src/js/main.js'
];

function read(relativePath) {
    const absolutePath = path.join(ROOT, relativePath);
    if (!fs.existsSync(absolutePath)) {
        throw new Error(`Missing build input: ${relativePath}`);
    }
    return fs.readFileSync(absolutePath, 'utf8').replace(/\r\n/g, '\n');
}

function sourceBlock(relativePath, tagName, attributes = '') {
    const content = read(relativePath).replace(/\n?$/, '\n');
    return `<${tagName} data-source="${relativePath}"${attributes}>\n${content}</${tagName}>`;
}

function replaceMarker(document, marker, replacement) {
    const occurrences = document.split(marker).length - 1;
    if (occurrences !== 1) {
        throw new Error(`Expected exactly one ${marker} marker, found ${occurrences}`);
    }
    // A function replacement keeps literal `$&`, `$1`, and similar text in
    // source files from being interpreted by String.prototype.replace.
    return document.replace(marker, () => replacement);
}

export function renderDocument() {
    let document = read(DOCUMENT);
    const styles = STYLE_FILES
        .map((file) => sourceBlock(file, 'style'))
        .join('\n\n');
    const templates = read(TEMPLATES).replace(/\n?$/, '\n');
    const scripts = SCRIPT_FILES
        .map((file) => sourceBlock(file, 'script', ' type="text/javascript"'))
        .join('\n\n');

    document = replaceMarker(document, '<!-- @inject styles -->', styles);
    document = replaceMarker(document, '<!-- @inject templates -->', templates);
    document = replaceMarker(document, '<!-- @inject application -->', scripts);
    return document;
}

function writeDocument(document) {
    for (const output of GENERATED_DOCUMENTS) {
        const outputPath = path.join(ROOT, output);
        const temporaryPath = `${outputPath}.tmp-${process.pid}`;
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(temporaryPath, document);
        fs.renameSync(temporaryPath, outputPath);
    }
}

function run() {
    const isCheck = process.argv.includes('--check');
    const rendered = renderDocument();

    if (isCheck) {
        for (const output of GENERATED_DOCUMENTS) {
            const outputPath = path.join(ROOT, output);
            const current = fs.readFileSync(outputPath, 'utf8').replace(/\r\n/g, '\n');
            if (current !== rendered) {
                console.error(`${output} is out of date; run node scripts/build.mjs`);
                process.exitCode = 1;
            }
        }
        if (!process.exitCode) {
            console.log('Generated documents are up to date');
        }
    } else {
        writeDocument(rendered);
        console.log(`Generated ${GENERATED_DOCUMENTS.join(' and ')}`);
    }
}

// Keep imports read-only so validation scripts can use renderDocument()
// without rewriting the generated artifact.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    run();
}
