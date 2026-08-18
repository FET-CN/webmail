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
    // Raw protocol sockets are exposed under the versioned backend prefix.
    //imap_server: (window.location.protocol === "http:" ? "ws://" : "wss://") + window.location.host + "/v1/imap",
    //smtp_server: (window.location.protocol === "http:" ? "ws://" : "wss://") + window.location.host + "/v1/smtp",
    //events_server: (window.location.protocol === "http:" ? "ws://" : "wss://") + window.location.host + "/v1/events"
    imap_server: 'wss://webmailapi.flowecho.org/v1/imap',
    smtp_server: 'wss://webmailapi.flowecho.org/v1/smtp',
    events_server: 'wss://webmailapi.flowecho.org/v1/events'
};
