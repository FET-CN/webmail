class _SettingsView extends View {
    constructor() {
        super('prompt');
        this.el.classList.add('settings');
        this._el = template('settings-prompt');
        this.el.appendChild(this._el);
        this.settings=window.CockmailSettings;
        this.asettings = window.AccountSettings;

        this.el.querySelectorAll('.title').forEach(e => {e.innerText = 'Settings'});

        this.el.querySelectorAll('.close').forEach(e => e.addEventListener('click',((e) => {
            this.close();
        }).bind(this)));

        this._el.querySelector('#settings-notifications').addEventListener('change',((e) => {
            this.settings.set('notifications', e.target.checked);
            request_notifications();
        }).bind(this));

        this._el.querySelector('#settings-renderMedia').addEventListener('change',((e) => {
            this.settings.set('renderMedia', e.target.checked);
        }).bind(this));

        this._el.querySelector('#settings-account-replyAt').addEventListener('change',((e) => {
            this.asettings.set('replyAt', e.target.value || null);
        }).bind(this));

        this._el.querySelector('#settings-account-name').addEventListener('change',((e) => {
            this.asettings.set('name', e.target.value || null);
        }).bind(this));

        this._el.querySelector('#settings-account-signature').addEventListener('change',((e) => {
            this.asettings.set('signature', e.target.value || null);
        }).bind(this));

        this._el.querySelector('#settings-account-replySignature').addEventListener('change',((e) => {
            this.asettings.set('replySignature', e.target.checked || null);
        }).bind(this));

        this._el.querySelector('#settings-account-userAgent').addEventListener('change',((e) => {
            this.asettings.set('userAgent', e.target.value || null);
        }).bind(this));

        this.el.addEventListener('setting-changed', this.draw.bind(this));
    }

    async close() {
        super.close();
        delete window.SettingsView;
    }

    async draw() {
        this.el.querySelector('#settings-notifications').checked =  this.settings.notifications === true;
        this.el.querySelector('#settings-renderMedia').checked =  this.settings.renderMedia === true;
        this.el.querySelector('#settings-account-replyAt').value = this.asettings.replyAt || '';
        this.el.querySelector('#settings-account-name').value = this.asettings.name || '';
        this.el.querySelector('#settings-account-signature').value =  this.asettings.signature || '';
        this.el.querySelector('#settings-account-replySignature').checked =  this.asettings.replySignature === true;
        this.el.querySelector('#settings-account-userAgent').value =  this.asettings.userAgent || '';
    }
}
