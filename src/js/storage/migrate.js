async function migrateStorage() {
    const lsKeys = Object.keys(localStorage);
    for(const key of lsKeys) {
        if(key === "cock-mail-settings" || key === "cock-mail-accounts") continue;
        if(!isLegacyMailboxKey(key)) continue;

        const parsed = parseLegacyStorageValue(localStorage.getItem(key));
        if(!parsed.ok) {
            reportLegacyStorageIssue(key, parsed);
            // There is no recoverable mailbox data in an empty or malformed
            // entry. Remove it so a reload does not get stuck retrying it.
            localStorage.removeItem(key);
            continue;
        }

        const decoded = hex_decode(key);
        log('storage',"Migrating: " + decoded, INFO);
        const data = parsed.value;

        const mailbox = new MailboxStorage(decoded);
        await mailbox.init();

        try {
            const keys = Object.keys(data);
            var message_count = 0;

            for(const key of keys) {
                if(key === "messages") {
                    const messages = data[key];
                    if(!messages || typeof messages !== 'object' || Array.isArray(messages)) {
                        reportLegacyStorageIssue(`${decoded}.messages`, {ok: false, reason: 'not-an-object'});
                        continue;
                    }

                    const messageKeys = Object.keys(messages);
                    message_count = messageKeys.length;
                    for(const uid of messageKeys) {
                        await mailbox.put('messages',uid,messages[uid]);
                    }
                } else {
                    await mailbox.put('state',key,data[key]);
                }
            }

            log('storage',`Migrated ${keys.length} states and ${message_count} messages`,INFO);
        } finally {
            await mailbox.close();
        }

        localStorage.removeItem(key);
    }
}

//-------------------------------Helper Functions-----------------------------
