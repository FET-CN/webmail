class Message {
    constructor(message_object={}) {
        this.uid = null; // IMAP uid of the message
        this.modseq = 0; // MODSEQ for the message
        this.flags = []; // IMAP flags
        this.headers = new MessageHeaders();
        this.blobURLs = [];

        this.clear();

        for(const key of Object.keys(message_object)) {
            if(key === 'headers') {
                this.headers = new MessageHeaders(message_object[key]);
            } else {
                this[key] = message_object[key];
            }
        }
    }

    clear() {
        this.full = false; // Whether message contains `message` object or just headers/flags
        this.loaded = false; // Message has been fully parsed
        this.needsFetch = false; // MODSEQ increased but FLAGS were not given
        this.message = null; // Raw array of lines comprising an RFC822 message
        this.body = null; // The content of the message
        this.raw_headers = null; // An array containing raw header lines
        this.blob = null; // Once the complete message is loaded this Blob exists
        this.mime = false;
        this.content_type = null;    // (content_type)/ content_subtype
        this.content_subtype = null; //  content_type /(content_subtype)
        this.multipart_boundary = null;
        this.inline = []; // Objects to be displayed inline
        this.attachments = []; // Objects to be shown as attachments
    }

    // ------------------Loaders-----------------

    // Loads a partial or complete RFC822 message and optionally parses MIME
    async loadMessage(message=this.message,loadMime=true) {
        if(message === null)
            throw "there's no message to load!";

        if(typeof message === "string") {
            this.blob = new Blob([message], {type: 'message/rfc822'});
            message = message.split("\r\n");
        } else {
            this.blob = new Blob([message.join("\r\n")], {type: 'message/rfc822'});
        }

        this.message = message;

        [ this.headers, this.body, this.raw_headers ] = await this.splitHeaders(message);

        if(this.body && loadMime) await this.handleMIMEMessage();

        // By default the body is a single inline object
        if( (!this.mime) || (this.inline.length === 0 && this.attachments.length === 0) )
            this.inline = [ {body: this.body} ];

        this.loaded = true;
    }

    // Apply a FETCH object into the message, flagging for update if necessary
    async update(fetch) {
        var changed = false;

        for(const key of Object.keys(fetch)) {
            if(this[key] != fetch[key]) {
                changed = true;
                this[key] = fetch[key];
            }
        }

        if('modseq' in fetch && !('flags' in fetch)) {
            this.needsFetch = true;
        }

        return changed;
    }

    async close() {
        while(this.blobURLs.length > 0) {
            const blob_url = this.blobURLs.pop();
            URL.revokeObjectURL(blob_url);
        }

        this.clear();
    }

    // -------------------MIME-------------------

    // MIME Message
    // Decodes a raw message and turns it into a MIME message
    async handleMIMEMessage(ret=this) {
        if(typeof ret === "string" || Array.isArray(ret))
            ret = { message: ret }
        if((ret.headers === undefined || ret.body === undefined || ret.raw_headers === undefined)
            || !(typeof ret.headers === 'object' && Object.keys(ret.headers).length)
            || !(typeof Array.isArray(ret.raw_headers) && ret.raw_headers.length))
            [ ret.headers, ret.body, ret.raw_headers ] = await this.splitHeaders(ret.message);

        try {
            ret.inline = [];
            ret.attachments = [];

            // MIME-Version
            ret.mime_version = await this.loadMIMEvalue(ret.headers,'MIME-Version') || "";
            if(ret.mime_version.startsWith('1.')) // hey you never know
                ret.mime = true;
            else
                return false;

            const mime_objects = await this.handleMIMEBodyPart(ret);

            if(mime_objects.length > 1) {
                for(const object of mime_objects) {
                    if(object.content_disposition === "inline" || (object.content_disposition === null && object.content_type === 'text')) {
                        ret.inline.push(object)
                    } else {
                        ret.attachments.push(object);
                    }
                }
            } else if(mime_objects.length === 1) {
                for(const key of Object.keys(mime_objects[0])) {
                    ret[key] = mime_objects[0][key];
                }
                ret.inline = [ mime_objects[0] ];
            }
        } catch (e) {
            log('imap_message','Error loading message, probably MIME related',WARN,[e,ret]);
            this.mime = false;
        }

        return ret;
    }

    // MIME Body Part
    // Takes a body_part object and parses MIME headers in it
    async handleMIMEBodyPart(body_part) {
        if(typeof body_part === "string" || Array.isArray(body_part))
            body_part = { message: body_part }
        if(!('headers' in body_part))
            [ body_part.headers, body_part.body, body_part.raw_headers ] = await this.splitHeaders(body_part.message);

        // Content-Type read
        [ body_part.content_type, body_part.content_subtype ] = await this.loadMIMEContentType(await this.loadMIMEvalue(body_part.headers,'Content-Type'));

        // Content-Disposition
        body_part.content_disposition = await this.loadMIMEvalue(body_part.headers, 'content-disposition');

        if(body_part.content_disposition) {
            body_part.filename = await this.loadMIMEParameter(body_part,'content-disposition','filename');
            body_part.creation_date = await this.loadMIMEParameter(body_part,'content-disposition','creation_date');
            body_part.modification_date = await this.loadMIMEParameter(body_part,'content-disposition','modification_date');
            body_part.read_date = await this.loadMIMEParameter(body_part,'content-disposition','read_date');
        }

        // Content-Transfer-Encoding
        body_part.content_transfer_encoding = await this.loadMIMEvalue(body_part.headers,'Content-Transfer-Encoding');

        if(body_part.content_transfer_encoding)
            await this.MIMEContentTransferDecode(body_part);

        // Content-Type logic
        const mime_objects = await this.handleContentType(body_part);

        return mime_objects;
    }

    // Content-Transfer-Encoding
    async MIMEContentTransferDecode(ret) {
        switch(ret.content_transfer_encoding) {
            case "base64":
                ret.body = decodeBase64(ret.body);
                break;
            case "7bit":
            case "8bit":
                break;
            case "quoted-printable":
                ret.body = decodeQuotedPrintable(ret.body,false);
                break;
            case null:
                break;
            default:
                log("imap_message","Unsupported MIME Content-Transfer-Encoding, defaulting to application/octet-stream", DEBUG, ret);
                ret.content_type = "application";
                ret.content_subtype = "octet-stream";
                break;
        }

        return ret;
    }

    // Content-Type
    // Returns an array of parsed MIME objects
    async handleContentType(ret) {
        const objects = [];
        switch(ret.content_type) {
            case "multipart":
                log('imap_message','handleContentType: multipart',DEBUG);

                const multiparts = [];
                const lines = ret.body.split("\r\n");

                ret.multipart_boundary = await this.loadMIMEParameter(ret,'content-type','boundary');

                if(!ret.multipart_boundary) {
                    ret.attachments.push({
                        type: 'binary',
                        error: 'No MIME multipart/mixed boundary found',
                        content: ret.body
                    });
                    break;
                }

                const regexp = new RegExp('^--' + ret.multipart_boundary + '(?:--)?\s*$');

                var first_walker = lines.findIndex(l => regexp.test(l));
                var next_walker = lines.slice(first_walker+1).findIndex(l => regexp.test(l));
                var walker = 0;

                while(next_walker !== -1) {
                    walker = first_walker + next_walker + 1;

                    const sliced_body = lines.slice(first_walker+1,walker);

                    multiparts.push(sliced_body);

                    first_walker = walker;
                    const new_slice = lines.slice(first_walker+1);
                    next_walker = new_slice.findIndex(l => regexp.test(l));
                }

                for(const multipart of multiparts) {
                    switch(ret.content_subtype) {
                        // holy smokes
                        case "alternative":
                        case "related":
                        case "encrypted":
                        case "signed":
                        case "digest":
                        case "mixed":
                        default:
                            const parsed_mime = await this.handleMIMEBodyPart(multipart);

                            for(const object of parsed_mime) objects.push(object);
                            break;
                    }
                }
                break;

            case "text":
                log('imap_message','handleContentType: text',DEBUG);
                ret.charset = await this.loadMIMEParameter(ret,'content-type','charset') || "UTF-8"; // close enough
                if(ret.charset !== null && ret.body instanceof Uint8Array) {
                    const decoder = new TextDecoder(ret.charset);
                    ret.body = decoder.decode(ret.body);
                }
                switch(ret.content_subtype) {
                    case "html":
                        const domparser = new DOMParser();
                        ret.raw_html = ret.body;
                        ret.html = domparser.parseFromString(ret.body,'text/html');
                        ret.html.querySelectorAll('style').forEach((a) => a.remove());
                        ret.links = {};
                        const all_links = ret.html.querySelectorAll('a');
                        for(const i in all_links) {
                            const a = all_links[i];
                            if(a.href) {
                                a.innerText += "[" + i + "]";
                                ret.links[i] = a.href;
                            }
                        }

                        ret.body = ret.html.documentElement.innerText.replace(/^\s*$/gm,'');
                        objects.push(ret);
                        break;
                    case "plain":
                    default:
                        objects.push(ret);
                        break;
                }
                break;

            case "message":
                log('imap_message','handleContentType: message',DEBUG);
                ret.charset = await this.loadMIMEParameter(ret,'content-type','charset') || "UTF-8"; // close enough
                if(ret.charset !== null && ret.body instanceof Uint8Array) {
                    const decoder = new TextDecoder(ret.charset);
                    ret.body = decoder.decode(ret.body);
                }
                const message = new Message();
                await message.loadMessage(ret.body);
                await this.handleMIMEMessage(message);
                ret.message = message
                objects.push(ret);
                break;
            case "image":
            case "video":
            case "application":
            default:
                log('imap_message','handleContentType: default',DEBUG);
                objects.push(ret);
                break;
        }

        return objects;
    }

    async loadMIMEContentType(string) {
        if(!string)
            return [ "text", "plain" ];
        const match = string.match(/([\w\-]*)\/([\w\-\+]*) ?.*/);

        if(match)
            return [ match[1], match[2] ];
        else
            return [ string, null ];
    }

    async loadMIMEvalue(headers=this.headers,header_name) {
        if(!headers)
            return null;
        const header_value = headers.get(header_name,'one');
        if(header_value) {
            const match = header_value.match(/^(".*?"|[^;\s]*)/);
            if(match)
                return match[1].toLowerCase().replace(/^"/,'').replace(/"$/,'');
        }
        return null;
    }

    async loadMIMEParameter(ret=this,header,parameter,allowCharset=false) {
        if(!header) {
            return null;
        }
        if(!(header.toLowerCase() in ret.headers.headerKeys)) {
            return null;
        }

        header = ret.headers.get(header,'one');
        var vbytes = [];

        const r_full = new RegExp(';\\s*' + parameter + '(?:\\*([\\d]+))?(\\*?)=(".*?"|[^;\\s]+)');
        const r_encoded_value = new RegExp(/(?:([\w\-]*)\')?(?:([\w\-]*)\')?(.*)/);
        const rg = new RegExp(r_full,'g');

        var encoding = null;
        var lang = null; // who uses this shit
        var decoder = new TextDecoder('utf-8');
        var encoder = new TextEncoder('utf-8');

        const match_all = header.match(rg);

        if(match_all) {
            const values = {};
            for(const match_full of match_all) {
                const [ _, seq, uses_encoding, this_value ]  = match_full.match(r_full);
                values[parseInt(seq)] = {
                    uses_encoding: uses_encoding === "*",
                    value: this_value.replace(/^"/,'').replace(/"$/,'')
                };
                if(!seq) break;
            }
            for(const key of Object.keys(values)) { // it's crazy this sorts numbers
                const this_value = values[key];

                if(this_value.uses_encoding && this_value.value) {
                    const bytes = [];

                    if(!encoding) {
                        const encoded_match = this_value.value.match(r_encoded_value);
                        var _, this_encoding, this_lang, this_encoded_value;

                        if(encoded_match) {
                            [_, this_encoding, this_lang, this_encoded_value ] = encoded_match;
                            encoding = this_encoding ? this_encoding : 'UTF-8';
                            lang = this_lang ? this_lang : 'EN';
                            this_value.value = this_encoded_value;
                        } else {
                            encoding = 'UTF-8';
                            lang = 'EN';
                        }

                        decoder = new TextDecoder(encoding);
                    }

                    var i=0;
                    while(i < this_value.value.length) {
                        if(
                            this_value.value[i] === "%" &&
                            i + 2 < this_value.value.length &&
                            this_value.value[i+1].match(/[0-9A-F]/) &&
                            this_value.value[i+2].match(/[0-9A-F]/)
                        ) {
                            const hex = this_value.value.slice(i+1, i+3);
                            bytes.push(parseInt(hex, 16));
                            i += 2;
                        } else {
                            bytes.push(this_value.value.charCodeAt(i));
                        }
                        i++;
                    }

                    vbytes = [ ...vbytes, ...bytes ];
                } else {
                    vbytes = [ ...vbytes, ...encoder.encode(values[key].value) ];
                }

            }

            return decoder.decode(new Uint8Array(vbytes));
        } else {
            return null;
        }
    }

    // ------------------Parsers-----------------

    // Expects an array of lines
    // Returns [ MessageHeaders headers, string body ]
    async splitHeaders(content) {
        const splicepoint = content.indexOf("");
        if(splicepoint === -1)
            return [ {}, content.join("\r\n"), {} ];
        return [
            new MessageHeaders(content.slice(0,splicepoint+1)),
            content.slice(splicepoint+1).join("\r\n"),
            content.slice(0,splicepoint+1)
        ];
    }

    // -----------------Compilers----------------

    async extractRCPTs(rcptarray) {
        if(!rcptarray)
            rcptarray = ['to','cc','bcc'].map(a => this.headers.get(a,'join'));
        const rcpts = new Set(
            (await extractAddresses(rcptarray)).map(a => a[1])
            );

        // keeping this because it's cool
        //rcptarray.filter(Boolean)
        //    .forEach((a) => a
        //        // capital letters are scary
        //        .toLowerCase()
        //        // Remove quoted strings
        //        .replace(/"(?:[^\\"]|\\.)*"/g,'')
        //        // Remove comments
        //        .replace(/\((?:[^\\\(\)]|\\.)*\)/g,'')
        //        // Remove spaces
        //        .replace(/\s/g,'')
        //        // Remove list names
        //        .replace(/[^:;,]*:(.*?);/,'$1,')
        //        // Remove escaped commas
        //        .replace(/\\,/g,'')
        //        // Split into mailbox addresses
        //        .split(',')
        //        // Unbracket e-mail addresses
        //        .map((b) => b.replace(/.*<(.*?)>.*/,'$1'))
        //        // Remove invalid addresses (fight me)
        //        .filter((b) => b.match('@'))
        //        // Add the addresses
        //        .forEach((b) => rcpts.add(b))
        //    );

        return [ ...rcpts ];
    }

    async compileHeaders(headers=this.headers) {
        const out = [];
        for(const key of Object.keys(headers.headers)) {
            for(const value of headers.headers[key]) {
                out.push(key + ': ' + this.compileHeaderValue(value));
            }
        }

        return out
            .map(h => foldHeader(h))
            .join('\r\n');
    }

    compileHeaderValue(string) {
        const contains_uchar = string.matchAll(/\w*[^\u0000-\u00ff]+\w*/g)
        if(contains_uchar) {
            for(const match of contains_uchar) {
                string = string.replace(match,encodeMIMEWords(match[0]))
            }
        }

        return string;
    }

    compileFilename(string) {
        var hex = hex_encode(string,'%');
        var r = [];
        var i=0;
        while(true) {
            const l = (i === 0) ? 54 : 63;
            const match = hex.match(new RegExp('(.{1,'+l.toString()+'})'));
            if(match) {
                var s = ''
                s += "filename*"+i.toString()+"*=";
                if(i === 0)
                    s += "UTF-8''"
                s += match[0].toUpperCase() + ';';
                r.push(s);
                hex = hex.slice(match[0].length);
                i++;
            } else {
                break;
            }
        }
        return r.join(' ');
    }

    // calculate `message`: do the opposite of loadMessage
    async compile(smtp=true) {
        this.inline = [ {body: this.body} ];

        var message = '';

        for(const inline of this.inline) {
            if(!inline.headers) inline.headers = new MessageHeaders();
            inline.headers.set('Content-Type','text/plain; charset=UTF-8;');
            inline.headers.set('Content-Transfer-Encoding','8bit');

            if(inline.body.split("\r\n").filter((a) => a.length > 998).length) {
                inline.headers.set('Content-Transfer-Encoding','base64');
                inline.body = wrap(encodeBase64(inline.body));
            }
        }

        for(const attachment of this.attachments) {
            if(!attachment.headers) attachment.headers = new MessageHeaders();
            attachment.headers.set('Content-Transfer-Encoding','base64');
            attachment.headers.set('Content-Disposition','attachment;');
            if(attachment.filename) {
                attachment.headers.append('Content-Disposition', ' ' + this.compileFilename(attachment.filename));
            }
            if(attachment.content_type) {
                attachment.headers.set('Content-Type',attachment.content_type + '/' + attachment.content_subtype);
            } else {
                attachment.headers.set('Content-Type','application/octet-stream');
            }
        }

        if(this.content_type === "multipart" && this.content_subtype === "mixed") {
            while(true) {
                this.multipart_boundary = '------------' + randomHex(12);
                for(const inline of this.inline) {
                    if(inline.body.match(new RegExp('^.?.?'+this.multipart_boundary)))
                        continue;
                }
                break;
            }

            this.headers.set('Content-Type','multipart/mixed; boundary="'+this.multipart_boundary+'"');

            message = await this.compileHeaders(this.headers);
            message += '\r\n\r\n';
            message += "This is a multi-part message in MIME format.\r\n";

            for(const inline of this.inline) {
                message += '\r\n--' + this.multipart_boundary + '\r\n';
                message += await this.compileHeaders(inline.headers);
                message += '\r\n\r\n';
                message += inline.body.replace(/([^\r])\n/gm,'$1\r\n');
                message += '\r\n';
            }

            const decoder = new TextDecoder('utf-8');

            for(const attachment of this.attachments) {
                message += '\r\n--' + this.multipart_boundary + '\r\n';
                message += await this.compileHeaders(attachment.headers);
                message += '\r\n\r\n';
                const bytes = await attachment.blob.bytes();
                var bytestring = '';
                for(var i=0; i<bytes.length; i+=32768) {
                    bytestring += String.fromCharCode.apply(null,bytes.subarray(i,i+32768));
                }
                message += wrap(btoa(bytestring));
                message += '\r\n';
            }

            message += '\r\n--' + this.multipart_boundary + '--';
        } else {
            for(const header of Object.keys(this.inline[0].headers.headers)) {
                this.headers.set(header,this.inline[0].headers.get(header,'one'));
            }
            message = await this.compileHeaders(this.headers)
                + '\r\n\r\n'
                + this.inline[0].body;
        }

        if(smtp)
            message = message.replace(/^\.$/gm,'..');


        this.message = message;

        this.blob = new Blob([this.message], {type: 'message/rfc822'});

        return this.message;
    }

    // Return a compact message object for storage
    async slim(full) {
        const message = {};

        const fields = full
            ? ['uid','message']
            : ['uid','modseq','flags','headers'];
        
        for(const key of fields) {
            if(key === 'headers') message.headers = this.headers.headers;
            else message[key] = this[key];
        }

        return message;
    }

    // -----------------Responses----------------

    async reply(method='one') {
        // method: one all list
        const reply_to = this.headers.get('reply-to','one') || this.headers.get('from','one');

        var subject = decodeMIMEWords(this.headers.get('subject','one'), false) || "(no subject)";
        if(!subject.match(/^re:/i))
            subject = "Re: " + subject;

        const reply = new Message({
            isreply: true,
            headers: {
                to: decodeMIMEWords(reply_to,false),
                subject: subject
            },
            body: `On ${this.headers.get('date','one')}, ${decodeMIMEWords(this.headers.get('from','one'), false)} wrote:\r\n`
        });

        if(this.inline.length) reply.body += this.inline[0].body.split("\n").map((a) => '> ' + a).join("\n");
        else reply.body += this.body.split("\n").map((a) => '> ' + a).join("\n")

        if(method === "list") {
            const listaddr = await this.isList();
            if(listaddr) reply.headers.set('to',decodeMIMEWords(listaddr,false));
            else method = "all";
        }

        if(method === "all") {
            reply.headers.set('to', [ reply_to, this.headers.get('to','join') ]
                .filter(Boolean)
                .map((a) => decodeMIMEWords(a,false))
                );
            reply.headers.set('to', reply.headers.get('to')
                .filter((a,p) => {
                    return reply.headers.get('to').findIndex(b => {
                        return b.match(new RegExp('(?:^'+escapeRegex(a)+'$|<'+escapeRegex(a)+'>)'))
                    }) === p
                })
                .join(',')
                );
            reply.headers.set('cc',decodeMIMEWords(this.headers.cc,false));
        }

        if(this.headers.get('message-id')) {
            reply.headers.set('In-Reply-To', this.headers.get('message-id','one'));
            reply.headers.set('References', this.headers.get('references')
                ? this.headers.get('references') + ' ' + this.headers.get('message-id')
                : this.headers.get('message-id')
                );
        }

        return reply;
    }

    async forward() {
        const reply = new Message({
            headers: {
                subject: 'Fwd: ' + (decodeMIMEWords(this.headers.get('subject','one'),false) || "(no subject)"),
            },
            body: ""
        });

        reply.body += `----- Forwarded message from ${decodeMIMEWords(this.headers.get('from','one'),false) || "(blank)"} -----\r\n`;
        reply.body += `Date: ${decodeMIMEWords(this.headers.get('date','one'),false) || "(blank)"}\r\n`;
        reply.body += `From: ${decodeMIMEWords(this.headers.get('from','one'),false) || "(blank)"}\r\n`;
        reply.body += `To: ${decodeMIMEWords(this.headers.get('to','join'),false) || "(blank)"}\r\n`;
        if(this.headers.get('cc'))
            reply.body += `CC: ${decodeMIMEWords(this.headers.get('cc','join'),false)}\r\n`
        reply.body += `Subject: ${decodeMIMEWords(this.headers.get('subject','one'),false) || "(no subject)"}\r\n`;
        reply.body += "\r\n";
        if(this.inline.length) reply.body += this.inline[0].body;
        else reply.body += this.body;
        reply.body += "\r\n";
        reply.body += `----- End forwarded message -----\r\n`;

        return reply;
    }

    // ------------------Helpers-----------------

    async addFlags(flags) {
        if(typeof flags === 'string') flags = [flags];

        var changed = false;
        for(const flag of flags) {
            if(!this.flags.includes(flag)) {
                this.flags.push(flag);
                changed = true;
            }
        }

        return changed;
    }

    async removeFlags(flags) {
        if(typeof flags === 'string') flags = [flags];

        var changed = false;
        for(const flag of flags) {
            const flagIndex = this.flags.indexOf(flag);
            if(flagIndex !== -1) {
                this.flags.splice(flagIndex,1);
                changed = true;
            }
        }

        return changed;
    }

    async isList() {
        if(this.headers.get('list-post')) {
            const post_match = this.headers.get('list-post','join').match(/<mailto:(.*?)>/);
            return post_match[1] || false;
        } else return false;
    }
}

//---------------------------------MessageHeaders-----------------------------
