window.config = {
    // Change this to false. It activates features specific to official cock-mail.
    official: true,
    // The EHLO domain is sent during SMTP and sometimes shows up in "Received" headers
    ehlo: 'cock-mail',
    // Set as the default "User-Agent" header in outgoing mail
    user_agent: 'Cock-mail/0.5.0',
    // SMTP supports up to 100
    maxrcpt: 25,
    // Number of log messages to retain. Higher = more memory usage
    log_messages: 2000,
    // Log level to output to developer console. -1 to disable
    log_level_console: WARN,
    // Default websocket endpoints: /imap and /smtp on current host
    imap_server: (window.location.protocol === "http:" ? "ws://" : "wss://") + window.location.host + "/imap",
    smtp_server: (window.location.protocol === "http:" ? "ws://" : "wss://") + window.location.host + "/smtp"
    //imap_server: 'wss://example.com/path/to/imap',
    //smtp_server: 'wss://example.com/path/to/smtp'
};
