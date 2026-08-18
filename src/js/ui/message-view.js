class _MessageView extends View {
    constructor(message, mailbox,mailboxView) {
        super('message');
        this.el.scrollTop = 0;

        this.message = message;
        this.mailbox = mailbox;
        this.mailboxView = mailboxView;

        this.el.querySelectorAll('.reply').forEach(e => e.addEventListener('click', this.onClickReply.bind(this)));
        this.el.querySelectorAll('.replyall').forEach(e => e.addEventListener('click', this.onClickReplyAll.bind(this)));
        this.el.querySelectorAll('.replylist').forEach(e => e.addEventListener('click', this.onClickReplyList.bind(this)));
        this.el.querySelectorAll('.forward').forEach(e => e.addEventListener('click', this.onClickForward.bind(this)));

        this.el.querySelectorAll('.mailbox-list option:not(.title)').forEach(e => e.remove());
        this.el.querySelectorAll('.mark').forEach(e => e.onchange = e => {
            if(this.mailbox.mailbox !== this.mailbox.imap.selected.mailbox) {
                const selected = e.target.options[e.target.selectedIndex];
                e.target.value=0;
                alert(`Mailbox ${this.mailbox.mailbox} is not currently open, so I can't do that.`);
                return;
            }
            this.mailboxView.onClickMark(message.uid,e);
        });
        this.el.querySelectorAll('.copy').forEach(e => {
            this.mailboxView.drawMailboxSelect(e,window.AccountView.imap.getRootMailboxes());
            e.onchange = e => {
                if(this.mailbox.mailbox !== this.mailbox.imap.selected.mailbox) {
                    const selected = e.target.options[e.target.selectedIndex];
                    e.target.value=0;
                    alert(`Mailbox ${this.mailbox.mailbox} is not currently open, so I can't do that.`);
                    return;
                }
                this.mailboxView.onClickCopy(message.uid,e);
            }
        });
        this.el.querySelectorAll('.move').forEach(e => {
            this.mailboxView.drawMailboxSelect(e,window.AccountView.imap.getRootMailboxes());
            e.onchange = e => {
                if(this.mailbox.mailbox !== this.mailbox.imap.selected.mailbox) {
                    const selected = e.target.options[e.target.selectedIndex];
                    e.target.value=0;
                    alert(`Mailbox ${this.mailbox.mailbox} is not currently open, so I can't do that.`);
                    return;
                }
                this.mailboxView.onClickMove(message.uid,e);
            }
        });

        this.el.querySelectorAll('.more').forEach(e => {
            e.onchange = e => {
                const action = e.target.value;
                e.target.value=0;
                switch(action) {
                    case "toggleheaders":
                        this.toggleHeaders();
                        break;
                    case "viewsource":
                        this.viewSource();
                        break;
                    case "download":
                        this.download();
                        break;
                }
            }
        });

        this.addEventListener('message-deleted', e => {
            if(e.detail.uids.includes(this.message.uid)) {
                this.delete('(' + e.detail.action + ')');
            }
        });

        this.addEventListener('mailboxes-changed', e => {
            this.el.querySelectorAll('.mailbox-list option:not(.title)').forEach(e => e.remove());
            this.el.querySelectorAll('.copy').forEach(e => {
                this.mailboxView.drawMailboxSelect(e,window.AccountView.imap.getRootMailboxes());
            });
            this.el.querySelectorAll('.move').forEach(e => {
                this.mailboxView.drawMailboxSelect(e,window.AccountView.imap.getRootMailboxes());
            });
        });
    }

    async open() {
        try {
            await set_status(`Loading message ${this.message.uid}`, "LOAD");
            await this.message.addFlags('\\Seen');
            await super.open();
            await set_status("OK");
        } catch(e) {
            await set_status("ERR",null,e);
            return;
        }
    }

    async close() {
        super.close();
        await this.message.close();
    }

    // Welcome to the fun zone
    async draw() {
        if(!Object.keys(this.message.headers).length) {
            throw ["Error loading message!", this.message];
            return;
        }

        if(this.mailbox.mailbox === this.mailbox.imap.trash) {
            this.el.querySelectorAll('.movetrash').forEach(e => e.classList.add('hidden'));
        }

        const message_el = template('message-message');
        this.el.append(message_el);

        //if(!this.message.loaded) {
        //    await this.message.loadMessage();
        //}

        await this.drawMessage(this.message,message_el);

        // Fetching the body
        if(!this.message.body) {
            await this.mailbox.loadMessage(this.message.uid,true);
            await this.message.loadMessage();
            this.mailbox.saveMessage(this.message,true);
            await this.drawMessage(this.message,message_el);
        }

        if(!this.message.loaded) {
            await this.message.loadMessage();
            await this.drawMessage(this.message,message_el);
        }

        if(await this.message.isList()) {
            this.el.querySelectorAll('.replyall').forEach(e => e.remove());
        } else {
            this.el.querySelectorAll('.replylist').forEach(e => e.remove());
        }

        // fill body
        await this.drawMessage(this.message, message_el);

        // Download link
        if(this.message.blob) {
            this.el.querySelectorAll('option[value=download]').forEach(e => {
                e.text = "Download (" + decodeSize(this.message.blob.size) + ")";
            });
        }

    }

    async onClickReply() {
        window.ComposeView = new _ComposeView(await this.message.reply());
        await window.ComposeView.open();
    }

    async onClickReplyAll() {
        window.ComposeView = new _ComposeView(await this.message.reply('all'));
        await window.ComposeView.open();
    }

    async onClickReplyList() {
        window.ComposeView = new _ComposeView(await this.message.reply('list'));
        await window.ComposeView.open();
    }

    async onClickForward() {
        window.ComposeView = new _ComposeView(await this.message.forward());
        await window.ComposeView.open();
    }

    async drawMessage(message, el) {
        el.querySelectorAll('.headers .subject').forEach(e => {
            e.innerText = decodeMIMEWords(message.headers.get('subject','one'), false) || "(no subject)";
        });

        el.querySelectorAll('.headers .from').forEach(e => {
            e.innerText = (decodeMIMEWords(message.headers.get('from','one'), false) || "(blank)");
        });

        el.querySelectorAll('.headers .to').forEach(e => {
            e.innerText = (decodeMIMEWords(message.headers.get('to','join'), false) || "(blank)");
        });

        if(message.headers.get('cc')) {
            el.querySelectorAll('.headers .cc').forEach(e => {
                    e.innerText = (decodeMIMEWords(message.headers.get('cc','join'), false) || "(blank)");
            });
            el.querySelectorAll('.headers .cc_header').forEach(e => e.classList.remove('hidden'));
        } else {
            el.querySelectorAll('.headers .cc_header').forEach(e => e.classList.add('hidden'));
        }

        if(message.headers.get('bcc')) {
            el.querySelectorAll('.headers .bcc').forEach(e => {
                    e.innerText = (decodeMIMEWords(message.headers.get('bcc','join'), false) || "(blank)");
            });
            el.querySelectorAll('.headers .bcc_header').forEach(e => e.classList.remove('hidden'));
        } else {
            el.querySelectorAll('.headers .bcc_header').forEach(e => e.classList.add('hidden'));
        }

        el.querySelectorAll('.headers .date').forEach(e => {
            e.innerText = ( decodeDate(message.headers.get('date','one'), true) || "(blank)" );
        });

        if(message.raw_headers && message.raw_headers.length) {
            el.querySelectorAll('.raw_headers').forEach(e => {
                e.innerText = message.raw_headers.join("\r\n");
            });
        }

        if(message.body)
            el.querySelectorAll('.loading').forEach(e => e.remove());

        if(message.inline.length) {
            el.querySelectorAll(':scope > .body').forEach(e => {e.innerHTML = null;});
            for(const inline of message.inline) {
                const t = template('message-inline');
                await this.drawMIMEBodyPart(inline,t,false);
                el.querySelectorAll(':scope > .body').forEach(e => {
                    e.append(t);
                });
            }
        }

        if(message.attachments.length) {
            el.querySelectorAll(':scope > .attachments > .attachment_list').forEach(e => {e.innerHTML = null;});
            el.querySelectorAll('.attachments').forEach(e => e.classList.remove('hidden'));
            for(const attachment of message.attachments) {
                const t = template('message-attachment');
                await this.drawMIMEBodyPart(attachment,t,true);
                el.querySelectorAll(':scope > .attachments >  .attachment_list').forEach(e => {
                    e.append(t);
                });
            }
        } else {
            el.querySelectorAll('.attachments').forEach(e => e.classList.add('hidden'));
        }
    }

    async createBlob(body_part) {
        const [ content_type, content_subtype ] = body_part.content_type
            ? [body_part.content_type, body_part.content_subtype ]
            : [ 'text', 'plain'];

        var blobType = content_type + '/' + content_subtype;
        var blobData = body_part.body;

        switch(content_type) {
            case "application":
                blobType = 'application/octet-stream';
                break;
            case "text":
                switch(content_subtype) {
                    case "html":
                        blobType = 'application/octet-stream';
                        blobData = body_part.raw_html;
                        break;
                    default:
                        if(content_subtype.match(/xml/)) {
                            blobType = 'application/octet-stream';
                        }else if(content_subtype.match(/html/)) {
                            blobType = 'application/octet-stream';
                        }else if(content_subtype.match(/svg/)) {
                            blobType = 'application/octet-stream';
                        }
                        break;
                }
            default:
                if(content_subtype.match(/xml/)) {
                    blobType = 'application/octet-stream';
                }else if(content_subtype.match(/html/)) {
                    blobType = 'application/octet-stream';
                }else if(content_subtype.match(/svg/)) {
                    blobType = 'application/octet-stream';
                }
                break;
        }
        const blob = new Blob([blobData], { type: blobType });
        const blobURL = URL.createObjectURL(blob);
        this.message.blobURLs.push(blobURL);

        return { blob, blobURL };
    }

    async drawMIMEBodyPart(body_part,el,brief=false) {
        var target = el;
        const { blob, blobURL } = await this.createBlob(body_part);

        const [ content_type, content_subtype ] = body_part.content_type
            ? [body_part.content_type, body_part.content_subtype ]
            : [ 'text', 'plain'];

        // Display Type, Filename, and Size
        el.querySelectorAll('.type').forEach(e => {
            e.innerText = content_type + '/' + content_subtype;
        });

        if(body_part.filename) {
            el.querySelectorAll('.filename').forEach(e => {
                e.innerText = body_part.filename;
            });
        }

        el.querySelectorAll('.attachmentsize').forEach(e => {
            e.innerText = decodeSize(blob.size);
        });

        el.querySelectorAll('.download').forEach(e => {
            e.download = body_part.filename;
            e.href = blobURL;
        });

        el.querySelectorAll('.view').forEach(e => {
            if(window.CockmailSettings.renderMedia) {
                e.addEventListener('click', e => {
                    e.target.parentElement.querySelector('.content').classList.remove('hidden');
                    e.target.remove();
                });
            } else {
                e.classList.add('hidden');
            }
        });

        var display_view = true;

        // Display the object
        el.querySelectorAll('.content').forEach(async (e) => {
            switch(content_type) {
                case "application":
                    if(['7bit','8bit',null].includes(body_part.content_transfer_encoding)) {
                        e.innerText = body_part.body;
                    } else {
                        e.innerText += "mailecho doesn't know how to display this type!";
                        display_view = false;
                    }
                    break;
                case "video":
                    if(window.CockmailSettings.renderMedia) {
                        const video = template('message-video');
                        video.src = blobURL;
                        video.setAttribute('controls','true');
                        e.appendChild(video);
                    } else {
                        const content = template('message-text');
                        content.innerHTML = "[unrendered media]";
                        e.appendChild(content);
                    }
                    break;
                case "image":
                    if(window.CockmailSettings.renderMedia) {
                        const image = template('message-image');
                        image.src = blobURL;
                        e.appendChild(image);
                    } else {
                        const content = template('message-text');
                        content.innerHTML = "[unrendered media]";
                        e.appendChild(content);
                    }
                    break;
                case "message":
                    const message_el = template('message-message');

                    await this.drawMessage(body_part.message, message_el);

                    e.appendChild(message_el);
                    break;
                case "text":
                default:
                    const content = template('message-text');

                    switch(content_subtype) {
                        case "html":
                            const converted = document.createElement('p');
                            converted.innerText = "Converted from HTML";
                            content.appendChild(converted);
                            const link_keys = Object.keys(body_part.links);
                            if(link_keys.length > 0) {
                                const links_h = document.createTextNode("Links in this e-mail:");
                                content.appendChild(links_h);
                                const ul = document.createElement('ul');
                                for(const i of link_keys) {
                                    const link = body_part.links[i];
                                    const li = document.createElement('li');
                                    li.innerText = "[" + i + "]: " + link;
                                    ul.appendChild(li);
                                }
                                content.appendChild(ul);
                            }
                            content.appendChild(document.createTextNode(body_part.body));
                            break;
                        case "plain":
                        default:
                            content.innerText = body_part.body;
                            break;

                    }
                    e.appendChild(content);
                    break;
            }
        });

        if(!display_view) {
            el.querySelectorAll('.view').forEach(e => e.classList.add('hidden'));
        }
    }

    async delete(message="(deleted)") {
        this.el.innerText = message;
    }

    async toggleHeaders() {
        const el = this.el.querySelector('.raw_headers');
        if(el.classList.contains('hidden'))
            el.classList.remove('hidden');
        else
            el.classList.add('hidden');
    }

    async viewSource() {
        const el = this.el.querySelector('.raw_body');
        this.el.querySelector('.raw_headers').classList.add('hidden');
        this.el.querySelector('.body').classList.add('hidden');
        this.el.querySelector('.attachments').classList.add('hidden');
        el.classList.remove('hidden');

        el.innerText = this.message.message.join('\r\n');
    }

    async download() {
        const a = document.createElement('a');
        a.download = this.message.uid + '-' + decodeMIMEWords(this.message.headers.get('from','one'),false) + '-' + (decodeMIMEWords(this.message.headers.get('subject','one'),false) || '(no subject)') + '.eml';
        const blob_url = URL.createObjectURL(this.message.blob);
        this.message.blobURLs.push(blob_url);
        a.href = blob_url;
        a.click();
    }


    async splitMessage(lines) {
        const blank = lines.indexOf("");
        if(blank === -1)
            return [message, null];
        const headers = lines.slice(0,blank);
        const body = lines.slice(blank);

        return [ headers, body ];
    }
}
