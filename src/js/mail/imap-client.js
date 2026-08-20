//---------------------------------IMAP Client--------------------------------

class ImapClient {
    constructor(imapURL=window.config.imap_server) {
        this.imapURL = imapURL;

        // WebSocket
        this.ws = null; // Set in connect()
        this.latency = 0;

        // Buffers, Queues, Promises
        this.responseBuffer = new Uint8Array();
        this.commandQueue = Promise.resolve();
        this.responseQueue = Promise.resolve();

        // Server info
        this.capabilities = new Set();
        this.mailboxes = {};
        this.namespaces = {};
        this.namespaces_invert = {};

        // State flags
        this.connected = false;        // Socket open
        this.reconnect = true;         // Reconnect on socket close
        this.receivedGreeting = false; // Server is alive
        this.loggedin = false;         // Currently logged in
        this.isNotify = false;         // Has enabled NOTIFY
        this.enabled = [];             // Enabled capabilities

        // State info
        this.tagPrefix = "C";      // Tag prefix
        this.tag = 1;              // Tag next increment
        this.username = null;      // Set if ever logged in
        this.idleTag = null;       // Current IDLE tag
        this.selected = null;      // Open mailbox
        this.commandState = null;  // State info for commands that don't fit in a single message

        // Defaults
        this.defaultNotifySelected = 'FlagChange MessageNew (UID MODSEQ FLAGS BODY.PEEK[HEADER.FIELDS (From Subject Date To CC BCC)] RFC822.SIZE) MessageExpunge';
        this.defaultNotifyPersonal = 'FlagChange MessageNew MailboxName MessageExpunge';
        this.defaultNotifyUsers = this.defaultNotifyPersonal;
        this.defaultNotifyShared = this.defaultNotifyPersonal;

        // Public (settable) Callbacks
        this.onopen = null;    // On socket open and received greeting
        this.onclose = null;   // On socket close
        this.onmessage = null; // On any partial or full message from IMAP
        this.onerror = null;   // On socket open
        this.onnotify = null;      // On NOTIFY start

        // Global (internal) callbacks
        this.onlist = this.onList; // On LIST untagged response
        this.oncreate = null;      // On mailbox create
        this.onrename = null;      // On mailbox rename
        this.ondelete = null;      // On mailbox delete

        // Internal Callbacks
        this._onopen = null;    // On socket open and received greeting
        this._onconnecterror = null; // Connection failure before greeting
        this._onclose = null;   // On socket close
        this._onmessage = null; // On partial or full message
        this._onerror = null;   // On socket error
        this._onfetch = null;   // On partial fetch response

        // Internal timeouts
        this._noopTimeout = null;        // Timeout to send NOOP (prevents timeout)
        this._idleStartTimeout = null;   // Timeout to start IDLE after commands
        this._idleRestartTimeout = null; // Timeout to restart IDLE after a period of inactivity

        // IMAP Special Use Mailboxes (auto-detected)
        this.inbox = null;
        this.trash = null;
        this.sent = null;
        this.drafts = null;
        this.junk = null;
        this.archive = null;

        // Engines
        this.encoder = new TextEncoder();
        this.decoder = new TextDecoder('utf-8');
    }

    // Wait for connection to complete and receive greeting
    async connect() {
        this.receivedGreeting = false;

        // WebSocket
        this.ws = new WebSocket(this.imapURL);
        this.ws.binaryType = "arraybuffer";
        this.ws.onopen = this.#onWsOpen;
        this.ws.onclose = this.#onWsClose;
        this.ws.onerror = this.#onWsError;
        this.ws.onmessage = this.#onWsMessage;

        this._onmessage = this.#handleGreetingResponse;

        //if (this.ws.readyState === WebSocket.OPEN) return;
        return new Promise((resolve, reject) => {
            this._onopen = resolve;
            this._onconnecterror = reject;
        });
    }

    // Assign a new IMAP tag
    #tag() { return `${this.tagPrefix}${(this.tag++).toString().padStart(4,"0")}`; }

    // Send raw string to socket, plus CRLF
    #send(cmd,containsPass) {
        if (this.ws.readyState !== WebSocket.OPEN) throw new Error("Not connected");

        const logmsg = containsPass
            ? cmd.replace(/(LOGIN [^\s]*) .*/,'$1 "hunter2"')
            : cmd;

        log('imap_out',logmsg,NET);

