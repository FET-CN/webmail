class CockmailSettings {
    constructor() {
        this.defaults = {
            renderMedia: true,
            notifications: true
        };

        this.renderMedia = null;
        this.notifications = null;
    }

    async init() {
        const saved_keys = await window.GlobalStorage.get('settings');

        for(const key of Object.keys(this.defaults)) {
            if(saved_keys.includes(key))
                this[key] = await window.GlobalStorage.get('settings',key);
            else
                this[key] = this.defaults[key];
        }
    }

    async set(key,value) {
        this[key] = value;
        const result = await window.GlobalStorage.put('settings',key,value);
        window.SettingsView?.el.dispatchEvent(new CustomEvent("setting-changed"));
    }
}

class AccountSettings {
    constructor(username) {
        this.username = username;

        this.defaults = {
            replyAt: 'top',
            name: null,
            signature: null,
            replySignature: false,
            userAgent: window.config.user_agent
        };
        this.replyAt = null
        this.name = null;
        this.signature = null;
        this.replySignature = null;
        this.userAgent = null;

        this.storage = new AccountStorage(this.username);
    }

    async init() {
        await this.storage.init();

        const saved_keys = await this.storage.get('settings');

        for(const key of Object.keys(this.defaults)) {
            if(saved_keys.includes(key))
                this[key] = await this.storage.get('settings',key);
            else
                this[key] = this.defaults[key];
        }
    }

    async set(key,value) {
        this[key] = value;
        const result = await this.storage.put('settings',key,value);
        window.SettingsView?.el.dispatchEvent(new CustomEvent("setting-changed"));
    }
}

//-----------------------------------Storage----------------------------------
