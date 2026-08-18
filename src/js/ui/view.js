class View {
    constructor(template_name, el_before) {
        this.el = template(template_name);
        this.eventListeners = [];
        this.hide();

        if(el_before)
            el_before.before(this.el);
        else
            document.body.appendChild(this.el);
    }

    async open(draw=true) {
        this.show();
        if(draw)
            await this.draw();
    }

    async close() {
        for(const listener of this.eventListeners) {
            window.removeEventListener(...listener);
        }
        this.el.remove();
    }

    show() {
        this.el.classList.remove('hidden');
    }

    hide() {
        this.el.classList.add('hidden');
    }

    addEventListener(e,callback,options) {
        this.eventListeners.push([e,callback,options]);
        window.addEventListener(e,callback,options);
    }
}
