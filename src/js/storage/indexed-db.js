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

// Legacy localStorage entries are user-controlled data and may be empty or
// partially written (for example after a tab is closed during a write).
// Keep parsing guarded so one bad entry cannot prevent the application from
// opening its IndexedDB stores.
function parseLegacyStorageValue(rawValue) {
    if(typeof rawValue !== 'string' || rawValue.trim() === '') {
        return {ok: false, reason: 'empty'};
    }

    try {
        const value = JSON.parse(rawValue);
        if(!value || typeof value !== 'object' || Array.isArray(value)) {
            return {ok: false, reason: 'not-an-object'};
        }
        return {ok: true, value: value};
    } catch(error) {
        return {ok: false, reason: 'invalid-json', error: error};
    }
}

function reportLegacyStorageIssue(key, result) {
    const message = `Skipping invalid legacy storage entry: ${key} (${result.reason})`;
    if(typeof log === 'function') {
        const warningLevel = typeof WARN === 'number' ? WARN : 2;
        log('storage', message, warningLevel, result.error);
    } else {
        console.warn(message, result.error);
    }
}

function isLegacyMailboxKey(key) {
    return /^(?:[0-9a-f]{2})+$/i.test(key);
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
                    const key = 'cock-mail-settings';
                    const parsed = parseLegacyStorageValue(localStorage.getItem(key));
                    if(parsed.ok) {
                        for(const setting of Object.keys(parsed.value)) {
                            settings.put(parsed.value[setting], setting);
                        }
                    } else {
                        reportLegacyStorageIssue(key, parsed);
                    }
                    localStorage.removeItem(key);
                }
                if(lsKeys.includes('cock-mail-accounts')) {
                    const key = 'cock-mail-accounts';
                    const parsed = parseLegacyStorageValue(localStorage.getItem(key));
                    if(parsed.ok) {
                        for(const username of Object.keys(parsed.value))
                            accounts.put(parsed.value[username],username);
                    } else {
                        reportLegacyStorageIssue(key, parsed);
                    }
                    localStorage.removeItem(key);
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
