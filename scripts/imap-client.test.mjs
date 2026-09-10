import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(
    new URL('../src/js/mail/imap-client.js', import.meta.url), 'utf8'
);
const encoder = new TextEncoder();

async function createClient() {
    class Socket {
        static OPEN = 1;
        readyState = Socket.OPEN;
        sent = [];

        send(bytes) {
            this.sent.push(new TextDecoder().decode(bytes));
        }

        close(code = 1000) {
            this.readyState = 3;
            return this.onclose?.({ code });
        }
    }

    const context = vm.createContext({
        TextEncoder, TextDecoder, Uint8Array, Blob,
        WebSocket: Socket,
        window: { clearTimeout, setTimeout },
        document: { querySelector: () => ({ classList: { remove() {} } }) },
        log() {}, DEBUG: 0, NET: 0, WARN: 0,
    });
    const Client = vm.runInContext(`${source}\nImapClient;`, context);
    for (const file of ['format', 'message-headers', 'message', 'imap-mailbox']) {
        vm.runInContext(readFileSync(
            new URL(`../src/js/mail/${file}.js`, import.meta.url), 'utf8'
        ), context);
    }
    const Mailbox = vm.runInContext('ImapMailbox;', context);
    const client = new Client('ws://imap.test');
    client.noopStartTimeout = () => {};
    const connected = client.connect();
    await client.ws.onopen();
    const receive = bytes => client.ws.onmessage({
        data: typeof bytes === 'string' ? encoder.encode(bytes).buffer : bytes.buffer,
    });
    await receive('* OK IMAP ready\r\n');
    await connected;
    return { client, receive, Mailbox };
}

async function flushCommands() {
    await new Promise(resolve => setImmediate(resolve));
}

async function completes(promise) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('IMAP command stuck')), 250);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

test('refresh completes when SELECT response codes arrive in separate frames', async () => {
    const response = encoder.encode('* OK [HIGHESTMODSEQ 42]\r\nC0001 OK Selected\r\n');
    for (let split = 1; split < response.length; split++) {
        const { client, receive } = await createClient();
        const responses = [];
        client.mailboxes.INBOX = { onResponse: value => responses.push(value) };
        client.isNotify = true;
        const refresh = client.select('INBOX');
        await flushCommands();
        await receive(response.slice(0, split));
        await receive(response.slice(split));
        await completes(refresh);
        assert.equal(responses[0].highestmodseq, 42, `split ${split}`);
        assert.equal(client.responseBuffer.byteLength, 0);
    }
});

test('message FETCH and the following refresh survive every byte split', async () => {
    const body = 'Subject: test\r\n\r\nA message body: \u90ae\u4ef6.\r\n';
    const response = encoder.encode(
        `* 1 FETCH (UID 7 MODSEQ (42) BODY[] {${encoder.encode(body).length}}\r\n`
        + `${body})\r\nC0001 OK Fetched\r\n`
    );
    for (let split = 1; split < response.length; split++) {
        const { client, receive } = await createClient();
        const fetched = [];
        client.selected = { onFetch: (seq, value) => fetched.push(value) };
        const loading = client.fetch(7, true);
        await flushCommands();
        await receive(response.slice(0, split));
        await receive(response.slice(split));
        await completes(loading);
        assert.equal(fetched.length, 1, `split ${split}: missing or duplicate FETCH`);
        assert.equal(fetched[0].body, body, `split ${split}: incorrect body`);
        const refresh = client.noop();
        await flushCommands();
        await receive('C0002 OK Refreshed\r\n');
        await completes(refresh);
        assert.equal(client.responseBuffer.byteLength, 0);
    }
});

test('a partial response code does not poison subsequent WebSocket responses', async () => {
    const { client, receive } = await createClient();
    client.mailboxes.INBOX = { onResponse() {} };
    client.isNotify = true;
    const refresh = client.select('INBOX');
    await flushCommands();
    // The bridge forwards arbitrary TCP chunks, including a split after '['.
    await receive('* OK [').catch(() => {});
    await receive('HIGHESTMODSEQ 42]\r\nC0001 OK Selected\r\n').catch(() => {});
    await completes(refresh);

    const loading = client.fetch(7, true);
    await flushCommands();
    await receive('C0002 OK Fetched\r\n');
    await completes(loading);
});

test('response text consumes UTF-8 bytes before the next FETCH', async () => {
    const { client, receive } = await createClient();
    const fetched = [];
    client.selected = {
        onResponse() {},
        onFetch: (seq, value) => fetched.push(value),
    };
    const loading = client.fetch(7, true);
    await flushCommands();
    await receive('* OK [HIGHESTMODSEQ 42] \u90ae\u4ef6\r\n');
    await receive('* 1 FETCH (UID 7 FLAGS (\\Seen))\r\nC0001 OK \u5b8c\u6210\r\n');
    await completes(loading);
    assert.equal(fetched.length, 1);
    assert.equal(client.responseBuffer.byteLength, 0);
});

