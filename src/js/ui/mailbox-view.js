class _MailboxView extends View {
    constructor(mailbox,el_before) {
        //super('mailbox',window.AccountView?.el);
        super('mailbox',el_before);

        this.mailbox = mailbox;
        this.mailbox.onload = this.draw.bind(this);
        this.mailbox.onfetch = this.buildMessage;
        this.mailbox.onvanished = this.deleteMessages;

        this.messages = {};
        this.sortedMessages = [];

        this.sortMethod = 'uid';
        this.sortDirection = 'desc';

        this.lastFetch = 0;

        this.updateCount = 500; // When fetching mail, how often to update message count
        this.updateCounti = 1; // iterator

        this.el.selectall?.addEventListener('click', this.onClickSelectAll);
        this.el.refresh?.addEventListener('click', this.refresh);
        this.el.rebuild?.addEventListener('click', this.rebuild);

        this.el.cancel?.addEventListener('click',this.onClickCancel);

        this.addEventListener('mailbox-reload', this.draw);
        this.addEventListener('mailboxes-changed', this.drawMessageControls);

        this.selectedMessage = null;

        this.messageQueue = [];

        this.drawMessageCountTimeout = 100;
        //this.drawMessageCountTimeout = Math.max(100,this.mailbox.imap.latency);
        this._drawMessageCountTimeout = null;

        this.drawMessagesTimeout = 100;
        //this.drawMessagesTimeout = Math.max(100,this.mailbox.imap.latency);
        this._drawMessagesTimeout = null;

        this.drawMessageUpdatesTimeout = 100;
        //this.drawMessageUpdatesTimeout = Math.max(100,this.mailbox.imap.latency);
        this._drawMessageUpdatesTimeout = null;
    }

    async open() {
        try {
            set_status(`Loading ${this.mailbox.mailbox}`, "LOAD");
            this.el.mailbox_status.innerText = 'Loading...';

            await this.draw();
            this.show();
            await paint();

            await this.load();

            await set_status("OK");

            if(!window.MessageView) {
                const sortedMessages = this.sortMessages();

                if(sortedMessages.length) {
                    const most_recent_message = this.mailbox.messages[sortedMessages[0]];
                    /*await*/ this.openMessage(most_recent_message.uid);
                }
            }

            await this.mailbox.imap.notify();
        } catch(e) {
            await set_status("ERR",null,e);
            await this.close();
            return;
        }
    }

    async load() {
        const message_keys = Object.keys(this.mailbox.messages);
        if(message_keys.length) {
            var i = 1;
            for(const uid of message_keys) {
                await this.buildMessage(this.mailbox.messages[uid],0);
                i++;
            }
        } else {
            const localMessages = this.mailbox.loadFromStorage();

            var message = null;
            var i = 1;
            while(message = (await localMessages.next())?.value) {
                await this.buildMessage(message,0);
                i++;
            }
        }

        await this.drawMessages();

        await this.mailbox.load();
        await this.loadLocalMessages();

        this.el.mailbox_status.innerText = Object.keys(this.messages).length
            ? ''
            : '(no messages)';
    }

    async loadLocalMessages() {
        if(!this.mailbox.imap.accountId) return;
        const folder = this.mailbox.mailbox === 'INBOX'
            ? 'INBOX'
            : this.mailbox.mailbox === this.mailbox.imap.sent
                ? 'Sent'
                : null;
        if(!folder) return;
        const path = `/v1/accounts/${encodeURIComponent(this.mailbox.imap.accountId)}`
            + `/local-messages?folder=${encodeURIComponent(folder)}`;
        const response = await apiFetch(path);
        if(!response.ok) return;
        const payload = await response.json();
        const records = Array.isArray(payload.data) ? payload.data : [];
        const previous = Object.values(this.messages)
            .filter((entry) => entry.message?.localId);
        for(const entry of previous) {
            entry.remove();
            delete this.messages[entry.uid];
            delete this.mailbox.messages[entry.uid];
        }
        // Local delivery is not addressable through IMAP, so keep its display
        // identifiers outside the positive IMAP UID space.
        let localUid = -1;
        for(const record of records) {
            const raw = Uint8Array.from(
                atob(record.raw || ''),
                character => character.charCodeAt(0)
            );
            const message = new Message();
            message.uid = localUid--;
            message.localId = record.id;
            message.flags = record.flags || [];
            await message.loadMessage(new TextDecoder().decode(raw));
            message.full = true;
            this.mailbox.messages[message.uid] = message;
            await this.buildMessage(message, 0);
        }
        await this.drawMessages();
    }

    draw = async () => {
        const message_keys = Object.keys(this.mailbox.messages);

        this.el.querySelectorAll('.mailbox_name').forEach(e => {
            e.innerText = this.mailbox.getShortName();
        });

        if(message_keys.length) {
            this.el.querySelectorAll('.mailbox_controls .selectall').forEach(e => e.classList.remove('hidden'));
        } else {
            this.el.querySelectorAll('.mailbox_controls .selectall').forEach(e => e.classList.remove('add'));
        }

        await this.drawMessageControls();
    }

    // Builds a mailbox message list item
    // when_draw: 0 (never), 1 (immediately), 2 (after timer)
    buildMessage = async (message,when_draw=2) => {
        this.lastFetch = Date.now();

        const existing = await this.getMessageByUID(message.uid);

        if(existing) {
            await this.queueMessageUpdate(message);
        } else {
            const entry = template('mailbox-message');

            entry.uid = message.uid;
            entry.message = message;

            entry.from.innerText = ( decodeMIMEWords(message.headers.get('from','one'), false) || "(blank)" );
            entry.date.innerText = ( decodeDate(message.headers.get('date','one')) || "(blank)" );
            entry.checkbox.onpointerdown = e => e.stopPropagation();
            entry.checkbox.onchange = this.drawMessageControls;
            entry.checkbox.disabled = Boolean(message.localId);
            entry.onpointerdown = this.onClickMessage;

            this.messages[parseInt(message.uid)] = entry;

            await this.updateMessage(message);

            if(when_draw === 1) this.drawMessages();
            else if(when_draw === 2) await this.startDrawMessagesTimeout();
            await this.startDrawMessageCountTimeout();
        }
    }

    async queueMessageUpdate(message) {
        this.messageQueue.push(message);
        this.startDrawMessageUpdatesTimeout();
        await this.startDrawMessageCountTimeout();
    }

    startDrawMessageUpdatesTimeout() {
        if(!this._drawMessageUpdatesTimeout)
            this._drawMessageUpdatesTimeout = window.setTimeout(this.pollDrawMessageUpdatesTimeout,this.drawMessageUpdatesTimeout);
    }

    pollDrawMessageUpdatesTimeout = async () => {
        this._drawMessageUpdatesTimeout = null;
        if(Date.now() - this.lastFetch > this.drawMessageUpdatesTimeout)
            await this.drawMessageUpdates();
        else
            await this.startDrawMessageUpdatesTimeout();
    }

    async drawMessageUpdates() {
        for(const message of this.messageQueue) {
            await this.updateMessage(message);
        }
        this.messageQueue = [];
    }

    async updateMessage(message) {
        const el = this.getMessageByUID(message.uid);

        el.subject.innerText = (message.flags.includes('\\Flagged') ? '🚩 ' : '')
            + (message.flags.includes('\\Answered') ? '↪ ' : '')
            + (message.flags.includes('$Forwarded') ? '➡️ ' : '')
            + decodeMIMEWords(message.headers.get('subject','one'), false) || "(no subject)";

        el.dataset.flags = escapeHtml(message.flags.join(' '),'_');
        message.flags.filter(Boolean).forEach(e => el.classList.add(escapeHtml(e,'_')));

        if(this.selectedMessage === message.uid) {
            el.setAttribute('data-open', true);
        }

        await this.startDrawMessageCountTimeout();
    }

    async startDrawMessagesTimeout() {
        if(!this._drawMessagesTimeout)
            this._drawMessagesTimeout = window.setTimeout(this.pollDrawMessagesTimeout,this.drawMessagesTimeout);
    }

    pollDrawMessagesTimeout = async () => {
        this._drawMessagesTimeout = null;
        if(Date.now() - this.lastFetch > this.drawMessagesTimeout)
            await this.drawMessages();
        else
            await this.startDrawMessagesTimeout();
    }

    drawMessages = async () => {
        if(this._drawMessagesTimeout) {
            window.clearTimeout(this._drawMessagesTimeout);
            this._drawMessagesTimeout = null;
        }

        this.el.message_list.replaceChildren(...this.sortMessages().map(a => this.messages[a]));

        await paint();
    }

    stopDrawMessageCountTimeout() {
        if(this._drawMessageCountTimeout) {
            window.clearTimeout(this._drawMessageCountTimeout);
            this._drawMessageCountTimeout = null;
        }
    }

    async startDrawMessageCountTimeout() {
        if(this.updateCounti % this.updateCount === 0) {
            await this.drawMessageCount();
            this.updateCounti = 1;
        } else {
            this.updateCounti++;
        }

        if(!this._drawMessageCountTimeout)
            this._drawMessageCountTimeout = window.setTimeout(this.pollDrawMessageCount,this.drawMessageCountTimeout);
    }

    pollDrawMessageCount = async () => {
        this._drawMessageCountTimeout = null;

        if(Date.now() - this.lastFetch > this.drawMessageCountTimeout)
            await this.drawMessageCount();
        else
            await this.startDrawMessageCountTimeout();
    }

    sortMessages(method=this.sortMethod,direction=this.sortDirection) {
        const sort_function = this.getSortFunction(method);
        const sorted = Object.keys(this.messages)
            .map(a => parseInt(a))
            .sort(sort_function);

        if(direction === 'desc') sorted.reverse();

        return sorted;
    }

    getSortFunction(method) {
        switch(method) {
            case "uid":
                return this.sortByUID;
                break;
        }
    }

    sortByUID = (a,b) => {
        a = parseInt(a); b = parseInt(b);
        return a-b;
    }

    drawMessageCount = async () => {
        this.stopDrawMessageCountTimeout();

        const message_count = Object.keys(this.messages).length;
        const message_count_unread = this.mailbox.getFlaggedUIDs('\\Seen',true).length;
        const message_count_flagged = this.mailbox.getFlaggedUIDs('\\Flagged').length;
        const s = message_count !== 1 ? 's' : '';

        var string = '(';

        if(message_count_flagged) {
            string += `${message_count_flagged} flagged, `;
        }

        if(message_count_unread) {
            if(message_count_unread == message_count) {
                string += `${message_count_unread} unread message${s}`;
            }
            else {
                string += `${message_count_unread} unread, ${message_count} message${s}`;
            }
        } else {
            string += `${message_count} message${s}`;
        }

        string += ')';

        if(this.el.message_count) this.el.message_count.innerText = string;

        await paint();
    }

    drawMessageControls = async () => {
        const uids = this.getCheckedMessages();

        if(uids.length) {
            this.el.message_controls?.classList.remove('hidden');
            this.el.selectedcount.innerText = `(${uids.length} selected)`;
        } else {
            this.el.message_controls?.classList.add('hidden');
        }

        for(const el of [...this.el.copy.children].slice(1)) el.remove();
        for(const el of [...this.el.move.children].slice(1)) el.remove();

        this.el.mark.onchange = this.onClickMark.bind(null,uids);
        this.el.copy.onchange = this.onClickCopy.bind(null,uids);
        this.el.move.onchange = this.onClickMove.bind(null,uids);

        await this.drawMailboxSelect(this.el.copy,window.AccountView.imap.getRootMailboxes());
        await this.drawMailboxSelect(this.el.move,window.AccountView.imap.getRootMailboxes());
    }

    async drawMailboxSelect(el,mailboxes,root='$$cock-mail-root') {
        for(const mailbox_name of await window.AccountView.sortMailboxes(mailboxes,root)) {
            const mailbox = this.mailbox.imap.mailboxes[mailbox_name];
            const item = template('mailbox-select');

            if(mailbox && !window.AccountView.isMailboxUsable(mailbox.mailbox))
                item.setAttribute('disabled',true);

            item.innerText = mailbox ? mailbox.mailbox : '';
            item.value = mailbox ? mailbox.mailbox : '';

            el.appendChild(item);

            const children = mailbox.getChildren();

            if(children.length)
                await this.drawMailboxSelect(el,children,mailbox.mailbox);
        }
    }

    onClickMark = async (uids,e) => {
        const selected = e.target.options[e.target.selectedIndex];
        e.target.value=0;

        if(!Array.isArray(uids))
            uids = [ uids ];

        const flag = selected.getAttribute('data-flag');
        const action = selected.getAttribute('data-action');

        if(flag === "\\Deleted") {
            if(!confirm(`Permanently delete ${uids.length} message${uids.length === 1 ? '' : 's'}?`)) return;
            try {
                await set_status(`Deleting ${uids.length} message${uids.length === 1 ? '' : 's'}`, 'LOAD');
                await this.mailbox.deleteMessages(uids);
                await set_status("OK");
            } catch(e) {
                await set_status("ERR",null,e);
                return;
            }
            window.dispatchEvent(new CustomEvent('message-deleted',{detail: {uids: uids, action: 'deleted'}}));
        } else {
            try {
                await set_status(`Marking ${uids.length} message${uids.length === 1 ? '' : 's'}`, 'LOAD');
                await this.mailbox.markMessages(uids,action,flag);
                for(const uid of uids) await this.updateMessage(this.mailbox.messages[uid]);
                await this.deselect(uids);
                await set_status("OK");
            } catch(e) {
                await set_status("ERR",null,e);
                return;
            }
            window.dispatchEvent(new CustomEvent('message-updated',{detail: {uids: uids, updated: 'flags', action: action, flags: [flag]}}));
        }

        await this.mailbox.updateInfo();
        //window.dispatchEvent(new CustomEvent("mailbox-reload"));
    }

    onClickCopy = async (uids,e) => {
        const selected = e.target.options[e.target.selectedIndex];
        e.target.value=0;

        if(!Array.isArray(uids))
            uids = [ uids ];

        const mailbox = selected.value;

        try {
            await set_status(`Copying ${uids.length} message${uids.length === 1 ? '' : 's'} to ${mailbox}`, 'LOAD');
            await this.mailbox.copyMessages(uids,mailbox);
            await this.deselect(uids);
            await set_status("OK");
        } catch(e) {
            await set_status("ERR",null,e);
            return;
        }
    }

    onClickMove = async (uids,e) => {
        const selected = e.target.options[e.target.selectedIndex];
        e.target.value=0;

        if(!Array.isArray(uids))
            uids = [ uids ];

        const mailbox = selected.value;

        try {
            await set_status(`Moving ${uids.length} message${uids.length === 1 ? '' : 's'} to ${mailbox}`, 'LOAD');
            await this.mailbox.moveMessages(uids,mailbox);
            await set_status("OK");
        } catch(e) {
            await set_status("ERR",null,e);
            return;
        }

        await this.mailbox.updateInfo();
        window.dispatchEvent(new CustomEvent('message-deleted',{detail: {uids: uids, action: 'moved'}}));
        window.dispatchEvent(new CustomEvent("mailbox-reload"));
    }

    indicateSelectedMessage() {
        this.el.querySelectorAll('.message_list .message').forEach(e => {
            e.removeAttribute('data-open');
        });

        const open_mailbox_message = this.getMessageByUID(this.selectedMessage);

        if(open_mailbox_message)
            open_mailbox_message.setAttribute('data-open',true);
    }

    rebuild = async () => {
        await set_status(`Rebuilding ${this.mailbox.mailbox}`, "LOAD");
        //for(const message of Object.values(this.messages)) message.remove();
        this.messages = {};
        this.mailbox.clear();
        await this.mailbox.deleteAllMessages();
        await this.load();
        set_status(`Rebuilding ${this.mailbox.mailbox}... Done!`, "OK");
        return false;
    }

    refresh = async () => {
        await set_status(`Refreshing ${this.mailbox.mailbox}`, "LOAD");
        await this.mailbox.load();
        await this.loadLocalMessages();
        await set_status("OK");
    }

    onClickSelectAll = async () => {
        this.el.querySelectorAll(
            '.message_list .message input[type=checkbox]:not(:disabled)'
        ).forEach(e => { e.checked = true; });
        this.drawMessageControls();
    }

    async deselect(uids) {
        const els = uids
            ? uids.map(a => this.getMessageByUID(a))
            : Object.values(this.messages);

        for(const el of els) {
            el.querySelector('input[type=checkbox]').checked = false;
        }

        await this.drawMessageControls();
    }

    onClickMessage = async (e) => {
        e.preventDefault();
        const target_message = e.target.closest('.message');
        const message = target_message.message;
        if(e.ctrlKey) {
            const checkbox = target_message.checkbox;
            if(!checkbox.disabled) checkbox.checked = !checkbox.checked;
            this.drawMessageControls();
        } else if(e.shiftKey) {
            window.getSelection().removeAllRanges();
            const all_messages = [...this.el.message_list.children];

            const message_a = this.messages[this.selectedMessage] || all_messages[0];
            const message_b = e.target.closest('.message');

            const index_a = all_messages.indexOf(message_a);
            const index_b = all_messages.indexOf(message_b);

            const [target_a, target_b] = index_a > index_b
                ? [index_b, index_a]
                : [index_a, index_b];

            const to_select = all_messages.filter((a,p) => p >= target_a && p <= target_b);

            for(const el of to_select) {
                if(!el.checkbox.disabled) el.checkbox.checked = !el.checkbox.checked;
            }

            this.drawMessageControls();
        } else {
            await this.openMessage(message.uid);
        }

    }

    onClickMessageCheckbox(e, uid) {
        e.stopPropagation();
    }

    async openMessage(uid) {
        this.selectedMessage = uid;

        this.indicateSelectedMessage();

        const message = this.mailbox.messages[uid];

        const setRead = (!message.flags.includes('\\Seen'));

        window.MessageView?.close();
        window.MessageView = new _MessageView(message, this.mailbox, this);
        await window.MessageView.open();

        await this.updateMessage(message);

        if(setRead && !message.localId)
            await this.mailbox.markMessages(message.uid,'add','\\Seen');

        await this.mailbox.updateInfo();
    }

    onClickCancel = async () => {
        await this.deselect();
    }

    deleteMessages = async (uids) => {
        if(!Array.isArray(uids)) uids = [uids];
        for(const uid of uids) {
            if(uid in this.messages) {
                this.messages[uid]?.remove();
                delete this.messages[uid];
            }
        }
        await this.drawMessageControls();
        await this.drawMessageCount();
    }

    getMessageByUID(uid) {
        return this.messages[parseInt(uid)];
    }

    getCheckedMessages() {
        const uids = [];
        for(const el of this.el.querySelectorAll(".message input:checked")) {
            if(!el.disabled && !uids.includes(el.parentElement.uid))
                uids.push(el.parentElement.uid);
        }
        return uids;
    }
}
