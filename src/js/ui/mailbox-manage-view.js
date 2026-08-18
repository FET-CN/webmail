class _MailboxManageView extends View {
    constructor() {
        super('prompt')
        this.el.classList.add('mailbox-manage');
        this._el = template('mailbox-manage-prompt')
        this.el.appendChild(this._el);
        this.storage = window.AccountSettings.storage;
        this.mailboxes = window.AccountView.imap.mailboxes;
        this.imap = window.AccountView.imap;

        this.drawQueue = Promise.resolve();

        this.el.querySelectorAll('.title').forEach(e => {e.innerText = 'Manage Mailboxes'});
        this.el.querySelectorAll('.close').forEach(e => e.addEventListener('click',this.close.bind(this)));

        this.el.querySelectorAll('.create').forEach(e => e.addEventListener('click', this.onClickCreate.bind(this)));

        for(const a of ['mailboxes-changed']) {
            this.addEventListener(a, async () => {await this.draw.call(this)});
        }
    }

    async draw() {
        await this.drawQueue;

        const newQueue = this.drawQueue.then(async () => {
            this.mailboxes = window.AccountView.imap.mailboxes;
            this.el.querySelectorAll('.mailbox_list').forEach(e => e.remove());

            const mailboxes = this.el.querySelector('.mailboxes');
            window.second = false;
            await this.drawMailboxes.call(this,this.imap.getRootMailboxes(),mailboxes);
            delete window.second;
        });

        this.drawQueue = newQueue.catch(() => {});

        return newQueue;
    }

    async drawMailboxes(mailboxes,el,root='$$cock-mail-root') {
        const list = template('mailbox-manage-mailbox-list');
        const sorted_keys = await window.AccountView.sortMailboxes(mailboxes,root);
        for(const mailbox_name of sorted_keys) {
            const mailbox = this.mailboxes[mailbox_name];
            const entry = template('mailbox-manage-mailbox');

            if(window.second) entry.classList.add('second');
            else entry.classList.add('first');
            window.second = !window.second;

            if(mailbox.flags.includes('\\NonExistent') || mailbox.flags.includes('\\Noselect')) {
                entry.querySelectorAll('.delete').forEach(e => {e.onclick = null; e.classList.add('disabled');});
                entry.querySelectorAll('.rename').forEach(e => {e.onclick = null; e.classList.add('disabled');});
            } else {
                entry.querySelectorAll('.delete').forEach(e => {e.onclick = this.onClickDelete.bind(this,mailbox.mailbox);e.classList.remove('disabled');});
                entry.querySelectorAll('.rename').forEach(e => {e.onclick = this.onClickRename.bind(this,mailbox.mailbox);e.classList.remove('disabled');});
            }
            entry.querySelectorAll('.moveup').forEach(e => e.addEventListener('click', this.onClickMove.bind(this,mailbox_name,root,'up')));
            entry.querySelectorAll('.movedown').forEach(e => e.addEventListener('click', this.onClickMove.bind(this,mailbox_name,root,'down')));
            entry.querySelectorAll('.mailbox_name').forEach(e =>{
                e.innerText = mailbox.getShortName();
                if(!window.AccountView.isMailboxUsable(mailbox.mailbox))
                    e.classList.add('disabled');
            });

            const children = mailbox.getChildren();

            if(children.length) {
                await this.drawMailboxes(children,entry,mailbox.mailbox);
            }

            list.appendChild(entry);
        }
        el.appendChild(list);
    }

    async onClickCreate() {
        const delimiter = window.AccountView.imap.namespaces.personal[0][1];
        const title = "Create Mailbox";
        const text = `Use "${delimiter}" to delimit mailbox hierarchy. For example, creating a mailbox named "INBOX${delimiter}Cock" will create a folder "Cock" as a subfolder of "INBOX". If the parent folder doesn't exist yet it will be created but that parent folder will be unable to be selected or have messages moved to it.\n\nCommon Special-Use mailbox names include "Trash", "Sent", "Junk", "Drafts", and "Archive"`;

        const mailbox_name = await prompt(title,text);
        if(!mailbox_name) return;

        if(mailbox_name in window.AccountView.imap.mailboxes) {
            const mailbox = window.AccountView.imap.mailboxes[mailbox_name];
            if(window.AccountView.isMailboxUsable(mailbox_name)) {
                alert("Mailbox already exists!");
                return;
            }
        }

        try {
            await set_status(`Creating mailbox ${mailbox_name}`,"LOAD");
            await window.AccountView.imap.create(mailbox_name);
            await set_status("OK");
        } catch(e) {
            await set_status("ERR",null,e);
            return;
        }
    }

    async onClickDelete(mailbox) {
        if(mailbox.toLowerCase() === "inbox") {
            alert("Inbox can't be deleted");
            return;
        }
        if(!confirm(`Really delete mailbox ${mailbox}?\nTHIS WILL DELETE ALL MESSAGES IN THAT MAILBOX!`)) return;

        try {
            await set_status(`Deleting mailbox ${mailbox}`,"LOAD");
            await window.AccountView.imap.delete(mailbox);

            if(window.MailboxView.mailbox.mailbox === mailbox || window.AccountView.imap.isParentOf(mailbox,window.MailboxView.mailbox.mailbox))
                await window.MailboxView.close();

            const storage = new MailboxStorage(window.AccountView.account + '/' + mailbox);
            await storage.init();
            storage.deleteDB(true);
            await set_status("OK");
        } catch(e) {
            await set_status("ERR",null,e);
            return;
        }
    }

    async onClickRename(mailbox) {
        if(mailbox.toLowerCase() === "inbox") {
            alert("Inbox can't be renamed");
            return;
        }
        const delimiter = window.AccountView.imap.namespaces.personal[0][1];
        const title = "Rename Mailbox";
        const text = `Move a mailbox in and out of parent folders by deliminating with "${delimiter}". For example, rename "INBOX${delimiter}Cock" to "Archive${delimiter}.Cock" to move "Cock" into "Archive".`;

        const new_name = await prompt(title,text,mailbox);
        if(!new_name || (new_name === mailbox)) return;

        if(new_name in window.AccountView.imap.mailboxes) {
            const mailbox = window.AccountView.imap.mailboxes[new_name];
            if(window.AccountView.isMailboxUsable(new_name)) {
                alert("Mailbox already exists!");
                return;
            }
        }

        try {
            await set_status(`Renaming mailbox ${mailbox} to ${new_name}`, "LOAD");

            if(window.MailboxView.mailbox.mailbox === mailbox || window.AccountView.imap.isParentOf(mailbox,window.MailboxView.mailbox.mailbox))
                await window.MailboxView.close();

            await window.AccountView.imap.rename(mailbox,new_name);

            await set_status("OK");
        } catch(e) {
            await set_status("ERR",null,e);
            return;
        }
    }

    async onClickMove(mailbox, root, direction) {
        const order = window.AccountView.mailboxOrder[root] || await this.storage.get('mailboxes',root);
        const curpos = order.findIndex(a => a === mailbox);
        if((curpos === 0 && direction === 'up') || (curpos === order.length-1 && direction === 'down')) {
            alert("no");
            return;
        }

        const newpos = (direction === 'up') ? curpos-1 : curpos+1;

        order.splice(curpos,1);

        order.splice(newpos,0,mailbox);

        await this.storage.put('mailboxes',root,order);

        window.dispatchEvent(new CustomEvent("mailboxes-changed"));
    }
}