test('a failing mailbox callback rejects loading instead of leaving it pending', async () => {
    const { client, receive } = await createClient();
    client.selected = { onFetch() { throw new Error('Mailbox write failed'); } };
    const loading = client.fetch(7, true);
    const rejected = assert.rejects(loading, /Mailbox write failed/);
    await flushCommands();
    await receive('* 1 FETCH (UID 7 FLAGS ())\r\nC0001 OK Fetched\r\n')
        .catch(() => {});
    await completes(rejected);
    assert.equal(client.ws.readyState, 3);

    const connected = client.connect();
    await client.ws.onopen();
    await receive('* OK IMAP ready\r\n');
    await completes(connected);
    const refresh = client.noop();
    await flushCommands();
    await receive('C0002 OK Refreshed\r\n');
    await completes(refresh);
});

test('disconnect rejects the command that was waiting for a response', async () => {
    const { client } = await createClient();
    const loading = client.fetch(7, true);
    const rejected = assert.rejects(loading, /connection closed/i);
    await flushCommands();
    await client.ws.close(1006);
    await completes(rejected);
});

test('the refresh view exits its loading state when IMAP fails', async () => {
    const statuses = [];
    const context = vm.createContext({
        View: class {
            constructor() { this.el = {}; }
            addEventListener() {}
        },
        set_status: (...args) => statuses.push(args),
    });
    const viewSource = readFileSync(
        new URL('../src/js/ui/mailbox-view.js', import.meta.url), 'utf8'
    );
    const MailboxView = vm.runInContext(`${viewSource}\n_MailboxView;`, context);
    const error = new Error('IMAP connection closed');
    const view = new MailboxView({
        mailbox: 'INBOX',
        async load() { throw error; },
    });
    await view.refresh();
    assert.equal(statuses[0][1], 'LOAD');
    assert.equal(statuses.at(-1)[0], 'ERR');
    assert.equal(statuses.at(-1)[2], error);
});

test('a send failure clears the active command callbacks', async () => {
    const { client } = await createClient();
    client.ws.send = () => { throw new Error('Socket send failed'); };
    await assert.rejects(client.fetch(7, true), /Socket send failed/);
    assert.equal(client._oncommanderror, null);
    assert.equal(client._onmessage, null);
});

async function createMailbox() {
    const harness = await createClient();
    const mailbox = new harness.Mailbox(harness.client, 'test@example.test', 'INBOX');
    mailbox.clear();
    mailbox.uidvalidity = 1;
    mailbox.storage = { async put() {}, async get() {} };
    harness.client.mailboxes.INBOX = mailbox;
    harness.client.selected = mailbox;
    harness.client.isNotify = true;
    return { ...harness, mailbox };
}

const headers = 'From: sender@example.test\r\nSubject: test\r\n\r\n';

function headerFetch(uid = 7) {
    return `* 1 FETCH (UID ${uid} FLAGS (\\Seen) BODY[HEADER.FIELDS (FROM SUBJECT)] `
        + `{${encoder.encode(headers).length}}\r\n${headers})\r\n`;
}

