window.config = {
    // Change this to false. It activates features specific to official mailecho.
    official: false,
    // The EHLO domain is sent during SMTP and sometimes shows up in "Received" headers
    ehlo: 'mailecho',
    // Set as the default "User-Agent" header in outgoing mail
    user_agent: 'mailecho/0.5.0',
    // SMTP supports up to 100
    maxrcpt: 25,
    // Number of log messages to retain. Higher = more memory usage
    log_messages: 2000,
    // Log level to output to developer console. -1 to disable
    log_level_console: WARN,
    // Keep this empty when the static application and /v1 share an origin.
    // A same-site API subdomain is also supported; update connect-src in
    // src/document.html before setting it.
    api_origin: ''
};

const apiOrigin = window.config.api_origin.replace(/\/$/, '');
const apiURL = (path) => apiOrigin + path;
window.apiEndpoint = apiURL;
const websocketURL = (path) => {
    const endpoint = new URL(apiURL(path), window.location.href);
    endpoint.protocol = endpoint.protocol === 'http:' ? 'ws:' : 'wss:';
    return endpoint.toString();
};

window.config.imap_server = websocketURL('/v1/imap');
window.config.smtp_server = websocketURL('/v1/smtp');
window.config.events_server = websocketURL('/v1/events');

let sessionRefresh = null;
window.apiFetch = async (path, init = {}) => {
    const request = () => fetch(apiURL(path), {
        credentials: 'include',
        ...init,
    });
    let response = await request();
    if(response.status !== 401 || path.startsWith('/v1/session/')) return response;
    sessionRefresh ||= fetch(apiURL('/v1/session/refresh'), {
        method: 'POST',
        credentials: 'include',
    }).finally(() => { sessionRefresh = null; });
    const refreshed = await sessionRefresh;
    if(refreshed.ok) return request();
    window.location.assign(apiURL('/v1/session/start'));
    return response;
};
