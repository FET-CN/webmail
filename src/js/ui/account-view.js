class _AccountView extends View {
    constructor(imap) {
        super('account');

        this.imap = imap;
        this.imap.onlogin = this.onLogin;
        this.imap.onclose = this.onClose;

        this.settings = window.AccountSettings;
        this.storage = window.AccountSettings.storage;

        this.mailboxes = {} // containts mailbox list elements by name;
        this.mailbox_container = this.el.querySelector('.mailboxes');

        this.mailboxOrder = {};

        this.addEventListener('mailbox-created', this.onMailboxCreated);
        this.addEventListener('mailbox-renamed', this.onMailboxRenamed);
        this.addEventListener('mailbox-deleted', this.onMailboxDeleted);
        this.addEventListener('mailboxes-changed', this.drawMailboxes.bind(null,null,null));

        this.el.querySelector('.compose')?.addEventListener('click', this.onClickCompose);
        this.el.querySelector('.settings')?.addEventListener('click', this.onClickSettings);
        this.el.querySelector('.reconnect')?.addEventListener('click', this.onClickReconnect);
        this.el.querySelector('.disconnect')?.addEventListener('click', this.onClickDisconnect);
        this.el.querySelector('.logout')?.addEventListener('click', this.onClickLogout);
        this.el.querySelector('.lightmode')?.addEventListener('click', this.onClickLightmode);
        this.el.querySelector('.support')?.addEventListener('click', this.onClickSupport);
        this.el.querySelector('.logs')?.addEventListener('click', this.onClickLogs);
        this.el.querySelector('.manage')?.addEventListener('click', this.onClickManageMailboxes);
    }

    async open() {
        try {
            super.open();
            await set_status("Loading mailboxes", "LOAD");
            await this.imap.list();
            //await this.drawMailboxes();
        } catch(e) {
            await set_status("ERR",null,e);
        }
        await set_status("OK");

        await this.openMailbox('INBOX');
    }

    draw = () => {
        if(this.imap.username) {
            this.el.querySelectorAll('.username').forEach(e => e.innerText=this.imap.username);
            this.el.querySelectorAll('.onlyloggedin').forEach(e => e.classList.remove('hidden'));
            this.el.querySelectorAll('.account_status:not(.onlyloggedin)').forEach(e => e.classList.add('hidden'));

            if(this.imap.connected) {
                this.el.querySelectorAll('.disconnect').forEach(e => e.classList.remove('hidden'));
                this.el.querySelectorAll('.reconnect').forEach(e => e.classList.add('hidden'));
            } else {
                this.el.querySelectorAll('.disconnect').forEach(e => e.classList.add('hidden'));
                this.el.querySelectorAll('.reconnect').forEach(e => e.classList.remove('hidden'));
            }

        } else {
            this.el.querySelectorAll('.onlyloggedin').forEach(e => e.classList.add('hidden'));
            this.el.querySelectorAll('.account_status:not(.loading)').forEach(e => e.classList.add('hidden'));
        }
    }

    onLogin = () => {
        this.draw();
    }

    onClose = () => {
        set_status("Disconnected.", "DISC");
        window.AccountView.draw();
    }

    onClickReconnect = async () => {
        this.imap.reconnect = true;
        const password = window.knownAccounts[this.imap.username] || await promptPassword(this.imap.username);
        if(!password) {
            alert("Refusing to use an empty password!");
            return;
        }
        await this.imap.connect();
        await this.imap.login(this.imap.username, password);
        await this.imap.list();

        if(window.MailboxView) {
            await set_status(`Loading mailbox ${window.MailboxView.mailbox.mailbox}`, "LOAD");
            await window.MailboxView.mailbox.load();
            await set_status("OK");

            await window.AccountView.imap.notify();
        }

        this.draw();
    }

    onClickDisconnect = async () => {
        this.imap.reconnect = false;
        await this.imap.logout();
    } 

    onClickLogout = async () => {
        this.imap.reconnect = false;

        if(this.imap.connected)
            await this.imap.logout();

        set_status();

        await window.ComposeView?.close();
        window.ComposeView = undefined;
        await window.MessageView?.close();
        window.MessageView = undefined;
        await window.MailboxView?.close();
        window.MailboxView = undefined;
        await window.AccountView?.close();
        window.AccountView = undefined;

        window.LoginView = new _LoginView();
        await window.LoginView.open();
    }

    onClickLightmode = async () => {
        const a = document.getElementById('flashbang');

        a.classList.remove('flash');
        a.offsetHeight;
        a.classList.add('flash');
        window.setTimeout(() => {a.classList.remove('flash')},90000);
    }

    onClickSupport = async () => {
        const message = new Message({
            headers: {
                To: atob(atob('YjJabWFXTnBZV3d0YzNWd2NHOXlkRUJqYjJOckxteHA=')), // not so fast
                Subject: 'mailecho support request'
            },
            body: "I need help with mailecho.\r\n\r\nWhat I'm trying to do is:\r\n\r\n\r\nThe error I get is:\r\n"
        });
        window.ComposeView = new _ComposeView(message,false);
        return window.ComposeView.open();
    }

    onClickLogs = async () => {
        window.LogsView = new _LogsView();
        await window.LogsView.open();
    }

    onClickCompose = () => {
        window.ComposeView = new _ComposeView();
        return window.ComposeView.open();
    }

    onClickSettings = () => {
        window.SettingsView = new _SettingsView();
        return window.SettingsView.open();
    }

    onMailboxRenamed = async e => {
        const old_name = e.detail.old_name;
        const new_name = e.detail.name;
        await this.renameMailbox(old_name,new_name);
        window.dispatchEvent(new CustomEvent("mailboxes-changed"));
    }

    async renameMailbox(old_name,new_name) {
        const mailbox = this.mailboxes[old_name];
        this.mailboxes[new_name] = mailbox;
        delete this.mailboxes[old_name];
        mailbox.remove();

        const container = await this.getParent(mailbox.mailbox);

        const existing_list = container.querySelector('.mailbox_list');

        const list = existing_list || template('account-mailbox-list');

        if(!existing_list)
            container.appendChild(list);

        const link = mailbox.querySelector('.mailbox_name');
        link.innerText = mailbox.mailbox.getShortName();

        list.appendChild(mailbox);
    }

    onMailboxDeleted = async e => {
        const mailbox_name = e.detail.name;
        await this.deleteMailbox(mailbox_name);
        window.dispatchEvent(new CustomEvent("mailboxes-changed"));
    }

    async deleteMailbox(mailbox_name) {
        const mailbox = this.mailboxes[mailbox_name];
        if(!mailbox) return;
        mailbox.remove();
        delete this.mailboxes[mailbox_name];
    }

    // Returns the container for the parent of the mailbox object, creating any necessary
    async getParent(mailbox) {
        const parent = mailbox.getParent();

        if(!parent) return this.mailbox_container;

        const parent_exist = parent in this.mailboxes;

        if(parent_exist) return this.mailboxes[parent];

        const parent_mailbox = this.imap.mailboxes[parent] ||
            new ImapMailbox(this.imap,this.imap.username,parent);

        if (!parent_exist) {
            this.imap.mailboxes[parent] = parent_mailbox;
            await parent_mailbox.init();
            parent_mailbox.flags = ['\\NonExistent'];
            parent_mailbox.delimiter = mailbox.delimiter;
        }

        return await this.createMailbox(parent_mailbox);
    }

    onMailboxCreated = async e => {
        const mailbox = e.detail.mailbox;
        await this.createMailbox(mailbox);
        window.dispatchEvent(new CustomEvent("mailboxes-changed"));
    }

    // Takes a mailbox object and installs it in the mailbox list, returns the container
    async createMailbox(mailbox) {
        if(mailbox.mailbox in this.mailboxes) {
            const existing = this.mailboxes[mailbox.mailbox];
            existing.mailbox = mailbox;
            existing.mailbox.onstatus = this.drawMailboxInfo.bind(this,existing.mailbox,existing);
            this.mailboxes[mailbox.mailbox].setAttribute('class',escapeHtml(mailbox.flags.join(' '),'_'));
            return existing;
        }

        const container = await this.getParent(mailbox);

        const existing_list = container.querySelector('.mailbox_list');

        const list = existing_list || template('account-mailbox-list');

        if(!existing_list)
            container.appendChild(list);

        const entry = template('account-mailbox');
        const link = entry.querySelector(':scope > .mailbox_name');
        entry.mailbox = mailbox;
        entry.setAttribute('data-flags',escapeHtml(mailbox.flags.join(' '),'_'));
        entry.link.innerText = mailbox.getShortName();

        this.mailboxes[mailbox.mailbox] = entry;
        mailbox.onstatus = this.drawMailboxInfo.bind(this,mailbox,entry);

        list.appendChild(entry);

        return entry;
    }

    // Doesn't actually draw the mailbox, sorts it
    drawMailboxes = async (mailboxes,root) => {
        if(!mailboxes) mailboxes = await this.imap.getRootMailboxes();

        const sorted_keys = await this.sortMailboxes(mailboxes,root);

        for(const mailbox_name of sorted_keys) {
            const mailbox = this.mailboxes[mailbox_name];
            if(!mailbox) continue;
            const parent = await this.getParent(mailbox.mailbox);
            const list = parent.querySelector('.mailbox_list');
            const link = mailbox.querySelector(':scope > .mailbox_name');

            list.appendChild(mailbox);

            if(mailbox.mailbox.flags.includes('\\NonExistent') || mailbox.mailbox.flags.includes('\\Noselect')) {
                link.classList.add('disabled');
                link.onclick = null;
            } else {
                link.classList.remove('disabled');
                link.onclick = this.onClickMailbox.bind(this,mailbox.mailbox.mailbox);
            }

            const children = mailbox.mailbox.getChildren();

            if(children.length) {
                await this.drawMailboxes(children,mailbox.mailbox.mailbox);
            }
        }
    }

    async drawMailboxInfo(mailbox,el,oldunread) {
        const unread = el.querySelector(':scope > .unread');
        unread.innerHTML = parseInt(mailbox.unseen) || '';
        if(mailbox.unseen && mailbox.unseen > oldunread) {
            await notification(mailbox.mailbox);
        }
    }

    async sortMailboxes(mailboxes,root='$$cock-mail-root') {
        if(root === null) root='$$cock-mail-root';

        const mailbox_keys = mailboxes instanceof Array
            ? mailboxes.map(a => a.mailbox || a)
            : Object.keys(mailboxes);

        var sort_order = await window.AccountSettings.storage.get('mailboxes',root);
        if(sort_order && sort_order.length) {
            if(mailbox_keys.length) {
                sort_order = [ ...new Set([
                    ...sort_order
                        .filter(a => mailbox_keys.includes(a)),
                    ...mailbox_keys.filter(a => !sort_order.includes(a))
                    ])
                ];
            }

        } else {
            sort_order = [ ...new Set([
                ...[
                    this.imap.inbox,
                    this.imap.junk,
                    this.imap.trash,
                    this.imap.drafts,
                    this.imap.sent,
                    this.imap.archive
                ],
                ...mailbox_keys
            ])].filter(Boolean).filter(a => mailbox_keys.includes(a));
        }

        this.mailboxOrder[root] = sort_order;

        //await window.AccountSettings.storage.put('mailboxes',root,sort_order);
        return sort_order;
    }

    isMailboxUsable(mailbox_name) {
        const mailboxes = this.imap.mailboxes;
        const mailbox = mailboxes[mailbox_name];

        if(!mailbox) return false;

        return !(mailbox.flags.includes("\\Noselect") || mailbox.flags.includes("\\NonExistent"));
    }

    onClickManageMailboxes = async () => {
        window.MailboxManageView = new _MailboxManageView();
        await window.MailboxManageView.open();
    }

    onClickMailbox = async (mailbox) => {
        await this.openMailbox(mailbox);
    }

    async openMailbox(mailbox_name) {
        const mailbox = this.imap.mailboxes[mailbox_name];

        const old_mailbox = window.MailboxView;

        window.MailboxView = new _MailboxView(mailbox,window.MessageView?.el);
        old_mailbox?.close();
        await window.MailboxView.open();
        await this.drawMailboxInfo(mailbox,this.mailboxes[mailbox.mailbox]);
    }
}
