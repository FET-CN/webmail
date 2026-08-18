async function migrateStorage() {
    const lsKeys = Object.keys(localStorage);
    for(const key of lsKeys) {
        if(key === "cock-mail-settings" || key === "cock-mail-accounts") continue;
        const decoded = hex_decode(key);
        log('storage',"Migrating: " + decoded, INFO);
        const data = JSON.parse(localStorage.getItem(key));

        const mailbox = new MailboxStorage(decoded);
        await mailbox.init();

        const keys = Object.keys(data);
        var message_count = 0;

        for(const key of keys) {
            if(key === "messages") {
                const messages = Object.keys(data[key]);
                message_count = messages.length;
                for(const uid of messages) {
                    await mailbox.put('messages',uid,data[key][uid]);
                }
            } else {
                await mailbox.put('state',key,data[key]);
            }
        }

        log('storage',`Migrated ${keys.length} states and ${message_count} messages`,INFO);

        localStorage.removeItem(key);

        mailbox.close();

    }
}

//-------------------------------Helper Functions-----------------------------
