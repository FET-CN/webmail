async function request_notifications() {
    if(window.CockmailSettings.notifications) {
        try {
            Notification.requestPermission().then((p) => {
                if(p !== "granted") {
                    log('notifications',"Notifications disabled",INFO);
                    window.CockmailSettings.set('notifications',false);
                } else {
                    log('notifications',"Notifications disabled: not granted",INFO);
                }
            });
        } catch(e) {
            log('notifications',e.message,ERR,e);
        }
    }
}

async function notification(mailbox) {
    if(window.CockmailSettings.notifications && (document.hidden || ! document.hasFocus())) {
        try {
            new Notification("COCK-MAIL", {body: `New message in ${mailbox}`, icon:'/favicon.ico', tag: `newmail-${mailbox}`});
        } catch(e) {}
    }
}
