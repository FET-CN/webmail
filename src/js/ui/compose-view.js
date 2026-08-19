class _ComposeView extends View {
    constructor(message = new Message(),allowsignature=true) {
        super('compose');

        message.headers.set('MIME-Version','1.0');
        message.mime = true;
        this.message = message;
        const account = window.AccountView?.currentAccount;
        this.senders = [account?.address, account?.internalAddress].filter(Boolean);
        this.from = this.senders[0] || window.AccountView?.imap.username;
        this.rcpts = [];
        this.bodypos = 0;
        this.allowsignature = true;

        this.el.querySelectorAll('.send').forEach(e => e.addEventListener('click', async () => await this.onClickSend.call(this)));
        this.el.querySelectorAll('.cancel').forEach(e => e.addEventListener('click', async () => await this.onClickCancel.call(this)));

        this.el.addEventListener('keyup', (async (e) => await this.onKeyUp.call(this,e)));
        this.el.querySelectorAll('input, select').forEach(e => e.addEventListener('blur', (async () => await this.setMessageFields.call(this))));
        this.el.querySelectorAll('textarea').forEach(e => e.addEventListener('blur', (async () => await this.setMessageFields.call(this))));

        this.el.querySelectorAll('input[name=to]').forEach(e => e.addEventListener('blur', (async () => await this.drawRCPTs.call(this))));
        this.el.querySelectorAll('input[name=cc]').forEach(e => e.addEventListener('blur', (async () => await this.drawRCPTs.call(this))));
        this.el.querySelectorAll('input[name=bcc]').forEach(e => e.addEventListener('blur', (async () => await this.drawRCPTs.call(this))));

        this.el.querySelectorAll('input[type=file]').forEach(e => e.addEventListener('change', async (e) => await this.importAttachments.call(this,e.target)));
        this.el.querySelectorAll('.add-attachments').forEach(e => e.addEventListener('click', e => this.el.querySelector('input[type=file]').click()));
    }

    async open() {
        await super.open();
        await window.MessageView?.hide();
        this.el.style.display="inline-block";

        this.el.querySelector('textarea').focus();
        this.el.querySelector('textarea').selectionEnd = this.bodypos;
        if(!(this.message.isreply === true) || window.AccountSettings.replyAt === "top")
            this.el.querySelector('textarea').scrollTop = 0;
    }

    async close() {
        super.close();
        window.MessageView?.show();
    }

    async draw() {
        this.el.querySelectorAll('select[name=from]').forEach(e => {
            if(e.options.length === 0) {
                for(const sender of this.senders) {
                    const option = document.createElement('option');
                    option.value = sender;
                    option.innerText = sender;
                    e.appendChild(option);
                }
            }
            e.value = this.from || '';
        });
        this.el.querySelectorAll('input[name=to]').forEach(e => {e.value = this.message.headers.get('to','join') || ''});
        this.el.querySelectorAll('input[name=cc]').forEach(e => {e.value = this.message.headers.get('cc','join') || ''});
        this.el.querySelectorAll('input[name=bcc]').forEach(e => {e.value = this.message.headers.get('bcc','join') || ''});
        this.el.querySelectorAll('input[name=subject]').forEach(e => {e.value = this.message.headers.get('subject','one') || ''});
        this.el.querySelectorAll('textarea[name=body]').forEach(e => {
            if(this.allowsignature && this.message.isreply === true && window.AccountSettings.replyAt === "bottom") {
                if(window.AccountSettings.signature && window.AccountSettings.replySignature === true) {
                    e.value = (this.message.body ? (this.message.body + '\r\n') : '') + '\r\n\r\n' + window.AccountSettings.signature;
                } else {
                    e.value = (this.message.body ? (this.message.body + '\r\n\r\n') : '');
                }
                this.bodypos = this.message.body.replace(/[\r]/g,'').length + 2;
            } else {
                if(this.allowsignature && window.AccountSettings.signature)
                    e.value = '\r\n' + window.AccountSettings.signature + (this.message.body ? ('\r\n\r\n' + this.message.body) : '');
                else {
                    if(this.allowsignature)
                        e.value = this.message.body ? ('\r\n\r\n' + this.message.body) : '';
                    else
                        e.value = this.message.body;
                }
            }
        });

        await this.drawRCPTs();

        await this.drawAttachments();
    }

    async enableMultipart() {
        this.message.content_type = 'multipart';
        this.message.content_subtype = 'mixed';
    }

    async disableMultipart() {
        this.message.content_type = 'text';
        this.message.content_subtype = 'plain';
    }

    async importAttachments(e) {
        if(e.files.length)
            await this.enableMultipart();
        for(const file of e.files) {
            this.message.attachments.push({
                filename: file.name,
                content_type: file.type.split('/')[0],
                content_subtype: file.type.split('/')[1],
                blob: file
            });
        }

        await this.drawAttachments();
    }

    async drawAttachments() {
        this.el.querySelectorAll('.attachments .attachment').forEach(e => e.remove());
        this.el.querySelectorAll('.attachments').forEach(e => {
            for(const attachment_i in this.message.attachments) {
                const attachment = this.message.attachments[attachment_i];
                const entry = template('compose-attachment');
                entry.querySelectorAll('.filename').forEach(e => {e.innerText = attachment.filename});
                entry.querySelectorAll('.type').forEach(e => {e.innerText = attachment.content_type + '/' + attachment.content_subtype});
                entry.querySelectorAll('.size').forEach(e => {e.innerText = decodeSize(attachment.blob.size)});
                entry.querySelectorAll('.delete').forEach(e => e.addEventListener('click',e => (async (e,i) => {
                    this.message.attachments.splice(i,1);
                    e.remove();
                    if(!this.message.attachments.length)
                        await this.disableMultipart();
                }).call(this,entry,attachment_i)));
                e.appendChild(entry);
            }
        });
    }

    async setMessageFields() {
        this.from = this.el.querySelector('select[name=from]').value;
        const displayFrom = window.AccountSettings.name
            ? window.AccountSettings.name + ' <' + this.from + '>'
            : this.from;
        this.message.headers.set('From',displayFrom);
        this.message.headers.set('To',this.el.querySelector('input[name=to]').value);
        this.message.headers.set('CC',this.el.querySelector('input[name=cc]').value);
        this.message.headers.set('BCC',this.el.querySelector('input[name=bcc]').value);
        this.message.headers.set('Subject',this.el.querySelector('input[name=subject]').value);
        this.message.body = this.el.querySelector('textarea[name=body]').value;

        if(!this.message.headers.get('cc','one')) this.message.headers.delete('cc');
        if(!this.message.headers.get('bcc','one')) this.message.headers.delete('bcc');
    }

    async drawRCPTs() {
        await this.setMessageFields();
        this.rcpts = await this.message.extractRCPTs();
        this.el.querySelector('.rcptcount').innerText = this.rcpts.length;
        this.el.querySelector('.rcptlist').innerText = this.rcpts.join(', ');
    }

    async drawResponse(r,type='load') {
        const rel = this.el.querySelector('.response');
        rel.setAttribute('class','response ' + type);

        var rmsg = 'unknown';

        if(typeof r === "object") {
            if(r instanceof Error) {
                rmsg = `Javascript error: ${r}`;
            } else {
                if(type === 'err') {
                    rmsg = `Error during command:\r\n${r.cmd} ${r.arg || ''}\r\nServer said:\r\n${r.msg}`;
                } else {
                    rmsg = `Server said:\r\n${r.msg}`;
                }
            }
        } else {
            rmsg = r;
        }

        rel.innerText = rmsg;
        rel.style.display = 'block';
    }

    async onKeyUp(e) {
        if(e.key === "Enter" && e.ctrlKey) {
            await this.onClickSend();
            return false;
        }
    }

    async onClickSend() {
        await this.drawRCPTs();
        if(!confirm(`Send this message to ${this.rcpts.length} recipient${this.rcpts.length === 1 ? '' : 's'}?`)) return;

        await this.setMessageFields();

        await this.drawResponse('Sending message...');
        try {
            await this.message.compile(true);
            const response = await apiFetch('/v1/messages/send', {
                method: 'POST',
                headers: {'content-type': 'application/json'},
                body: JSON.stringify({
                    from: this.from,
                    recipients: this.rcpts,
                    raw: encodeBase64(this.message.message)
                })
            });
            if(!response.ok) throw await response.json();
        } catch(e) {
            await this.drawResponse(e,'err');
            return;
        }

        await this.drawResponse("Message sent!","success");

        window.setTimeout(() => this.close(),1000);
    }

    async onClickCancel() {
        if(!confirm("Discard this message?")) return;
        await this.close();
    }
}
