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

async function paint() {
    return new Promise(resolve => setTimeout(resolve,0));
}

//-----------------------------------Views------------------------------------
