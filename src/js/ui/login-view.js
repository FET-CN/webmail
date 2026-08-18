class _LoginView extends View {
    constructor(imap_server=window.config.imap_server) {
        super('login');

        this.imap_server = imap_server;

        this.showDevNotes = false;

        this.login_form = template('login_form');
        this.login_form.addEventListener('submit',this.onClickLogin.bind(this));
        this.el.querySelector('.login_form').appendChild(this.login_form);

        this.el.querySelector('.managestorage').addEventListener('click', this.onClickManageStorage);

        this.comments = [];

        const iterator = document.createNodeIterator(document, NodeFilter.SHOW_COMMENT, () => NodeFilter.FILTER_ACCEPT, false);
        var comment_node = [];
        while(comment_node = iterator.nextNode()) {
            this.comments.push(comment_node.nodeValue);
        }
    }

    onClickManageStorage = async (e) => {
        window.StorageView = new _StorageView();
        await window.StorageView.open();
    }

    async open() {
        document.querySelector('#init').style.display = "none";
        await this.loadAccounts();
        await super.open();
        this.login_form.querySelector('input[name=username]').focus();
    }

    async draw() {
        if(window.config.official) {
            const login_notes = this.el.querySelector(".login_notes");

            login_notes.innerHTML = "";
            login_notes.innerText = this.comments[1];
        }

        const account_list = this.el.querySelector('.account_list');
        account_list.querySelectorAll('.entry').forEach(e => e.remove());

        const usernames = Object.keys(window.knownAccounts);

        if(usernames.length) {
            for(const username of Object.keys(window.knownAccounts)) {
                const password = window.knownAccounts[username];
                const entry = template('login-account_list');

                const _username = entry.querySelector('.username');
                const _delete = entry.querySelector('.delete');

                entry.username = username;
                entry.password = password;
                entry.addEventListener('click',this.onClickSavedAccountLogin.bind(this,username,password));

                _username.innerText = username;

                _delete.addEventListener('click', e => this.onClickSavedAccountDelete.call(this,username,e));

                account_list.appendChild(entry);
            }
        } else {
            account_list.appendChild(template('login-account_list_empty'));
        }

    }

    async loadAccounts() {
        window.knownAccounts = {};

        const usernames = await window.GlobalStorage.get('accounts');

        for(const username of usernames) {
            window.knownAccounts[username] = await window.GlobalStorage.get('accounts',username);
        }

    }

    async deleteAccount(username){
        delete window.knownAccounts[username];
        return window.GlobalStorage.delete('accounts',username);
    }

    async onClickSavedAccountDelete(username,e) {
        e.stopPropagation();

        await this.deleteAccount(username);

        this.draw();
        return false;
    }

    async onClickSavedAccountLogin(username,password) {
        return this.login(username,password);
    }

    async onClickLogin() {
        request_notifications();

        const username = this.login_form.querySelector("input[name=username]").value;
        const password = this.login_form.querySelector("input[name=password]").value;
        const save_account = this.login_form.querySelector("select[name=save_password]").value;

        if(username.length === 0) {
            alert("Your username cannot be blank");
            return false
        }
        if(password.length === 0) {
            alert("Your password cannot be blank");
            return false;
        }

        if(save_account == "save" || save_account == "session") {
            await addAccount(username, password, save_account === "save");
        }

        return this.login(username, password);
    }

    async login(username, password) {
        request_notifications();

        document.querySelector('#init').style.display = "none";

        const client = new ImapClient(this.imap_server);

        try {
            set_status("Connecting", "LOAD");

            await client.connect();
            set_status("OK");

            set_status("Logging in", "LOAD");
            await client.login(username, password);
            set_status("OK");

            window.AccountSettings = new AccountSettings(username);
            await window.AccountSettings.init();

            window.LoginView?.close();
            window.LoginView = undefined;
            window.AccountView = new _AccountView(client);
            await window.AccountView.open();
        } catch(e) {
            set_status("ERR",null,e);
            await client.close();
            return;
        }
    }
}
