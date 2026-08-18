class ImapMailbox {
    constructor(imap,account,mailbox) {
        this.imap = imap;
        this.account = account;
        this.mailbox = mailbox;
        this.messages = {};

        this.flags = [];
        this.delimiter = null;

        this.inconsistent = false;
        this.uidFetchQueue = [];
        this.seqFetchQueue = [];

        this.headerFields = "UID MODSEQ FLAGS BODY.PEEK[HEADER.FIELDS (FROM TO CC BCC DATE SUBJECT)]";
    }

    clear() {
        this.uidvalidity = 0;
        this.highestmodseq = "0";
        this.uidnext = 0;
        this.exists = 0;
        this.messages = {};
    }

    async init(loadState=true) {
        this.storage = new MailboxStorage(this.account + '/' + this.mailbox);
        await this.storage.init();

        if(loadState) {
            this.clear();

            this.uidvalidity = await this.storage.get('state','uidvalidity');
            this.highestmodseq = await this.storage.get('state','highestmodseq');
            this.uidnext = await this.storage.get('state','uidnext');
            this.exists = await this.storage.get('state','exists') || 0;
            this.delimiter = await this.storage.get('state','delimiter');
            this.flags = await this.storage.get('state','flags') || [];
        }
    }

    // ----------------State management-------------------

    async getState(key) {
        if(key in this) return this[key];
        const state = await this.storage.get('state',key);
        this[key] = state;
        return state;
    }

    async setState(key,value,force=false) {
        if(!force && key in this && this[key] === value) return true;
        this[key] = value;
        await this.storage.put('state',key,value);
    }

    async #saveState() {
        await this.storage.put('state','uidvalidity',this.uidvalidity);
        await this.storage.put('state','highestmodseq',this.highestmodseq);
        await this.storage.put('state','uidnext',this.uidnext);
        await this.storage.put('state','exists',this.exists);
    }

    // Update exists and unseen state
    async updateInfo() {
        await this.setState('exists',Object.keys(this.messages).length);
        this.unseen = (await this.getFlaggedUIDs('\\Seen',true)).length;
        await this.onstatus?.();
    }

    // ---------------Mailbox management------------------

    // Select the mailbox and fetch messages from server
    async load() {
        const compactUidSet = await this.compactUids();

        const data = await this.imap.select(this.mailbox, this.uidvalidity, this.highestmodseq, compactUidSet);

        if(this.inconsistent) {
            log('imap_mailbox','Mailbox is inconsistent, clearing everything',DEBUG);
            await this.deleteAllMessages();
            if(this.exists)
                this.seqFetchQueue.push(...compactUIDDecode('1:'+this.exists));
            this.inconsistent = false;
        }

        await this.fetchFromQueue();

        await this.updateInfo();

        await this.onload?.();
    }

    // Load slim messages from storage
    async *loadFromStorage() {
        const stored_messages = await this.storage.getAll('messages');

        for(const message of stored_messages) {
            const messageo = new Message(message);

            // Catch old full-message storage
            if(message.body) {
                await this.saveMessage(messageo,true);
                await messageo.close();
            }

            this.messages[messageo.uid] = messageo;
            yield messageo;
        }

        this.unseen = (await this.getFlaggedUIDs('\\Seen',true)).length;
    }

    async fetchFromQueue() {
        if(this.seqFetchQueue.length) {
            await this.fetch(this.seqFetchQueue,false,false);
            this.seqFetchQueue = [];
        }
        if(this.uidFetchQueue.length) {
            await this.fetch(this.uidFetchQueue);
            this.uidFetchQueue = [];
        }
    }

    async delete() {
        await this.storage.deleteDB(true);
    }

    async rename(new_name) {
        if(this.exists && !Object.keys(this.messages).length) {
            var message = null;
            const loader = this.loadFromStorage();
            while(message = (await loader.next())?.value) {}
        }
        await this.delete();
        this.mailbox = new_name;
        await this.init(false);
        await this.setState('delimiter',this.delimiter,true);
        await this.#saveState();

        for(const message of Object.values(this.messages)) {
            await this.saveMessage(message);
        }
    }

    // Fetch messages from the server
    async fetch(seq,full=false,is_uid=true) {
        if(Array.isArray(seq)) seq = compactUIDEncode(seq);

        await this.imap.fetch(seq,is_uid,full
            ? this.fullFields
            : this.headerFields);
    }

    // Load full message from storage or the server
    async loadMessage(message) {
        const from_storage = await this.storage.get('fullMessages',message);
        if(from_storage) {
            Object.assign(this.messages[message],from_storage);
        } else {
            await this.fetch(message,true);
        }
    }

    // ----------------Response handlers------------------

    async onStatus(status) {
        if('messages' in status)
            this.remote_exists = parseInt(status.messages);
        if('unseen' in status) {
            const oldunseen = this.unseen || 0;
            this.unseen = status.unseen;
            await this.onstatus?.(oldunseen);
        } else {
            await this.onstatus?.();
        }
    }

    async onFetch(seq,fetch) {
        if(!('uid' in fetch)) {
            log('imap_mailbox','Got a FETCH without a UID!', WARN, [seq,fetch]);
            return;
        }

        const exist_queue_index = this.seqFetchQueue.indexOf(parseInt(seq));
        if(exist_queue_index !== -1) this.seqFetchQueue.splice(exist_queue_index,1);

        const uid = fetch.uid;

        if('body' in fetch) {
            fetch.message = fetch.body;
            delete fetch.body;
        }

        fetch.seq = seq;

        const exists = this.messages[uid];
        const message = exists || new Message(fetch);

        if(exists) {
            await message.update(fetch);
            message.loaded = false;
        } else {
            await message.loadMessage();
            this.messages[uid] = message;
        }

        await this.saveMessage(message);
        if('flags' in fetch || 'body' in fetch)
            await this.onfetch?.(message);
    }

    async onResponse(response) {
        const key = Object.keys(response)[0];
        const value = response[key];
        switch(key) {
            case "uidvalidity":
                if(value !== parseInt(await this.getState('uidvalidity')))
                    this.inconsistent = true;
                await this.setState('uidvalidity',value);
                break;
            case "uidnext":
                await this.setState('uidnext',value);
                break;
            case "highestmodseq":
                if(value < parseInt(await this.getState('highestmodseq')))
                    this.inconsistent = true;
                await this.setState('highestmodseq',value);
                break;
        }
    }

    async onExists(seq) {
        const exists = await this.getState('exists') || 0;
        if(seq > exists) {
            this.seqFetchQueue.push(...(await compactUIDDecode((parseInt(exists)+1) + ':' + seq)));
        }
        await this.setState('exists',seq);
        this.remote_exists = parseInt(seq);
    }

    async onRecent(seq) {}

    async onFlags(flags) {}

    async onVanished(uidseq) {
        for(const uid_vanished of uidseq) {
            if(uid_vanished in this.messages) {
                await this.deleteMessage(this.messages[uid_vanished]);
            }
        }
        await this.onvanished?.(uidseq);
    }

    async onExpunge(seq) {}

    // ---------------Message management------------------

    // Set message callbacks and save them
    async addMessages(messages) {
        for(const key of Object.keys(messages)) {
            const message = messages[key];
            //message.load = this.imap.fetch.bind(this.imap,message.uid,true);
            await this.saveMessage(message);
        }
    }

    // Save a message to self/storage
    async saveMessage(message,full=false) {
        this.messages[message.uid] = message;

        await this.storage.put('messages',message.uid,await message.slim(false));
        if(full)
            await this.storage.put('fullMessages',message.uid,await message.slim(true));
    }

    // Set message flags
    async markMessages(uids,action,flags) {
        if(!Array.isArray(uids))
            uids = [uids];
        if(!Array.isArray(flags))
            flags = [flags];

        const a = action === "remove" ? '-' : '+';

        var changed_uids = [];

        for(const uid of uids) {
            const message = this.messages[uid];
            var changed=false;

            if(a === '+') changed = await message.addFlags(flags);
            else if(a === '-') changed = await message.removeFlags(flags);

            if(changed) {
                changed_uids.push(uid);
            }
        }

        await this.imap.uidStore(uids,a + 'FLAGS.SILENT', flags);

        for(const uid of changed_uids) {
            await this.saveMessage(this.messages[uid]);
        }
    }

    // Move messages to another mailbox
    async moveMessages(uids,mailbox) {
        if(!Array.isArray(uids))
            uids = [uids];

        await this.imap.moveByUID(uids, mailbox);

        await this.#saveState();
    }

    // Copy messages to another mailbox
    async copyMessages(uids,mailbox) {
        if(!Array.isArray(uids))
            uids = [uids];

        await this.imap.copyByUID(uids, mailbox);
    }

    // Delete message from self
    async deleteMessage(message) {
        delete this.messages[message.uid];

        this.exists -= 1;

        await this.storage.delete('messages',message.uid);
        await this.storage.delete('fullMessages',message.uid);
    }

    // Delete messages from server and self
    async deleteMessages(uids) {
        if(!Array.isArray(uids))
            uids = [uids];
        await this.imap.deleteByUID(uids);
        for(const uid of uids) {
            delete this.messages[uid];
            await this.storage.delete('messages',uid);
            await this.storage.delete('fullMessages',uid);
        }
        this.exists -= uids.length;
        await this.#saveState();
    }

    // Delete all messages from self
    async deleteAllMessages() {
        const uids = Object.keys(this.messages);
        if(uids) {
            await this.onvanished?.(uids);
        }
        this.messages = {};
        await this.storage.delete('messages');
        await this.storage.delete('fullMessages');
    }

    // ---------------------Helpers-----------------------

    getParent() {
        return this.mailbox
            .split(this.delimiter)
            .slice(0,-1)
            .join(this.delimiter);
    }

    getChildren() {
        return Object.keys(this.imap.mailboxes)
            .filter(a => {
                const prefix = this.mailbox + this.delimiter;
                return a.startsWith(prefix) && a.slice(prefix.length).indexOf(this.delimiter) === -1;
            })
            .map(a => this.imap.mailboxes[a]);
    }

    getShortName() {
        return this.mailbox.split(this.delimiter).slice(-1).toString();
    }

    getFlaggedUIDs(flag,absent=false) {
        const uids = Object.values(this.messages)
            .filter(a => absent ? !a.flags.includes(flag) : a.flags.includes(flag))
            .map(a => a.uid);

        return uids;
    }

    async compactUids() {
        return compactUIDEncode(Object.keys(this.messages));
    }
}

//---------------------------------IMAP Message-------------------------------
