class _LoginView extends View {
    constructor() {
        super('login');

        this.showDevNotes = false;
        this.login_form = template('login_form');
        this.login_form.addEventListener('submit', this.onClickLogin.bind(this));
        this.el.querySelector('.login_form').appendChild(this.login_form);

        this.comments = [];
        const iterator = document.createNodeIterator(
            document,
            NodeFilter.SHOW_COMMENT,
            () => NodeFilter.FILTER_ACCEPT,
            false
        );
        let comment_node = [];
        while(comment_node = iterator.nextNode()) this.comments.push(comment_node.nodeValue);
    }

    async open() {
        document.querySelector('#init').style.display = "none";
        await super.open();
        try {
            const response = await apiFetch('/v1/me');
            if(response.ok) await this.loginFromSession(await response.json());
        } catch(error) {
            log('auth', 'Unable to restore the webmail session', DEBUG, error);
            await set_status('Unable to open mailbox', 'ERR', error?.message || error);
        }
    }

    async draw() {
        if(window.config.official) {
            const login_notes = this.el.querySelector('.login_notes');
            login_notes.innerHTML = '';
            login_notes.innerText = this.comments[1] || '';
        }
    }

    async onClickLogin(event) {
        event?.preventDefault();
        request_notifications();
        window.location.assign(window.apiEndpoint('/v1/session/start'));
    }

    async loginFromSession(session) {
        request_notifications();
        document.querySelector('#init').style.display = "none";
        const current = session.current_mailbox_id
            ? session.mailboxes?.find(item => item.id === session.current_mailbox_id)
            : null;
        const mailbox = current?.state === 'active'
            ? current
            : session.mailboxes?.find(item => item.state === 'active');
        if(!mailbox?.address) throw new Error('No mailbox is assigned to this identity.');
        if(mailbox.id !== session.current_mailbox_id) {
            const selected = await apiFetch('/v1/session/select', {
                method: 'POST',
                headers: {'content-type': 'application/json'},
                body: JSON.stringify({mailbox_id: mailbox.id})
            });
            if(!selected.ok) throw new Error('The selected mailbox is unavailable.');
        }
        const client = new ImapClient(window.config.imap_server);
        client.accountId = mailbox.id;

        try {
            set_status('Connecting', 'LOAD');
            await client.connect();
            set_status('OK');
            set_status('Logging in', 'LOAD');
            // The backend replaces this protocol placeholder with its own
            // Migadu identity after authenticating the WebSocket session.
            await client.login(mailbox.address, '');
            set_status('OK');

            window.AccountSettings = new AccountSettings(mailbox.address);
            await window.AccountSettings.init();
            window.LoginView?.close();
            window.LoginView = undefined;
            window.AccountView = new _AccountView(client, session.mailboxes || [], mailbox.id);
            await window.AccountView.open();
        } catch(error) {
            set_status('ERR', null, error);
            log('auth', 'Unable to connect to the mailbox', ERR, error);
            await client.close();
        }
    }
}
