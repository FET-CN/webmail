async function prompt(title,text,value='') {
    const _el = template('prompt');
    _el.querySelectorAll('.title').forEach(e => {e.innerText = title});
    _el.querySelectorAll('.close').forEach(e => e.addEventListener('click', e => _el.remove()));
    const el = template('input-prompt');

    el.querySelectorAll('.text').forEach(e => {e.innerText=text;});
    el.querySelectorAll('input[type=text]').forEach(e => {e.value=value;});

    _el.appendChild(el);

    const submit_promise = new Promise((resolve, reject) => {
        el.addEventListener('submit', async (e) => {
            const input = e.target.querySelector('input[type=text]').value;

            _el.remove();

            resolve(input);
        });
    });

    document.body.appendChild(_el);

    _el.querySelector('input[type=text]').focus();

    return submit_promise;
}

async function promptCreateMailbox(title,text,value='') {
    const _el = template('prompt');
    _el.querySelectorAll('.title').forEach(e => {e.innerText = title});
    _el.querySelectorAll('.close').forEach(e => e.addEventListener('click', e => _el.remove()));
    const el = template('mailbox-create-prompt');

    el.querySelectorAll('.text').forEach(e => {e.innerText=text;});
    el.querySelectorAll('input[name=mailbox]').forEach(e => {e.value=value;});

    _el.appendChild(el);

    const submit_promise = new Promise((resolve, reject) => {
        el.addEventListener('submit', async (e) => {
            const mailbox = e.target.querySelector('input[name=mailbox]').value;
            const flag = e.target.querySelector('select[name=flag]').value;

            _el.remove();

            resolve([mailbox,flag]);
        });
    });

    document.body.appendChild(_el);

    _el.querySelector('input[type=text]').focus();

    return submit_promise;
}

async function promptPassword(username) {
    const _el = template('prompt');
    _el.querySelectorAll('.title').forEach(e => {e.innerText = "Password Required"});
    _el.querySelectorAll('.close').forEach(e => e.addEventListener('click', e => _el.remove()));
    const el = template('password-prompt');
    _el.appendChild(el);

    const login_form = template('login_form');
    const input_user = login_form.querySelector('input[name=username]');
    input_user.value = username;
    input_user.disabled = true;
    el.appendChild(login_form);

    const submit_promise = new Promise((resolve, reject) => {
        login_form.addEventListener('submit', async (e) => {
            const password = e.target.querySelector('input[name=password]').value;
            const save = e.target.querySelector('select[name=save_password]').value;

            if(save === "session" || save === "save") {
                await addAccount(username, password, save === "save");
            }

            _el.remove();

            resolve(password);
        });
    });

    document.body.appendChild(_el);

    _el.querySelector('input[name=password]').focus();

    return submit_promise;
}

async function paint() {
    return new Promise(resolve => setTimeout(resolve,0));
}

//-----------------------------------Views------------------------------------
