const EMERG=0;
const ERR=1;
const WARN=2;
const INFO=3;
const LOAD=4;
const NET=5
const DEBUG=6;

const log_levels=['EMERG','ERROR','WARN','INFO','LOAD','NET','DEBUG'];

const log_level_descriptions= [
    'EMERG: Fatal errors.',
    'ERROR: Recoverable errors.',
    'WARN: Warnings. Parse failures and such.',
    'INFO: Completed actions and other info.',
    'LOAD: Started actions.',
    'NET: Raw network data',
    'DEBUG: Full debug data.'
];

function init_log() {
    window.log_messages = [];
}

function log(name,message,level=INFO,data) {
    const logitem = {
        date: new Date(),
        level: level,
        name: name,
        message: message,
        data: data
    };
    window.log_messages.push(logitem);

    if(log_messages.length > config.log_messages) log_messages.splice(0,1);

    if(level <= config.log_level_console) {
        switch(level) {
            case DEBUG:
            case NET:
                console.debug(logitem);
                break;
            case LOAD:
            case INFO:
                console.info(logitem);
                break;
            case WARN:
                console.warn(logitem);
                break;
            case ERR:
            case EMERG:
                console.error(logitem);
                console.error(logitem.data);
        }
    }

    window.dispatchEvent(new CustomEvent('log',{detail: logitem}));
}

const status_levels = {
    OK: INFO,
    LOAD: LOAD,
    ERR: ERR,
    DISC: ERR
};

const status_classes = {
    OK: 'OK',
    LOAD: 'LOAD',
    ERR: 'ERR',
    DISC: 'DISC'
}
