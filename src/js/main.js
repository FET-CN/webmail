async function init() {
    init_log();

    const init = document.querySelector('#init');
    const initmsg = init.querySelector('.message');
    const needs_migrate = Object.keys(localStorage).some(key =>
        isLegacyMailboxKey(key)
    );

    window.GlobalStorage = new GlobalStorage();
    window.CockmailSettings = new CockmailSettings();

    if(needs_migrate) {
        initmsg.innerText = "Migrating your storage. This will only take a moment, please don't close the tab.";

        await migrateStorage();
    }

    await load_templates();

    await window.GlobalStorage.init();
    await window.CockmailSettings.init();

    initmsg.innerText = '';
    window.LoginView = new _LoginView();
    await window.LoginView.open();
}

/*
                                 IMPORTANT!
    If you want to connect to websockets on a different host than the page is
    being viewed from, you MUST change the 'connect-src' directive of the
    Content-Security-Policy tag (search for it) like this:
    connect-src wss://your-other-host.example.com;
*/

// These settings are things you will probably want to change.

init();
