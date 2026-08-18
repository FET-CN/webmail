class CockmailStorage {
    constructor(dbname="global") {
        this.dbnameprefix = "cock-mail-"
        this.dbname = dbname;
        this.version = 2;
        this.db = null;

        this.dbopen = null;
    }

    async init() {
        this.dbopen = indexedDB.open(this.dbnameprefix + this.dbname, this.version);

        this.dbopen.onupgradeneeded = this.upgrade.bind(this);

        const wait_connect = new Promise((resolve, reject) => {
            this.dbopen.onsuccess = resolve;
            this.dbopen.onerror = reject;
        });

        await wait_connect;

        this.db = this.dbopen.result;

        this.db.onversionchange = this.versionchange;
    }

    async versionchange(e) {
        await this.db?.close();
        alert("Database is broken! Either you deleted your browser storage or opened a more recent version of mailecho in a new tab. Either way I'm gonna GTFO now.");
        document.body.innerHTML="<h1>I broke!</h1>";
    }

    async get(store,key) {
        const tx = this.db.transaction(store);
        const s = tx.objectStore(store);

        const request = key
            ? s.get(key)
            : s.getAllKeys();

        const wait_get = new Promise((resolve, reject) => {
            request.onsuccess = resolve;
            request.onerror = reject;
        });

        const response = await wait_get;

        return response.target.result;

    }

    async getAll(store) {
        const tx = this.db.transaction(store);
        const s = tx.objectStore(store)

        const request = s.getAll();

        const wait_get = new Promise((resolve, reject) => {
            request.onsuccess = resolve
            request.onerror = reject;
        });

        const response = await wait_get;

        return response.target.result;
    }

    async put(store,key,value) {
        const tx = this.db.transaction(store,'readwrite');
        const s = tx.objectStore(store);

        const request = await s.put(value,key);

        const wait_put = new Promise((resolve, reject) => {
            request.onsuccess = resolve;
            request.onerror = reject;
        });

        const response = await wait_put;

        return tx;
    }

    async delete(store,key) {
        const tx = this.db.transaction(store,'readwrite');
        const s = tx.objectStore(store);

        const request = key
            ? s.delete(key)
            : s.clear();

        const wait_delete = new Promise((resolve, reject) => {
            request.onsuccess = resolve;
            request.onerror = reject;
        });

        const response = await wait_delete;

        return response.target.result;
    }

    async deleteDB(keepalive=false) {
        if(keepalive) this.db.onversionchange = null;

        await this.close();

        const dbdelete = indexedDB.deleteDatabase(this.dbnameprefix + this.dbname);

        const wait_delete = new Promise((resolve, reject) => {
            dbdelete.onsuccess = resolve;
            dbdelete.onerror = reject;
        });

        return wait_delete;
    }

    async close() {
        return await this.db.close();
    }
}

class GlobalStorage extends CockmailStorage {
    async upgrade(e) {
        const tx = e.target.transaction;
        this.db = this.dbopen.result;
        switch(e.oldVersion) {
            case 0:
                const settings = this.db.createObjectStore('settings');
                const accounts = this.db.createObjectStore('accounts');
                const lsKeys = Object.keys(localStorage);
                if(lsKeys.includes('cock-mail-settings')) {
                    const lsSettings = JSON.parse(localStorage.getItem('cock-mail-settings'));
                    for(const key of Object.keys(lsSettings)) {
                        settings.put(lsSettings[key], key);
                    }
                    localStorage.removeItem('cock-mail-settings');
                }
                if(lsKeys.includes('cock-mail-accounts')) {
                    const lsSettings = JSON.parse(localStorage.getItem('cock-mail-accounts'));
                    for(const username of Object.keys(lsSettings))
                        accounts.put(lsSettings[username],username);
                    localStorage.removeItem('cock-mail-accounts');
                }
                break;
        }
    }
}

class AccountStorage extends CockmailStorage {
    async upgrade(e) {
        const db = this.dbopen.result;
        switch(e.oldVersion) {
            case 0:
                const mailboxes = db.createObjectStore('mailboxes');
                mailboxes.createIndex('use_flags_idx', 'use_flags', {unique: false, multiEntry: true});
                mailboxes.createIndex('order_idx', 'order', {unique: false});
                const settings = db.createObjectStore('settings');
                break;
        }
    }
}

class MailboxStorage extends CockmailStorage {
    async upgrade(e) {
        const db = this.dbopen.result;
        switch(e.oldVersion) {
            case 0:
                db.createObjectStore('state');
                db.createObjectStore('messages');
                db.createObjectStore('fullMessages');
                break;
            case 1:
                db.createObjectStore('fullMessages');
                break;
        }
    }
}
