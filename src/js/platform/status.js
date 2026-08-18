async function set_status(status_message,ok="OK",data) {
    const exist_status = window.status_message || '';

    if(status_message === "OK" || status_message === "ERR") {
        ok = status_message;
        status_message = exist_status;
        if(ok === "OK") status_message += " Done!";
        if(ok === "ERR") status_message += " Error!";
    } else if(ok === "LOAD" && exist_status.slice(-3) !== '...') {
        status_message += "... ";
    }

    const status_level = status_levels[ok];
    const status_class = status_classes[ok];

    window.status_message = status_message;

    const $el = document.getElementById('status');
    const status_p = $el.querySelector('p');
    const status_data_label = $el.querySelector('label');
    const status_data_toggle = $el.querySelector('#status-data-toggle');
    const status_data = $el.querySelector('pre');
    const status_color = $el.querySelector('#status_color');

    log('status',status_message,status_level,data);

    status_p.innerText = status_message;
    status_color.setAttribute('class',status_class);

    if(status_message)
        $el.style.display = "block";
    else
        $el.style.display = "none";

    if(data) {
        status_data.innerText = data;
        status_data_label.classList.remove('hidden');
    } else {
        status_data_label.classList.add('hidden');
        status_data_toggle.checked = false;
        status_data.innerText = '';
    }
}
