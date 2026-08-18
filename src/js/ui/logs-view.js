class _LogsView extends View {
    constructor() {
        super('prompt');
        this.el.classList.add('logs');
        this._el = template('logs-prompt');
        this.el.appendChild(this._el);

        this.el.querySelector('.title').innerText = 'Application Logs';

        this.el.querySelectorAll('.close').forEach(e => e.addEventListener('click',((e) => {
            this.close();
        }).bind(this)));

        this.defaultlevel = LOAD;
        this.defaultlive = true;

        this.verbosity = this.el.querySelector('input[name=verbosity]');
        this.verbosity.min = 0;
        this.verbosity.max = log_levels.length-1;
        this.verbosity.step = 1;

        this.live = this.el.querySelector('#live-logs');
        this.container = this.el.querySelector('.logs-container');
        this.table = this.el.querySelector('table');

        this.verbosity.addEventListener('input',this.onChangeLevel.bind(this));
        this.el.querySelector('.download').addEventListener('click',this.download.bind(this));
        this.el.querySelector('.copy').addEventListener('click',this.copy.bind(this));
        this.el.querySelector('.sendsupport').addEventListener('click',this.sendSupport.bind(this));

        this.verbosity.value = this.defaultlevel;

        this.live.onchange = (e) => {if(e.target.checked) this.draw();}
        this.live.checked = this.defaultlive;

        this.addEventListener('log',this.onLog.bind(this));
    }

    async close() {
        super.close();
        delete window.LogsView;
    }

    async draw() {
        const level = this.verbosity.value;
        const messages = this.getMessages();

        const table = this.el.querySelector('table');

        this.el.querySelector('.verbosity').innerText = log_level_descriptions[level];

        this.el.querySelectorAll('table tr:not(.header)').forEach(a => a.remove());
        for(const message of messages) {
            this.drawLogItem(message,false);
        }

        this.container.scrollTop = this.container.scrollTopMax;
    }

    drawLogItem(message,scroll_down=true) {
        const scrolled_down = scroll_down
            ? this.container.scrollTop === this.container.scrollTopMax
            : false;

        const entry = template('logs-entry');
        entry.classList.add(log_levels[message.level]);
        entry.querySelector('.time').innerText = this.timeFormat(message.date);
        entry.querySelector('.level').innerText = log_levels[message.level];
        entry.querySelector('.source').innerText = message.name;
        const long_entry = message.message.length > 512;
        if(long_entry)
            entry.querySelector('.message').innerText = message.message.slice(0,512) + '...';
        else
            entry.querySelector('.message').innerText = message.message;
        if(message.data || long_entry) {
            const data = entry.querySelector('.data a');
            data.classList.remove('hidden');
            data.onclick = this.devToolsLog.bind(this,message);
        }
        this.table.appendChild(entry);

        if(scrolled_down)
            this.container.scrollTop = this.container.scrollTopMax;
    }

    onLog(e) {
        if(this.live.checked && (e.detail.level <= this.verbosity.value)) {
            this.drawLogItem(e.detail);
        }
    }

    devToolsLog(message) {
        window.temp = message;
        console.info(`${this.timeFormat(message.date)}:`, message);
    }

    async onChangeLevel() {
        await this.draw();
    }

    timeFormat(t) {
        return t.getHours({hour12:false}).toString().padStart(2,'0')
            + ':' + t.getMinutes().toString().padStart(2,'0')
            + ':' + t.getSeconds().toString().padStart(2,'0')
            + '.' + t.getMilliseconds().toString().padStart(3,'0');
    }

    getMessages() {
        const level = this.verbosity.value;
        return level < log_levels.length-1
            ? window.log_messages.filter(a => (a.level <= level))
            : window.log_messages;
    }

    copy() {
        var string = '';
        for(const message of this.getMessages()) {
            string += this.timeFormat(message.date)
                + '\t[' + log_levels[message.level] + ']'
                + '\t[' + message.name + ']'
                + '\t' + message.message + '\n';
        }

        navigator.clipboard.writeText(string);
    }

    async download() {
        const logblob = await this.getBlob();

        const a = document.createElement('a');
        a.download = logblob[0]
        a.href = URL.createObjectURL(logblob[1]);
        a.click();
    }

    async getBlob() {
        const now = new Date();
        const blob_uncompress = new Blob([JSON.stringify(this.getMessages())],{type: 'application/octet-stream'});
        const compression_stream = blob_uncompress.stream().pipeThrough(new CompressionStream('gzip'));
        const compression_response = await new Response(compression_stream);
        const filename = 'cock-mail ' + now.toLocaleTimeString() + '.json.gz';

        return [filename, await compression_response.blob()];
    }

    async sendSupport() {
        const level = this.verbosity.value;

        if(level >= NET) {
            if(!confirm("Log levels NET and above include raw data including messages you sent and downloaded this session. Only IMAP/SMTP passwords are censored. Do you want to do this?")) return;
        }

        var body = `I need help with cock-mail.\r\n\r\nWhat I'm trying to do is:\r\n\r\n\r\nThe error I get is:\r\n\r\n\r\nI attached a logfile with verbosity ${log_levels[level]}.`;

        if(level >= NET) {
            body += " I UNDERSTAND THAT THIS LOG LEVEL INCLUDES NETWORK TRAFFIC FROM THIS SESSION INCLUDING MESSAGES SENT AND RECEIVED, AND THAT ONLY IMAP/SMTP PASSWORDS WERE CENSORED.";
        }

        const logblob = await this.getBlob();

        const message = new Message({
            headers: {
                To: atob(atob('YjJabWFXTnBZV3d0YzNWd2NHOXlkRUJqYjJOckxteHA=')), // not so fast
                Subject: 'Cock-mail support request'
            },
            body: body,
            attachments: [{
                content_type: 'application',
                content_subtype: 'gzip',
                filename: logblob[0],
                blob: logblob[1]
            }]
        });

        window.ComposeView = new _ComposeView(message,false);
        await window.ComposeView.enableMultipart();
        await window.ComposeView.open();
        await this.close();
    }
}

//---------------------------INIT---------------------------------------------
