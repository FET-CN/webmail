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
    `api_origin` controls both REST and WebSocket endpoints. When it names a
    same-site API subdomain, add that HTTPS and WSS origin to the generated
    document's `connect-src` directive as described in backend/README.md.
*/

// These settings are things you will probably want to change.

init();
