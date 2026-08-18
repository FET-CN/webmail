function template(name) {
    const node = window.templates[name].cloneNode(true);

    for(const el of node.querySelectorAll('[data-ref]')) {
        const key = el.dataset.ref;
        node[key] = el;
    }

    return node;
}

function load_templates() {
    window.templates = {};

    for(const template of document.querySelectorAll('template[id^="t-"]')) {
        var node = template.cloneNode(true);
        node.innerHTML = node.innerHTML.replace(/\s+</g,'<').replace(/>\s+/g,'>');

        const render = node.content.children[0];

        if(!window.config.official)
            render.querySelectorAll('.official').forEach(e => e.classList.add('hidden'));

        window.templates[template.id.slice(2)] = render;
    }
}
