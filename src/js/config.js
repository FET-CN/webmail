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
    // The self-hosted Deno backend serves the page and API from one origin.
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
const REQUEST_TIMEOUT_MS = 30000;
window.apiFetch = async (path, init = {}) => {
    const request = async () => {
        // Without a deadline an upstream stall leaves the UI spinning instead
        // of failing, and a POST that times out client-side can be retried
        // into a duplicate send.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new DOMException(
            'The request timed out', 'TimeoutError'
        )), REQUEST_TIMEOUT_MS);
        try {
            return await fetch(apiURL(path), {
                credentials: 'include',
                ...init,
                signal: controller.signal
            });
        } finally {
            clearTimeout(timer);
        }
    };
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
