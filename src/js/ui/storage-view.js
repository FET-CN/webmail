class _StorageView extends View {
    constructor() {
        super('prompt');
        this._el = template('storage-prompt');
        this.el.appendChild(this._el);

        this.el.querySelectorAll('.title').forEach(e => {e.innerText = 'Manage Storage'});
        this.el.querySelectorAll('.close').forEach(e => e.addEventListener('click',((e) => {
            this.close();
        }).bind(this)));
        this.el.querySelectorAll('.deleteall').forEach(e => {
            e.addEventListener('click',async (e) => {
                if(!confirm("Really delete ALL local mailecho storage?")) return;
                for(const db of await indexedDB.databases()) {
                    await indexedDB.deleteDatabase(db.name);
                }
                alert("All storage deleted! Nothing will be stored until you reload the page.");
            });
        });
    }

    async draw() {
        const storageEstimate = await navigator.storage?.estimate();
        if(storageEstimate) {
            this.el.querySelectorAll('.storage').forEach(e => {
                e.classList.remove('hidden');
                e.querySelectorAll('.storageused').forEach(e => {
                    e.innerText = `approximately ${decodeSize(storageEstimate.usage)}/${decodeSize(storageEstimate.quota)}`;
                });
            });
        }

        const globalStorage = [];
        const accountStorage = [];
        const mailboxStorage = [];

        for(const db of await indexedDB.databases()) {
            if(db.name === "cock-mail-global") {
                globalStorage.push(db);
            } else if(db.name.match('/')) {
                mailboxStorage.push(db);
            } else {
                accountStorage.push(db);
            }
        }

        this.el.querySelectorAll('.globalstores .store').forEach(e => e.remove());
        this.el.querySelectorAll('.globalstores').forEach(async (e) => {
            for(const db of globalStorage) {
                e.appendChild(await this.drawStore(db));
            }
        });

        this.el.querySelectorAll('.accountstores .store').forEach(e => e.remove());
        this.el.querySelectorAll('.accountstores').forEach(async (e) => {
            for(const db of accountStorage) {
                e.appendChild(await this.drawStore(db));
            }
        });

        this.el.querySelectorAll('.mailboxstores .store').forEach(e => e.remove());
        this.el.querySelectorAll('.mailboxstores').forEach(async (e) => {
            for(const db of mailboxStorage) {
                e.appendChild(await this.drawStore(db));
            }
        });
    }

    async drawStore(db) {
        const entry = template('storage-store');
        entry.querySelector('.delete').addEventListener('click',(async (e) => {
            if(!confirm(`Really delete local storage named ${db.name}?`)) return;
            await indexedDB.deleteDatabase(db.name);
            this.draw();
        }).bind(this));
        entry.append(' ' + db.name);
        return entry;
    }
}