test('INBOX load fetches headers after an unknown UID receives only metadata', async () => {
    const { client, receive, mailbox } = await createMailbox();
    const loading = mailbox.load();
    // Attach immediately: the unfixed mailbox throws while handling SELECT.
    const completed = completes(loading);
    await flushCommands();
    await receive('* 1 FETCH (UID 7 FLAGS (\\Seen) MODSEQ (42))\r\n');
    await receive('* 1 FETCH (UID 7 FLAGS (\\Seen) MODSEQ (43))\r\n');
    await receive('C0001 OK Selected\r\n');
    await flushCommands();
    assert.equal(client.ws.sent.length, 2);
    assert.match(client.ws.sent[1], /^C0002 UID FETCH 7 \(UID MODSEQ FLAGS BODY.PEEK/);
    await receive(headerFetch() + 'C0002 OK Fetched\r\n');
    await completed;
    assert.equal(mailbox.messages[7].headers.get('subject', 'one'), 'test');
    assert.equal(mailbox.uidFetchQueue.length, 0);
});

test('metadata-only FETCH preserves an already parsed message', async () => {
    const { receive, mailbox } = await createMailbox();
    await receive(headerFetch());
    assert.equal(mailbox.messages[7].loaded, true);
    await receive('* 1 FETCH (UID 7 FLAGS (\\Flagged) MODSEQ (43))\r\n');
    assert.equal(mailbox.messages[7].loaded, true);
    assert.equal(mailbox.messages[7].headers.get('subject', 'one'), 'test');
    assert.equal(mailbox.messages[7].flags[0], '\\Flagged');
});

test('loading a message requests its UID alongside the complete body', async () => {
    const { client, receive, mailbox } = await createMailbox();
    await receive(headerFetch());
    const loading = mailbox.loadMessage(7);
    await flushCommands();
    assert.equal(client.ws.sent[0], 'C0001 UID FETCH 7 (UID MODSEQ FLAGS BODY.PEEK[])\r\n');
    const body = headers + 'Full message body.\r\n';
    await receive(`* 1 FETCH (UID 7 BODY[] {${encoder.encode(body).length}}\r\n`
        + body + ')\r\nC0001 OK Fetched\r\n');
    await completes(loading);
    await mailbox.messages[7].loadMessage();
    assert.equal(mailbox.messages[7].body, 'Full message body.\r\n');
});

test('a sequence header fetch satisfies the queued UID without a duplicate request', async () => {
    const { client, receive, mailbox } = await createMailbox();
    await receive('* 1 EXISTS\r\n* 1 FETCH (UID 7 FLAGS ())\r\n');
    assert.equal(Object.keys(mailbox.messages).length, 0);
    const loading = mailbox.fetchFromQueue();
    await flushCommands();
    assert.match(client.ws.sent[0], /^C0001 FETCH 1 /);
    await receive(headerFetch() + 'C0001 OK Fetched\r\n');
    await completes(loading);
    assert.equal(client.ws.sent.length, 1);
    assert.equal(mailbox.uidFetchQueue.length, 0);
    assert.equal(mailbox.seqFetchQueue.length, 0);
});

test('metadata received during a header fetch remains queued for the next batch', async () => {
    const { client, receive, mailbox } = await createMailbox();
    await receive('* 1 FETCH (UID 7 FLAGS ())\r\n');
    const loading = mailbox.fetchFromQueue();
    await flushCommands();
    await receive(headerFetch() + '* 2 FETCH (UID 9 FLAGS ())\r\nC0001 OK Fetched\r\n');
    await flushCommands();
    assert.match(client.ws.sent[1] || '', /^C0002 UID FETCH 9 /);
    await receive(headerFetch(9) + 'C0002 OK Fetched\r\n');
    await completes(loading);
    assert.equal(mailbox.messages[9].headers.get('subject', 'one'), 'test');
});

test('opening INBOX preserves SELECT errors without trying to create it', async () => {
    const { client, receive } = await createClient();
    client.isNotify = true;
    const loading = client.select('INBOX');
    const outcome = loading.catch(error => error);
    await flushCommands();
    await receive('C0001 NO [NONEXISTENT] Mailbox unavailable\r\n');
    await flushCommands();
    // Replay the reported secondary error if SELECT attempted CREATE.
    if(client.ws.sent.length > 1) {
        await receive('C0002 NO [ALREADYEXISTS] Mailbox already exists\r\n');
    }
    const error = await completes(outcome);
    assert.match(error.message, /^\[NONEXISTENT\] Mailbox unavailable$/);
    assert.deepEqual(client.ws.sent, ['C0001 SELECT "INBOX"\r\n']);
    assert.equal(client.selected, null);
});

test('session login failure closes the socket without an unauthenticated CLOSE', async () => {
    const { client, receive } = await createClient();
    client.capabilities.add('AUTH=PLAIN');
    client.connect = async () => {};
    const statuses = [];
    const context = vm.createContext({
        View: class {},
        ImapClient: class { constructor() { return client; } },
        window: { config: { imap_server: 'ws://imap.test' } },
        document: { querySelector: () => ({ style: {} }) },
        request_notifications() {},
        set_status: (...args) => statuses.push(args),
        log() {}, ERR: 0,
    });
    const source = readFileSync(
        new URL('../src/js/ui/login-view.js', import.meta.url), 'utf8'
    );
    const LoginView = vm.runInContext(`${source}\n_LoginView;`, context);
    const login = LoginView.prototype.loginFromSession.call({}, {
        current_mailbox_id: 'mailbox-1',
        mailboxes: [{ id: 'mailbox-1', state: 'active', address: 'test@example.test' }],
    });
    const outcome = login.catch(error => error);
    await flushCommands();
    await receive('C0001 NO [AUTHENTICATIONFAILED] Invalid credentials\r\n');
    await flushCommands();
    if(client.ws.sent.length > 1) {
        await receive('C0002 BAD Command not supported before authentication\r\n');
    }
    const error = await completes(outcome);
    assert.match(error?.message || '', /\[AUTHENTICATIONFAILED\]/);
    assert.equal(client.ws.sent.length, 1);
    assert.equal(client.ws.readyState, 3);
    assert.equal(client.reconnect, false);
    assert.match(statuses.at(-1)[2].message, /\[AUTHENTICATIONFAILED\]/);
});
