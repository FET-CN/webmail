class SmtpClient {
    constructor(smtpURL=window.config.smtp_server) {
        this.smtpURL = smtpURL;

        // WebSocket
        this.ws = null; // Set in connect()

        // Buffers, Queues
        this.responseBuffer = new Uint8Array();
        this.commandQueue = Promise.resolve();
        this.responseQueue = Promise.resolve();

        // Server info
        this.capabilities = new Set();

        this.ehlo = window.config.ehlo;
        this.maxrcpt = window.config.maxrcpt;

        // State flags
        this.connected = false;        // Socket open
        this.reconnect = true;         // Reconnect on socket close
        this.receivedGreeting = false; // Server is alive
        this.loggedin = false;         // Currently logged in

        // State info
        this.username = null;      // Set if ever logged in
        this.commandState = null;  // State info for commands that don't fit in a single message

        // Public (settable) Callbacks
        this.onopen = null;    // On socket open and received greeting
        this.onclose = null;   // On socket close
        this.onmessage = null; // On any partial or full message from IMAP
        this.onerror = null;   // On socket open

        // Internal Callbacks, Timeouts
        this._onopen = null;    // On socket open and received greeting
        this._onclose = null;   // On socket close
        this._onmessage = null; // On partial or full message
        this._onerror = null;   // On socket error

        // Engines
        this.encoder = new TextEncoder();
        this.decoder = new TextDecoder('utf-8');
    }

    // Wait for connection to complete and receive greeting
    async connect() {
        // WebSocket
        this.ws = new WebSocket(this.smtpURL);
        this.ws.binaryType = "arraybuffer";
        this.ws.onopen = this.#onWsOpen;
        this.ws.onclose = this.#onWsClose;
        this.ws.onerror = this.#onWsError;
        this.ws.onmessage = this.#onWsMessage;

        return new Promise((resolve, reject) => {
            this._onmessage = this.#handleCommandResponse.bind(this, ({response_code, response_message, response_data}) => {
                if(response_code === 220) {
                    resolve({response_code, response_message, response_data});
                } else {
                    reject({response_code, response_message, response_data});
                }
            });
        });
    }

    // Send an e-mail over SMTP
    async send(username, password, from, message) {
        // Extract RCPTs
        const rcpts = await message.extractRCPTs();

        if(!rcpts.length) {
            throw "No recipients!";
        }

        if(rcpts.length > this.maxrcpt) {
            throw `Too many recipients: ${rcpts.length} / ${this.maxrcpt}`;
        }

        const bcc = message.headers.get('bcc');
        delete message.headers.delete('bcc');

        // Add Date, Message-ID, and User-Agent headers
        message.headers.set('Date',new Date().toUTCString().replace(/\w*$/,'+0000'));
        message.headers.set('Message-ID','<' + uuid4() + '@' + (from.split('@')[1] || '127.0.0.1') + '>');
        if(window.AccountSettings.userAgent)
            message.headers.set('User-Agent',window.AccountSettings.userAgent);

        // Connect websocket
        const { response_code } = await this.connect();

        // EHLO
        if(true) { // NEVER trust an open bracket on its own line. Every { needs a supervisor.
            const { response_code, response_message, response_data } = await this.#command(`EHLO ${this.ehlo}`);

            const capabilities_raw = [ ...response_data.slice(1), response_message ];
            const capabilities = [];
            for(const capability of capabilities_raw) {
                if(capability.startsWith('AUTH')) {
                    const auth_split = capability.split(' ');
                    for(const auth of auth_split.slice(1)) {
                        capabilities.push('AUTH ' + auth);
                    }
                } else {
                    capabilities.push(capability);
                }
            }
            this.capabilities = new Set(capabilities);

            log('smtp', "Set capabilities", DEBUG, this.capabilities);
        }

        // AUTH
        await this.login(username,password);

        // MAIL FROM
        if(true) {
            const arg = `FROM: ${from}`;
            const { response_code, response_message, response_data } = await this.#command(`MAIL ${arg}`);
            if(response_code !== 250) throw {cmd: "MAIL", arg: arg, msg: response_code + ' ' + response_message};

        }

        // RCPT TO
        for(const rcpt of rcpts) {
            const arg = `TO: ${rcpt}`;
            const { response_code, response_message, response_data } = await this.#command(`RCPT ${arg}`);
            if(response_code !== 250) throw {cmd: "RCPT", arg: arg, msg: response_code + ' ' + response_message};
        }

        // DATA
        if(true) {
            const { response_code, response_message, response_data } = await this.#command("DATA");
            if(response_code !== 354) throw {cmd: "DATA", msg: response_code + ' ' + response_message};
        }

        this.#send(await message.compile(true));

        //  .
        if(true) {
            const { response_code, response_message, response_data } = await this.#command("\r\n.");
            if(response_code !== 250) throw {cmd: "ENDDATA", msg: response_code + ' ' + response_message};
        }

        // QUIT

        await this.quit();

        if(bcc) message.headers.set('BCC',bcc);

        message.flags.push("\\Seen");

        await message.compile(false);

        await message.onsend?.();

        return message;
    }

    // Send raw string to socket, plus CRLF
    #send(cmd,containsPass) {
        if (this.ws.readyState !== WebSocket.OPEN) throw new Error("Not connected");

        const logmsg = containsPass
            ? 'AUTH PLAIN AEF6dXJlRGlhbW9uZABodW50ZXIy'
            : cmd;

        log('smtp_out', logmsg, DEBUG);

        const arrayBuffer = this.encoder.encode(cmd + "\r\n").buffer;
        this.ws.send(arrayBuffer);
    }

    // Run an SMTP command and set finish callback
    async #command(cmd, handler=this.#handleCommandResponse, containsPass=false) {
        await this.commandQueue;

        this.commandQueue = this.commandQueue.then(() => {
            handler = handler.bind(this);

            const finishPromise = new Promise((resolve, reject) => {
                handler = handler.bind(this, ({response_code, response_message, response_data}) => {
                    resolve({ response_code, response_message, response_data });
                });
            });

            this._onmessage = handler;
            this.#send(cmd,containsPass);

            return finishPromise;

        });

        return this.commandQueue;

    }

    // LOGIN: Log in with a given username and password
    async login(user, pass) {
        if(!this.capabilities.has("AUTH PLAIN")) {
            throw "Server has no AUTH PLAIN capability!";
        }

        const auth_value = btoa("\0" + user + "\0" + pass)

        const { response_code, response_message, response_data } = await this.#command(`AUTH PLAIN ${auth_value}`, undefined, undefined, true);

        this.loggedin = response_code === 235;

        if(this.loggedin) {
            this.username = user;
            this.onlogin?.();
        } else {
            throw {cmd: "AUTH", msg: `${response_code} ${response_message}`};
        }

        return { response_code, response_message, response_data };
    }

    // QUIT: End of the connection
    async quit() {
        const { response_code, response_message, response_data } = await this.#command("QUIT");

        await this.close();

        if(response_code !== 221) {
            throw {cmd: "QUIT", msg: response_code + ' ' + response_message};
        }
    }

    #onWsOpen = async () => {
        this.connected = true;
        //this.onopen?.();
    }

    #onWsClose = async () => {
        this.connected = false;
        this.#clear();
        this._onclose?.();
        this.onclose?.();
    }

    #onWsError = e => {
        this._onerror?.(e);
        this.onerror?.(e);
    }

    #onWsMessage = async ({ data }) => {
        data = new Uint8Array(data);

        const decoded = this.decoder.decode(data);
        log('smtp_in', decoded.toString(), DEBUG);

        this.responseQueue = this.responseQueue.then(async () => {
            const newBuffer = new Uint8Array(this.responseBuffer.byteLength + data.byteLength);
            newBuffer.set(this.responseBuffer,0);
            newBuffer.set(data,this.responseBuffer.byteLength);

            this.responseBuffer = newBuffer;

            await this._onmessage?.();
            await this.onmessage?.();
        });

        await this.responseQueue;
    }

    async #handleCommandResponse(responseCallback) {
        const decoded = this.decoder.decode(this.responseBuffer);

        // Only deal with complete lines
        if(decoded.slice(-2) !== "\r\n") return;

        // Only deal with completed commands
        const command_regexp = /^(\d{3}) (.*)/m
        const command_match = decoded.match(command_regexp);
        if(!command_match) return;

        this.responseBuffer = this.responseBuffer.slice(command_match.index + command_match[0].length);

        const [ response_code, response_message ] = [ parseInt(command_match[1]), command_match[2] ];

        const data_regexp = new RegExp('^' + response_code + '-(.*)\r\n','gm');
        const response_data = [ ...decoded.matchAll(data_regexp)].map((a) => a[1]);

        await responseCallback({ response_code, response_message, response_data });
    }

    #clear() {
        this.commandState = null;
        this.commandQueue = Promise.resolve();
        this.responseQueue = Promise.resolve();
        this.clearBuffer();
    }

    clearBuffer() {
        this.responseBuffer = new Uint8Array();
    }

    close() {
        this.ws.close();
    }
}

//-----------------------------------Settings---------------------------------
