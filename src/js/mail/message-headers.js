class MessageHeaders {
    constructor(headers) {
        this.clear();

        if(typeof headers === 'string') headers = headers.split('\r\n');

        if(Array.isArray(headers)) {
            this.load(headers);
        } else if(typeof headers === 'object') {
            for(const name of Object.keys(headers)) {
                this.set(name,headers[name]);
            }
        }
    }

    clear() {
        this.headers = {};
        this.headerKeys = {};
    }

    // how many UNIQUE header names have been added
    get length() {
        return Object.keys(this.headerKeys).length;
    }

    // Expects an array of lines
    load(headers_in) {
        var lastHeader;
        for(const i in headers_in) {
            const header = headers_in[i];
            if(header == "") continue;

            const continuation = header.match(/^[\s\)]+/)
            if(continuation) {
                this.append(lastHeader,header.replace(/^\s+/,' '));
                continue;
            }

            const colon_match = header.match(/(.+?):\s?(.*)/);
            if(colon_match) {
                const header_name = colon_match[1].toLowerCase();
                const header_value = colon_match[2]
                this.add(header_name,header_value);
                lastHeader = header_name;
                continue;
            }
        }
    }

    get(name,method='all',join=',') {
        const ikey = name.toLowerCase();
        const keys = this.headerKeys[ikey];

        if(!keys) return false;

        const values = [];

        for(const key of keys) {
            if(method === 'one') return this.headers[key]?.[0];
            values.push(...this.headers[key]);
        }

        if(method === 'join') return values.join(join);
        else return values;
    }

    add(name,value) {
        const ikey = name.toLowerCase();

        if(this.headerKeys[ikey]) {
            if(!this.headerKeys[ikey].includes(name)) {
                this.headerKeys[ikey].push(name);
            }
        } else {
            this.headerKeys[ikey] = [name];
        }

        const existing = this.headers[name];

        if(existing)
            this.headers[name].push(value);
        else
            this.headers[name] = [value];
    }

    set(name,value) {
        this.delete(name);

        const ikey = name.toLowerCase();

        this.headerKeys[ikey] = [name];
        this.headers[name] = Array.isArray(value) ? value : [value];
    }

    append(name,value) {
        if(name in this.headers && this.headers[name].length) {
            this.headers[name][this.headers[name].length-1] += value;
            return;
        }

        const ikey = name.toLowerCase();
        if(ikey in this.headerKeys) {
            const key = this.headerKeys[ikey].slice(-1);
            this.headers[key][this.headers[key].length-1] += value;
            return;
        }

        return this.add(name,value);
    }

    delete(name) {
        const ikey = name.toLowerCase();
        for(const key of (this.headerKeys[ikey]||[])) delete this.headers[key];
        delete this.headerKeys[ikey];
    }
}

//-------------------------------------SMTP-----------------------------------