        const arrayBuffer = this.encoder.encode(cmd + "\r\n").buffer;
        this.ws.send(arrayBuffer);
    }

    // Run an IMAP command and set finish and progress callbacks
    async #command(cmd, handler=this.#handleCommandResponse, onActivity=null, containsPass=false) {
        await this.idleStop();

        await this.commandQueue;

        const new_promise = this.commandQueue.then(() => {
            const tag = this.#tag();
            const promises = [];

            handler = handler.bind(this, tag);

            const finishPromise = new Promise((resolve, reject) => {
                handler = handler.bind(this, (ok, data, rest) => {
                    log('imap','#command: finishCallback',DEBUG,cmd);
                    this.noopStartTimeout();
                    if (ok) {
                        resolve({ data, rest });
                    } else {
                        reject(new Error(data || "Command failed"));
                    }
                });
            });

            if(onActivity) {
                handler = handler.bind(this,onActivity);
            }

            this._onmessage = handler;
            this.#send(`${tag} ${cmd}`, containsPass);

            return finishPromise;

        });

        this.commandQueue = new_promise.catch(() => {});

        return new_promise;
    }

    // ------------------IMAP commands--------------------

    // CAPABILITY: Get IMAP server capabilities
    // Sets latency
    async capability() {
        const start = Date.now();
        const { data, rest } = await this.#command("CAPABILITY");
        const end = Date.now();
        this.latency = end - start;

        for(const line of rest) {
            if(line.startsWith("* CAPABILITY")) {
                const capabilities = line.replace(/^\* CAPABILITY /,"").split(" ");
                this.#setCapabilities(capabilities);
            }
        }

        return this.capabilities;
    }

    // ENABLE: Enable capabilities
    async enable(capabilities) {
        if(!Array.isArray(capabilities)) capabilities = [ capabilities ];

        for(const capability of capabilities) {
            if(!this.capabilities.has(capability)) {
                throw `${capability} not supported by IMAP server!`;
            }
        }

        await this.#command(`ENABLE ${capabilities.join(' ')}`);

        for(const capability of capabilities) {
            this.enabled.push(capability);
        }
    }

    // LOGIN: Log in with a given username and password
    async login(user, pass) {
        pass = escapePassword(pass);

        if(!this.capabilities) {
            await this.capabilities();
        }
        if(!this.capabilities.has("AUTH=PLAIN")) {
            throw "Server has no AUTH=PLAIN capability!";
        }

        const { data } = await this.#command(`LOGIN "${user}" "${pass}"`, undefined, undefined, true);

        this.loggedin = true;
        this.username = user;
        this.onlogin?.();

        const updatedCapabilities = this.#checkForCapabilities(data);

        if(!updatedCapabilities) {
            await this.capability();
        }

        await this.enable('QRESYNC');

        return data;
    }

    // LOGOUT: Log out and close connection
    async logout() {
        await this.idleStop();
        await this.#command("LOGOUT");

        const wait_close = new Promise((resolve, reject) => {
            this._onclose = () => {
                resolve();
            };
        });

        await this.ws.close();
        await wait_close;
    }

    // NAMESPACE: Define collections of personal, users, and shared mailboxes.
    // Mostly used for fetching global delimiter.
    // Sets latency
    async namespace() {
        // C: NAMESPACE
        // S: * NAMESPACE (("" "/")("alt." "." "X-PARAM")) NIL NIL

        const start = Date.now();
        const { data, rest } = await this.#command("NAMESPACE");
        const end = Date.now();
        this.latency = end - start;

        const namespaces = {
            personal: [],
            users: [],
            shared: []
        };

        const namespace_types = ['personal', 'users', 'shared'];

        const match_start = rest.match(/\* NAMESPACE /);

        var pos = match_start.index + match_start[0].length;

        var png = false; // Matches first ( that separates personal/users/shared namespace groups
        var pns = false; // Matches second ( that separates namespaces
        var ps = false;  // Matches strings
        var pni = 0;     // Which namespace group is being added to
        var cng = null;  // Current namespace group object
        var cns = null;  // Current namespace object
        var cs = null;   // Current string

        for(null; pos<rest.length; pos++) {
            if(png) {
                if(pns) {
                    if(ps) {
                        if(rest[pos] === '"' && rest[pos-1] !== "\\") {
                            // end ps
                            cns.push(cs);
                            cs = null;
                            ps = false;
                        } else {
                            // add ps
                            cs += rest[pos];
                        }
                    } else { // outside ps
                        if(rest[pos] === '"' && rest[pos-1] !== "\\") {
                            // start ps
                            ps = true;
                            cs = '';
                        } else if(rest[pos] === ")" && rest[pos-1] !== "\\") {
                            // end pns
                            cng.push(cns);
                            cns = null;
                            pns = false;
                        }
                    }
                } else { //outside pns
                    if(rest[pos] === ")" && rest[pos-1] !== "\\") {
                        // end png
                        namespaces[namespace_types[pni]] = cng;
                        cng=null;
                        pni++;
                        png=false;
                    } else {
                        if(rest[pos] === "(" && rest[pos-1] !== "\\") {
                            // start pns
                            cns = [];
                            pns=true;
                        }
                    }
                }
            } else { // outside png
                if(rest[pos] === "(") {
                    // start png
                    cng = [];
                    png=true;
                } else if(rest.slice(pos,pos+3) === "NIL") {
                    // blank png
                    pos += 2;
                    pni++;
                }
            }
        }

        const namespaces_invert = {};

        for(const i in namespace_types) {
            for(const ns of namespaces[namespace_types[i]]) {
                namespaces_invert[ns[0]] = {
                    type: namespace_types[i],
                    delimiter: ns[1],
                    extra: ns.slice(2)
                };
            }
        }

        this.namespaces = namespaces;
        this.namespaces_invert = namespaces_invert;
        return this.namespaces;
    }

    // LIST: Search the list of account mailboxes
    async list(selection_options='',mailbox='*') {
        if(!Object.keys(this.namespaces).length) await this.namespace();
        return this.#command(`LIST "${selection_options}" "${escapeQuotes(mailbox)}"`);
    }

    // NOTIFY: Set notification configuration for mailbox changes
    async notify(args) {
        var cmd = 'NOTIFY';
        if(args) {
            cmd += ' ' + args
        } else {
            // NOTIFY defaults
            cmd += ' SET STATUS';
            cmd += ` (selected (${this.defaultNotifySelected}))`;
            if(this.defaultNotifyPersonal) {
                cmd += ` (personal (${this.defaultNotifyPersonal}))`;
            }
            /*if(this.defaultNotifyUsers) {
                cmd += ` (users (${this.defaultNotifyUsers}))`;
            }
            if(this.defaultNotifyShared) {
                cmd += ` (shared (${this.defaultNotifyShared}))`;
            }*/
        }
        const {data, rest} = await this.#command(cmd);

        if(args === 'NONE')
            this.isNotify = false;
        else
            this.isNotify = true;

        document.querySelector('#notify_status').classList.add('notifying');
    }

    // SELECT: Open a mailbox and return info about it
    async select(mailbox = "INBOX", uidvalidity = 0, highestmodseq = "0", uidranges = "") {
        let select_command;

        this.selected = this.mailboxes[mailbox];

        mailbox = mailbox.replace(/\\/g,'\\\\').replace(/"/g,'\\"');

        select_command = `SELECT "${mailbox}"`;

        if(uidvalidity && uidranges) {
            select_command += ` (QRESYNC (${uidvalidity} ${highestmodseq} ${uidranges}))`;
        }

        try {
            await this.#command(select_command);
        } catch(e) {
            if(e.message && (e.message.startsWith("[NONEXISTENT]") || e.message.startsWith("[TRYCREATE]"))) {
                await this.create(mailbox);
                return await this.select(mailbox,uidvalidity,highestmodseq,uidranges);
            } else {
                this.selected = null;
                throw e;
            }
        }

        if(!this.isNotify) await this.notify();
    }

    // CLOSE: Close the selected mailbox
    async close() {
        await this.#command("CLOSE");
        this.selected=null;
    }

    // UID MOVE: Move a message by UID
    async moveByUID(uids,mailbox) {
        mailbox = mailbox.replace(/\\/g,'\\\\').replace(/"/g,'\\"');
        if(Array.isArray(uids))
            uids = compactUIDEncode(uids);
        try {
            await this.#command(`UID MOVE ${uids} "${mailbox}"`);
        } catch(e) {
            if(e.message && (e.message.startsWith("[NONEXISTENT]") || e.message.startsWith("[TRYCREATE]"))) {
                await this.create(mailbox);
                await this.copyByUID(uids,mailbox);
            } else {
                throw e;
            }
        }
    }

    // UID COPY: Copy a message by UID
    async copyByUID(uids,mailbox) {
        mailbox = mailbox.replace(/\\/g,'\\\\').replace(/"/g,'\\"');
        if(Array.isArray(uids))
            uids = compactUIDEncode(uids);
        try {
            await this.#command(`UID COPY ${uids} "${mailbox}"`);
        }catch(e) {
            if(e.message && (e.message.startsWith("[NONEXISTENT]") || e.message.startsWith("[TRYCREATE]"))) {
                await this.create(mailbox);
                await this.copyByUID(uids,mailbox);
            } else {
                throw e;
            }
        }
    }

    // APPEND: Store a message in a mailbox
    async append(message, mailbox) {
        mailbox = mailbox.replace(/\\/g,'\\\\').replace(/"/g,'\\"');

        await this.idleStop();

        await this.commandQueue;

        const new_promise = this.commandQueue.then(async () => {

            const cmd = `APPEND "${mailbox}" (${message.flags.join(' ')}) {${message.blob.size}}`
            const tag = this.#tag();

            const begin_regexp = /^\+/;
            var begin_callback = null;
            var startfail_callback = null;
            const begin_promise = new Promise((resolve, reject) => {
                begin_callback = (data) => {
                    resolve(data);
                }
                startfail_callback = (data) => {
                    const regexp = new RegExp('^' + tag + ' (\\w*) (.*)');
                    const match = data.match(regexp);
                    if(match) {
                        reject(new Error(match[2]));
                    } else {
                        reject(new Error(data || "Command failed"));
                    }
                }
            });

            this._onmessage = this.#handleSimpleResponse.bind(this,begin_regexp,begin_callback,startfail_callback);
            this.#send(`${tag} ${cmd}`);

            await begin_promise;

            var finish_callback = null;
            const finish_promise = new Promise((resolve, reject) => {
                finish_callback = (ok, data, rest) => {
                    this.noopStartTimeout();
                    if(ok) {
                        const uid = data.match(/\[APPENDUID (\d+) (\d+)/)?.[2];
                        resolve(uid);
                    } else {
                        reject({ok, data, rest});
                    }
                }
            });

            this._onmessage = this.#handleCommandResponse.bind(this,tag,finish_callback);
            this.#send(message.message);

            return finish_promise;

        });

        this.commandQueue = this.commandQueue.catch(() => {});

        try {
            await new_promise;
        } catch(e) {
            if(e.message && (e.message.startsWith("[NONEXISTENT]") || e.message.startsWith("[TRYCREATE]"))) {
                await this.create(mailbox);
                await this.append(message,mailbox);
            } else {
                throw e;
            }
        }

        return this.commandQueue;
    }

    // UID STORE: Update message flags by UIDs
    async uidStore(uids, action="+FLAGS", data) {
        if(Array.isArray(uids))
            uids = compactUIDEncode(uids);
        await this.#command(`UID STORE ${uids} ${action} ${data}`);
    }

    // FETCH/UID FETCH: Fetch messages by seq or UID, optionally specify fields
    async fetch(seq, is_uid=false, fields = "MODSEQ BODY[]") {
        const command = is_uid
            ? `UID FETCH ${seq} (${fields})`
            : `FETCH ${seq} (${fields})`;

        //const { data, rest } = await this.#command(command, this.#handleFetchResponse);
        const { data, rest } = await this.#command(command);

        return rest;
    }

    // CREATE: Create a mailbox
    async create(mailbox, use_flags=[]) {
        if(typeof use_flags === "string")
            use_flags = use_flags.split(' ');

        const command = use_flags
            ? `CREATE "${escapeQuotes(mailbox)}" (USE (${use_flags.join(' ')}))`
            : `CREATE "${escapeQuotes(mailbox)}"`;

        const resp = await this.#command(command);

        if(use_flags)
            await this.#addSpecialUseMailbox(mailbox, use_flags);

        const mailboxo = new ImapMailbox(this,this.username,mailbox);
        await mailboxo.init();
        await mailboxo.setState('delimiter',this.namespaces.personal[0][1]);

        this.mailboxes[mailbox] = mailboxo;

        await this.oncreate?.();
        window.dispatchEvent(new CustomEvent('mailbox-created',{detail: {name: mailbox, mailbox: mailboxo}}));

        return resp;
    }

    // RENAME: Rename a mailbox
    async rename(old_name,new_name) {
        if(this.selected && (this.selected.mailbox === old_name || this.isParentOf(old_name,this.selected.mailbox)))
            await this.close();

        await this.#command(`RENAME "${escapeQuotes(old_name)}" "${escapeQuotes(new_name)}"`);

        this.mailboxes[new_name] = this.mailboxes[old_name];
        delete this.mailboxes[old_name];
        await this.mailboxes[new_name].rename(new_name);

        window.dispatchEvent(new CustomEvent('mailbox-renamed',{detail: {oldname: old_name, name: new_name}}));
        this.onrename?.();
    }

    // DELETE: Delete a mailbox
    async delete(mailbox_name) {
        if(this.selected && (this.selected.mailbox === mailbox_name || this.isParentOf(mailbox_name,this.selected.mailbox)))
            await this.close();

        await this.#command(`DELETE "${escapeQuotes(mailbox_name)}"`);

        await this.mailboxes[mailbox_name].delete();
        delete this.mailboxes[mailbox_name];

        window.dispatchEvent(new CustomEvent('mailbox-deleted',{detail: {name: mailbox_name}}));
        this.ondelete?.();
    }

    // NOOP: Do nothing
    // Sets latency
    async noop() {
        const start = Date.now();
        await this.#command("NOOP");
        const end = Date.now();
        this.latency = end - start;
    }

    // ----------------Complex commands-------------------

    // Set \Deleted and UID EXPUNGE a string or array of uids
    async deleteByUID(uids) {
        if(Array.isArray(uids))
            uids = compactUIDEncode(uids);
        await this.uidStore(uids, "+FLAGS.SILENT", "(\\Deleted)");
        await this.#command(`UID EXPUNGE ${uids}`);
    }

    // -----------------Buffer handlers-------------------

    /* handles the following untagged responses:
        * \d EXISTS
        * \d RECENT
        * VANISHED [\d:]
        * \d EXPUNGE
        * \d FETCH (.*)
        * FLAGS (.*)
        * LIST (FLAGS) "(.)" MBNAME ("OLDNAME" MBNAME)
        * STATUS MBNAME (MESSAGES \d UIDNEXT \d UNSEEN \d HIGHESTMODSEQ \d)
        * OK [.*]

        Returns the byte position at the end or first unparsed byte
    */ 
    async #handleUntaggedResponses(bytes) {
        var pos=0;

        const untagged_regexp = /^\* /;
        const exists_regexp = /^\* (\d+) EXISTS\r\n/;
        const recent_regexp = /^\* (\d+) RECENT\r\n/;
        const flags_regexp = /^\* FLAGS /;
        const vanished_regexp = /^\* VANISHED ([\d:,]+)\r\n/;
        const expunge_regexp = /^\* (\d+) EXPUNGE\r\n/;
        const fetch_regexp = /^\* (\d+) FETCH /;
        const list_regexp = /^\* LIST /;
        const status_regexp = /^\* STATUS /;
        const ok_regexp = /^\* OK /;
        const bye_regexp = /^\* BYE/;

        while(pos < bytes.byteLength) {
            var i=0;
            var decoded = this.decoder.decode(bytes.subarray(pos));
            const oldpos = pos;

            const untagged_match = decoded.match(untagged_regexp);
            if(!untagged_match) {
                log('imap','handleUntaggedResponse stopped at unparsed data',DEBUG,decoded);
                return pos;
            }

            const exists_match = decoded.match(exists_regexp);
            if(exists_match) {
                await this.selected?.onExists(exists_match[1]);

                pos += exists_match[0].length;
                decoded = this.decoder.decode(bytes.subarray(pos));
            }

            const recent_match = decoded.match(recent_regexp);
            if(recent_match) {
                await this.selected?.onRecent(recent_match[1]);

                pos += recent_match[0].length;
                decoded = this.decoder.decode(bytes.subarray(pos));
            }

            const flags_match = decoded.match(flags_regexp);
            if(flags_match) {
                const {newpos, flags} = await this.parseFlags(bytes.subarray(pos+flags_match[0].length));
                if(newpos === -1)
                    break;

                await this.selected?.onFlags(flags);

                pos += flags_match[0].length + newpos;
                decoded = this.decoder.decode(bytes.subarray(pos));
            }

            const vanished_match = decoded.match(vanished_regexp);
            if(vanished_match) {
                await this.selected?.onVanished(compactUIDDecode(vanished_match[1]));

                pos += vanished_match[0].length;
                decoded = this.decoder.decode(bytes.subarray(pos));
            }

            const expunge_match = decoded.match(expunge_regexp);
            if(expunge_match) {
                await this.selected?.onExpunge(expunge_match[1]);

                pos += expunge_match[0].length;
                decoded = this.decoder.decode(bytes.subarray(pos));
            }

            const fetch_match = decoded.match(fetch_regexp);
            if(fetch_match) {
                const {newpos, fetch, failed} = await this.parseFetch(bytes.subarray(pos+fetch_match[0].length));
                if(newpos === -1) {
                    log('imap',`parseFetch stopped at ${failed}`, DEBUG);
                    break;
                }

                await this.selected?.onFetch(fetch_match[1],fetch);

                pos += fetch_match[0].length + newpos;
                decoded = this.decoder.decode(bytes.subarray(pos));
            }

            const list_match = decoded.match(list_regexp);
            if(list_match) {
                const {newpos, list} = await this.parseList(bytes.subarray(pos+list_match[0].length));
                if(newpos === -1)
                    break;

                await this.onList?.(list);

                pos += list_match[0].length + newpos;
                decoded = this.decoder.decode(bytes.subarray(pos));
            }

            const status_match = decoded.match(status_regexp);
            if(status_match) {
                const {newpos, status} = await this.parseStatus(bytes.subarray(pos + status_match[0].length));
                if(newpos === -1)
                    break;

                await this.mailboxes[status.mailbox].onStatus(status);

                pos += status_match[0].length + newpos;
                decoded = this.decoder.decode(bytes.subarray(pos));
            }

            const ok_match = decoded.match(ok_regexp);
            if(ok_match) {
                const {newpos, response} = await this.parseResponse(bytes.subarray(pos + ok_match[0].length));
                if(newpos === -1)
                    break;

                await this.selected?.onResponse(response);

                pos += ok_match[0].length + newpos;
                decoded = this.decoder.decode(bytes.subarray(pos));
            }
            
            const bye_match = decoded.match(bye_regexp);
            if(bye_match) this.ws.close();

            if(pos === oldpos) break;

        }

        return pos;
    }

    async #handleIDLEResponse(tag,responseCallback,callbacks) {
        var decoded = this.decoder.decode(this.responseBuffer);

        const [ onIdleStart, onNewMail, onVanishedMail ] = callbacks;

        // Check for IDLE start greeting
        if(this.commandState.await === "start") {
            const idlestart_regexp = /^\+ idling\r\n/m;
            const idlestart_match = decoded.match(idlestart_regexp);
            if(idlestart_match) {
                // we are now idling for realz
                this.responseBuffer = this.responseBuffer.slice(idlestart_match.index + idlestart_match[0].length);
                decoded = decoded.slice(idlestart_match.index + idlestart_match[0].length);
                this.commandState.await = "notify";
                await onIdleStart?.();
            }
        }

        // Check for IDLE notifications
        if(this.commandState.await === "notify") {
            const notify_regexp = /^\* (\d+) EXISTS\r\n/gm;
            const vanish_regexp = /^\* VANISHED ([\d:,]+)\r\n/gm;

            const notify_match = decoded.matchAll(notify_regexp)
            for(const match of notify_match) {
                this.responseBuffer = this.responseBuffer.slice(match.index + match.length);
                decoded = decoded.slice(match.index + match.length);
                onNewMail?.(match[1]);
            }

            const vanish_match = decoded.matchAll(vanish_regexp)
            for(const match of vanish_match) {
                this.responseBuffer = this.responseBuffer.slice(match.index + match.length);
                decoded = decoded.slice(match.index + match.length);
                onVanishedMail?.(match[1]);
            }
        }

        // IDLE can stop at any time (probably)
        const command_regexp = new RegExp('^' + tag + '\\s+(OK|BAD|NO)\\s*(.*)\r\n','m');
        const command_match = decoded.match(command_regexp);

        if(command_match) {
            this._onmessage = null;
            this.commandState = null;

            const rest = null;
            const [ _, ok, data ] = command_match;

            this.responseBuffer = this.responseBuffer.slice(command_match.index + _.length);
            decoded = decoded.slice(command_match.index + _.length);

            await responseCallback(ok === "OK", data, rest);
        }
    }

    async #handleCommandResponse(tag, responseCallback) {
        const decoded = this.decoder.decode(this.responseBuffer);

        const command_regexp = new RegExp('^' + tag + '\\s+(OK|BAD|NO)\\s*(.*)\r\n','m');
        const command_match = decoded.match(command_regexp);

        if(command_match) {
            this._onmessage = null;
            this.commandState = null;

            const rest = decoded.slice(0,command_match.index);

            const [ _, ok, data ] = command_match;
            this.responseBuffer = this.responseBuffer.slice(command_match.index + _.length);

            await responseCallback(ok === "OK", data, rest);
        }
    }

    async #handleSimpleResponse(regexp, responseCallback,failCallback) {
        const decoded = this.decoder.decode(this.responseBuffer);

        const simple_match = decoded.match(regexp);

        if(simple_match) {
            this._onmessage = null;
            this.commandState = null;

            this.responseBuffer = this.responseBuffer.slice(simple_match.index + simple_match[0].length);

            await responseCallback(simple_match);
        } else {
            await failCallback(decoded);
        }
    }

    async #handleGreetingResponse(responseCallback) {
        const greeting_regexp = /^\* OK(.*ready.*)/im;

        const decoded = this.decoder.decode(this.responseBuffer);

        const greeting_match = decoded.match(greeting_regexp);

        if(greeting_match) {
            this.receivedGreeting = true;
            this._onmessage = null;
            await responseCallback?.(greeting_match[1]);
            await this.#checkForCapabilities(greeting_match[1]);
            await this._onopen?.(greeting_match[1]);
            this._onconnecterror = null;
            await this.onopen?.(greeting_match[1]);
            this.clearBuffer();
        } else {
            // no match
        }
    }

    // ---------------Connection handlers-----------------

    #onWsOpen = async () => {
        this.connected = true;
        //this.onopen?.();
    }

    #onWsClose = async (event) => {
        this.connected = false;
        log('imap', `WebSocket closed (${event?.code || 1006}): ${event?.reason || 'no reason'}`, WARN, event);
        if(!this.receivedGreeting) {
            this._onconnecterror?.(new Error('Connection closed before IMAP greeting'));
            this._onconnecterror = null;
            this._onopen = null;
        }
        //document.querySelector('#idle_status').classList.remove('idling');
        document.querySelector('#notify_status').classList.remove('notifying');
        this.commandState = null;
        this.commandQueue = Promise.resolve();
        this.responseQueue = Promise.resolve();
        this.responseBuffer = new Uint8Array();
        window.clearTimeout(this._noopTimeout);
        window.clearTimeout(this._idleStartTimeout);
        window.clearTimeout(this._idleRestartTimeout);
        this._onclose?.();
        this.onclose?.(event);
        this.idleTag = null;
    }

    #onWsError = e => {
        if(!this.receivedGreeting) {
            this._onconnecterror?.(new Error('WebSocket connection failed'));
            this._onconnecterror = null;
            this._onopen = null;
        }
        this._onerror?.(e);
        this.onerror?.(e);
    }

    #onWsMessage = async ({ data }) => {
        data = new Uint8Array(data);

        const decoded = this.decoder.decode(data);
        log('imap_in',decoded.toString(),NET);

        this.responseQueue = this.responseQueue.then(async () => {
            const newBuffer = new Uint8Array(this.responseBuffer.byteLength + data.byteLength);
            newBuffer.set(this.responseBuffer,0);
            newBuffer.set(data,this.responseBuffer.byteLength);

            this.responseBuffer = newBuffer;

            if(this.receivedGreeting) {
                const pos = await this.#handleUntaggedResponses(this.responseBuffer);
                this.responseBuffer = this.responseBuffer.subarray(pos);
            }

            await this._onmessage?.();
            await this.onmessage?.();
        });

        await this.responseQueue;
    }

    // ----------------Response handlers------------------

    // Handle a LIST response
    // isnotify helps because unsolicited LIST responses from NOTIFY do not
    // always include complete mailbox attributes
    async onList(list,isnotify=this.isNotify) {
        const delimiter = list.delimiter;
        const name = list.mailbox;

        var renamed = list.extended && 'oldname' in list.extended && list.extended.oldname in this.mailboxes;
        var deleted = list.flags && list.flags.includes('\\NonExistent');
        var created = !renamed && !deleted;// && !(name in this.mailboxes);

        if(deleted && name in this.mailboxes) {
            log('imap',`Deleting mailbox ${name}`,DEBUG);
            await this.mailboxes[name].delete();
            delete this.mailboxes[name];
            window.dispatchEvent(new CustomEvent('mailbox-deleted',{detail: {name: name}}));
            return;
        }

        if(renamed && list.extended.oldname in this.mailboxes) {
            const oldname = list.extended.oldname;
            log('imap',`Renaming mailbox ${oldname} to ${name}`,DEBUG);
            this.mailboxes[name] = this.mailboxes[oldname];
            delete this.mailboxes[oldname];
            await this.mailboxes[name].rename(name);
            window.dispatchEvent(new CustomEvent('mailbox-renamed',{detail: {oldname: list.extended.oldname, name: name}}));
            return;
        }

        if(created) {
            log('imap',`Adding mailbox ${name}`,DEBUG,list);
            if(!(name in this.mailboxes)) {
                this.mailboxes[name] = new ImapMailbox(this,this.username,name);
                await this.mailboxes[name].init();
            }
            const mailbox = this.mailboxes[name];
            await mailbox.setState('mailbox', name);
            await mailbox.setState('delimiter', delimiter);
            if(isnotify) {
                const exist_flags = await mailbox.getState('flags');
                const nonexist_index = exist_flags.indexOf('\\NonExistent');
                if(nonexist_index !== -1) exist_flags.splice(nonexist_index,1);
                const noselect_index = exist_flags.indexOf('\\Noselect');
                if(noselect_index !== -1) exist_flags.splice(noselect_index,1);
                const flags = [ ...exist_flags, ...list.flags ];
                await mailbox.setState('flags',flags);
            } else {
                await mailbox.setState('flags',list.flags);
            }
            await this.#addSpecialUseMailbox(mailbox.mailbox,mailbox.flags);
            window.dispatchEvent(new CustomEvent('mailbox-created',{detail: {name: name, mailbox: mailbox}}));
            return;
        }
    }

    // ---------------------Parsers-----------------------

    async parseRegex(string,regexp) {
        const match = string.match(regexp);

        if(match) {
            return {
                newpos: match[0].length,
                value: match[1]
            };
        }

        return {newpos: -1, value: null};
    }

    async parseAtom(string) {
        return await this.parseRegex(string,/^([^\x00-\x1f\x7f %\*\(\)\{"\\\]]+)\s*/);
    }

    async parseQuote(string) {
        if(string[0] !== '"')
            return {newpos: -1, value: null};

        const quote = (string,pos) => (string[pos] === '"' && (string[pos-1] !== '\\' || (string[pos-1] === '\\' && string[pos-2] === '\\')));

        var value = '';
        var pos=1;

        for(null; pos<string.length; pos++) {
            if(quote(string,pos)) {
                pos++;
                pos += await this.parseSpaces(string.slice(pos));
                return {newpos: pos, value: unescapeQuotes(value)};
            }
            value += string[pos];
        }

        return {newpos: -1, value: null};
    }

    async parseLiteral(bytes) {
        var decoded = this.decoder.decode(bytes);

        const bytes_match = decoded.match(/{(\d+)}\r\n/);
        if(!bytes_match)
            return {newpos: -1, value: null};

        var newpos = bytes_match[0].length + parseInt(bytes_match[1]);

        if(bytes.byteLength < newpos)
            return {newpos: -1, value: null};

        const literal = bytes.subarray(bytes_match[0].length,newpos);

        newpos += await this.parseSpaces(bytes.subarray(newpos));

        return {newpos: newpos, bytes: literal};

    }

    async parseSpaces(bytesorstring) {
        if(typeof bytesorstring === 'string') {
            return bytesorstring.match(/^ */)[0].length;
        }

        var pos=0;
        for(null;pos<bytesorstring.byteLength;pos++) {
            if(bytesorstring[pos] === 32)
                continue;
            else
                break;
        }

        return pos;
    }

    async parseCRLF(bytesorstring) {
        if(typeof bytesorstring === 'string') {
            return bytesorstring.match(/^\r\n/)
                ? 2
                : -1;
        }

        return (bytesorstring[0] === 13 && bytesorstring[1] === 10)
            ? 2
            : -1;
    }

    async parseAString(bytes,decodeLiteral=false) {
        var decoded = this.decoder.decode(bytes);

        var {newpos, value} = await this.parseRegex(decoded,/^([^\x00-\x1f\x7f %\*\(\)\{"\\]+) */);

        if(newpos !== -1) {
            return {newpos: newpos, value: value};
        }

        var {newpos, value} = await this.parseQuote(decoded);

        if(newpos !== -1) {
            return {newpos: newpos, value: value};
        }

        var {newpos, bytes} = await this.parseLiteral(bytes);

        if(decodeLiteral)
            return {newpos: newpos, value: this.decoder.decode(bytes)};
        else
            return {newpos: newpos, bytes: bytes};
    }

    async parseStatusPList(string) {
        if(string[0] !== '(')
            return {newpos: -1, value: null};

        var values = {};

        var pos = 1;
        while(pos<string.length) {
            var slice = string.slice(pos);

            if(slice[0] === ')') {
                pos += 1 + await this.parseSpaces(slice);
                return {newpos: pos, values: values};
            }

            var {newpos, value} = await this.parseAtom(slice);
            if(newpos === -1)
                return {newpos: -1, values: null};

            var key = value.toLowerCase();
            pos += newpos;
            var slice = string.slice(pos);

            var {newpos, value} = await this.parseAtom(slice);
            if(newpos === -1)
                return {newpos: -1, values: null};

            pos += newpos;
            var slice = string.slice(pos);


            values[key] = value;

            pos += await this.parseSpaces(slice);
        }

        return {newpos: -1, values: null};
    }

    async parseFlagsPList(string) {
        // yolo
        const match = string.match(/^\((.*?)\)/);
        if(!match)
            return {newpos: -1, values: null};

        const flags = match[1].split(' ');
        var newpos = match.index + match[0].length;
        var slice = string.slice(newpos);

        newpos += await this.parseSpaces(slice);

        return {newpos: newpos, values: flags};
    }

    async parseAStringPList(bytes,decode=false) {
        var decoded = this.decoder.decode(bytes);

        if(decoded[0] !== '(')
            return {newpos: -1, list: null};

        var pos=1;
        var plist = [];

        while(pos < bytes.byteLength) {
            if(decoded[pos] === ')') {
                pos++;
                return {newpos: pos, values: plist};
            }

            var {newpos, value} = await this.parseAString(bytes.subarray(pos),decode);

            if(newpos === -1)
                return {newpos: -1, list: null};

            plist.push(value);
            pos += newpos;
        }

        return {newpos: -1, list: null};
    }

    async parseListPList(bytes) {
        var decoded = this.decoder.decode(bytes);

        if(decoded[0] !== '(')
            return {newpos: -1, list: null};

        var pos=1;
        var plist = {};

        while (pos < bytes.byteLength) {
            if(decoded[pos] === ')') {
                pos += 1 + await this.parseSpaces(decoded.slice(pos));
                return {newpos: pos, values: plist};
            }

            var {newpos, value} = await this.parseAString(bytes.subarray(pos),true);

            if(newpos === -1)
                return {newpos: -1, list: null};

            var key = value.toLowerCase();
            pos += newpos;

            var {newpos, values} = await this.parseAStringPList(bytes.subarray(pos),true);

            if(newpos === -1)
                return {newpos: -1, list: null};

            plist[key] = values;
            pos += newpos;
        }

        return {newpos: -1, list: null};
    }

    async parseFlags(bytes) {
        var decoded = this.decoder.decode(bytes);

        var pos = 0;

        if(decoded[pos] !== '(')
            return {newpos: -1, flags: null};

        var {newpos, flags} = await this.parseFlagsPList(decoded.slice(pos));

        if(newpos === -1)
            return {newpos: -1, flags: null};

        pos += newpos;

        var newpos = await this.parseCRLF(bytes.subarray(pos));

        if(newpos === -1)
            return {newpos: -1, flags: null};

        pos += newpos;

        return {newpos: pos, flags: flags};
    }

    async parseList(bytes) {
        var decoded = this.decoder.decode(bytes);

        const list = {};

        var pos=0;

        // Flags
        var {newpos, values} = await this.parseFlagsPList(decoded.slice(pos));

        if(newpos === -1)
            return {newpos: -1, list: null};

        list.flags = values;
        pos += newpos;

        // Delimiter
        var {newpos, value} = await this.parseAString(bytes.subarray(pos),true);

        if(newpos === -1)
            return {newpos: -1, list: null};

        list.delimiter = value;
        pos += newpos;

        // Mailbox Name
        var {newpos, value} = await this.parseAString(bytes.subarray(pos),true);

        if(newpos === -1)
            return {newpos: -1, list: null};

        list.mailbox = value;
        pos += newpos;

        // Extension data
        var {newpos, values} = await this.parseListPList(bytes.subarray(pos));

        if(newpos !== -1) {
            list.extended = values;
            pos += newpos;
        }

        var newpos = await this.parseCRLF(bytes.subarray(pos));

        if(newpos === -1)
            return {newpos: -1, list: null};

        pos += newpos;

        return {newpos: pos, list: list};
    }

    async parseStatus(bytes) {
        var pos=0;

        const status = {};

        var {newpos, value} = await this.parseAString(bytes.subarray(pos),true);

        if(newpos === -1)
            return {newpos: -1, status: null};

        status.mailbox = value;
        pos += newpos;

        var slice = this.decoder.decode(bytes.subarray(pos));

        var {newpos, values} = await this.parseStatusPList(slice);

        if(newpos === -1)
            return {newpos: -1, status: null};

        Object.assign(status,values);
        pos += newpos;

        var newpos = await this.parseCRLF(bytes.subarray(pos));

        if(newpos === -1)
            return {newpos: -1, status: null};

        pos += newpos;

        return {newpos: pos, status: status};
    }

    async parseFetch(bytes) {
        var pos = 0;
        const fetch = {};

        var decoded = this.decoder.decode(bytes);

        if(decoded[pos] !== '(')
            return {newpos: -1, fetch: null, failed: 'start'};

        pos++;

        while(pos < bytes.byteLength) {
            decoded = this.decoder.decode(bytes.subarray(pos));
            if(decoded[0] === ')') {
                pos++;
                pos += await this.parseSpaces(decoded);
                decoded = this.decoder.decode(bytes.subarray(pos));
                var newpos = await this.parseCRLF(decoded);
                if(newpos === -1)
                    return {newpos: -1, fetch: null, failed: 'crlf'};
                pos += newpos;
                return {newpos: pos, fetch: fetch};
            }

            var {newpos, value} = await this.parseRegex(decoded,/^([\w\.]+) */);

            if(newpos === -1) {
                log('imap',`parseFetch: key fail`,DEBUG);
                return {newpos: -1, fetch: null, failed: 'key'};
            }

            var key = value.toLowerCase();
            pos += newpos;

            decoded = this.decoder.decode(bytes.subarray(pos));
            switch(key) {
                case "uid":
                    var {newpos, value} = await this.parseAtom(decoded);
                    if(newpos === -1)
                        return {newpos: -1, fetch: null, failed: 'uid'};
                    pos += newpos;
                    value = parseInt(value);
                    break;
                case "flags":
                    var {newpos, values} = await this.parseFlagsPList(decoded);
                    if(newpos === -1)
                        return {newpos: -1, fetch: null, failed: 'flags'};
                    pos += newpos;
                    value = values;
                    break;
                case "modseq":
                    var {newpos, values} = await this.parseFlagsPList(decoded)
                    if(newpos === -1)
                        return {newpos: -1, fetch: null, failed: 'modseq'};
                    pos += newpos;
                    value = values[0];
                    break;
                case "body":
                    const match = decoded.match(/^\[[^\]]*\] */);
                    if(!match)
                        return {newpos: -1, fetch: null, failed: 'body'};
                    pos += match[0].length;
                    // no break
                default:
                    var {newpos, value} = await this.parseAString(bytes.subarray(pos),true);
                    if(newpos === -1)
                        return {newpos: -1, fetch: null, failed: key};
                    pos += newpos;
                    break;
            }

            fetch[key] = value;
        }

        return {newpos: -1, fetch: null, failed: 'end'};
    }

    async parseResponse(bytes) {
        var decoded = this.decoder.decode(bytes);

        const response = {};

        var pos = 0;

        if(decoded[pos] !== '[') {
            return {newpos: -1, response: null}
        }

        pos++;

        while(pos < decoded.length) {
            if(decoded[pos] === ']') {
                pos++;
                var {newpos, value} = await this.parseRegex(decoded.slice(pos),/^([^\r]*)/);
                pos += newpos;
                var newpos = await this.parseCRLF(decoded.slice(pos));
                if(newpos === -1)
                    return {newpos: -1, response: null};
                pos += newpos;
                return {newpos: pos, response: response};
            }

            var {newpos, value} = await this.parseAtom(decoded.slice(pos));

            if(newpos === -1)
                return {newpos: -1, response: null};

            var key = value.toLowerCase();
            var value = null;
            pos += newpos;

            switch(key) {
                case "permanentflags":
                    var {newpos, values} = await this.parseFlagsPList(decoded.slice(pos));
                    if(newpos === -1)
                        return {newpos: -1, response: null};
                    value = values;
                    pos += newpos;
                    break;
                case "uidvalidity":
                case "unseen":
                case "uidnext":
                case "highestmodseq":
                case "modified":
                    var {newpos, value} = await this.parseAtom(decoded.slice(pos));
                    value = parseInt(value);
                    if(newpos === -1)
                        return {newpos: -1, response: null};
                    pos += newpos;
                    break;
                default:
                    value = true;
                    break;
            }

            response[key] = value;
        }
    }

    // ---------------- IDLE support ----------------

    async idleStart(onNewMail=this.onnotify, onVanishedMail=this.onvanish) {
        this.onnotify = onNewMail;
        this.onvanish = onVanishedMail;

        if (!this.selected) {
            log('imap',"IDLE: Can't IDLE before selecting a mailbox",WARN);
            return false;
        }
        if (this.isIdling()) {
            log('imap','IDLE: Already idling',DEBUG);
            return false;
        }

        log('imap','IDLE: start',DEBUG);

        await this.commandQueue;

        this.commandState = {
            command: 'idle',
            await: 'start'
        };

        var idleStartCallback = null;
        const idleStartPromise = new Promise((resolve, reject) => {
            idleStartCallback = () => {
                log('imap','IDLE: idleStartCallback',DEBUG);
                if(this._idleRestartTimeout)
                    window.clearTimeout(this._idleRestartTimeout)
                this._idleRestartTimeout = window.setTimeout((async () => {
                    this._idleRestartTimeout = null;
                    await this.idleRestart();
                }).bind(this),600000);
                document.querySelector('#idle_status').classList.add('idling');
                resolve();
            }
        });

        var responseCallback = null;
        const finishPromise =  new Promise((resolve, reject) => {
            responseCallback = (ok, data, rest) => {
                log('imap','IDLE: finishCallback',DEBUG);
                if (ok) {
                    resolve({ data, rest });
                } else {
                    reject(new Error(data || "Command failed"));
                }
            };
        });

        const tag = this.#tag();
        const handler = this.#handleIDLEResponse.bind(this,tag,responseCallback,[idleStartCallback, onNewMail, onVanishedMail]);

        this._onmessage = handler;
        this.#send(`${tag} IDLE`);

        this.commandQueue = this.commandQueue.then(() => finishPromise).catch(() => {});

        return idleStartPromise;
    }

    async idleStop() {
        if(this._idleStartTimeout) {
            window.clearTimeout(this._idleStartTimeout);
            this._idleStartTimeout = null;
        }

        if(!this.isIdling()) return false;

        this.commandState.await = 'done';

        if(this._idleRestartTimeout) {
            window.clearTimeout(this._idleRestartTimeout);
            this._idleRestartTimeout = null;
        }

        this.#send("DONE");
        await this.commandQueue;
        document.querySelector('#idle_status').classList.remove('idling');
    }

    async idleRestart() {
        await this.idleStop();
        await this.idleStart();
    }

    async idleStartTimeout(onNewMail=this.onnotify, onVanishedMail=this.onvanish) {
        if(this._idleStartTimeout)
            window.clearTimeout(this._idleStartTimeout);

        this._idleStartTimeout = window.setTimeout((async () => {
            this.idleStart(onNewMail, onVanishedMail);
        }).bind(this),1500);
    }

    isIdling() {
        return this.commandState && this.commandState.command === "idle" && !(this.commandState.await === 'done');
    }

    // ---------------------Timers------------------------

    async noopStartTimeout() {
        if(this._noopTimeout)
            window.clearTimeout(this._noopTimeout);

        this._noopTimeout = window.setTimeout((async () => {
            await this.noop();
            await this.noopStartTimeout();
        }).bind(this),300000);
    }

    // -------------------Data helpers--------------------

    async mailboxToNamespace(mailbox) {
        if(!Object.keys(this.namespaces).length) await this.namespace();

        const sorted_names = Object.keys(this.namespaces_invert).sort((a,b) => b.length - a.length);

        for(const nsname of sorted_names) {
            const regexp = new RegExp('^' + nsname);
            if(regexp.test(mailbox)) {
                const ns = this.namespaces_invert[nsname];
                return { nsname, ns };
            }
        }
    }

    // Parse mailbox name and assign to special use mailboxes
    async #addSpecialUseMailbox(mailbox, flags) {
        if(mailbox.toLowerCase() === "inbox")
            this.inbox = mailbox;
        if(flags.includes('\\Trash'))
            this.trash = mailbox;
        if(flags.includes('\\Sent'))
            this.sent = mailbox
        if(flags.includes('\\Drafts'))
            this.drafts = mailbox;
        if(flags.includes('\\Junk'))
            this.junk = mailbox;
        if(flags.includes('\\Archive'))
            this.archive = mailbox;
    }

    isParentOf(candidate,mailbox) {
        if(!candidate || !mailbox) return false;
        return mailbox.startsWith((candidate + this.namespaces.personal[0][1]))
    }

    // Return an array of only the root level mailbox objects
    getRootMailboxes() {
        const mailboxes = [];

        for(const mailbox_name of Object.keys(this.mailboxes)) {
            const mailbox = this.mailboxes[mailbox_name];
            if(mailbox.mailbox.split(mailbox.delimiter).length === 1)
                mailboxes.push(mailbox);
        }

        return mailboxes;
    }

    // Check for capabilities in the greeting or anywhere else
    async #checkForCapabilities(input) {
        const capabilities = new Set();
        if(input.match(/^.*\[CAPABILITY/)) {
            const capabilities = input.replace(/^.*?\[CAPABILITY (.*)\].*/,"$1").split(" ");
            await this.#setCapabilities(capabilities);
            return capabilities;
        } else {
            return false;
        }
    }

    // Set server capabilities
    async #setCapabilities(capabilities) {
        const new_capabilities = new Set();
        for(const capability of capabilities) {
            new_capabilities.add(capability);
        }
        this.capabilities = new_capabilities;
        log('imap','Set capabilities',DEBUG,this.capabilities);
    }

    clearBuffer() {
        this.responseBuffer = new Uint8Array();
    }
}

//---------------------------------IMAP Mailbox-------------------------------
