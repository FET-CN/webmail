import { PROBLEM_DEFINITIONS, type ProblemCode } from "../contract/problems.ts";

const guidance: Record<ProblemCode, string> = {
  AUTH_REQUIRED: "Authenticate before retrying the request.",
  AUTH_INVALID: "Sign in again with the identity provider.",
  SESSION_EXPIRED: "Refresh the session or sign in again.",
  MAILBOX_NOT_FOUND: "Verify that the mailbox still exists.",
  MESSAGE_NOT_FOUND: "Refresh the mailbox and try again.",
  UPSTREAM_AUTH_FAILED:
    "Retry after the mail provider accepts the backend credential.",
  UPSTREAM_UNAVAILABLE: "Wait briefly and retry the operation.",
  PROVISIONING_UNAVAILABLE:
    "Verify OIDC, Migadu API, and mailbox provisioning configuration.",
  FORBIDDEN: "Ask an administrator to grant access to this mailbox.",
  MESSAGE_TOO_LARGE: "Reduce the message or attachment size.",
  TOO_MANY_RECIPIENTS:
    "Remove recipients and send the message in smaller batches.",
  RATE_LIMITED: "Wait before retrying the request.",
  INVALID_PARAMS: "Correct the highlighted parameters.",
  INVALID_CURSOR: "Restart pagination from the first page.",
  SYNC_REQUIRED: "Refresh the mailbox to rebuild synchronization state.",
  PROBLEM_TYPE_NOT_FOUND: "Verify the problem type URL and try again.",
  ADDRESS_UNAVAILABLE:
    "Choose a different address, or register it if it does not exist yet.",
  ADDRESS_ALREADY_BOUND:
    "Choose a different address, or ask an administrator to reassign it.",
  ADDRESS_PENDING_CLAIM: "Wait for the pending claim to resolve, then try again.",
  REGISTRATION_DUPLICATE: "The address is already pending registration.",
  VERIFICATION_FAILED: "Re-enter the verification code, or request a new one.",
  VERIFICATION_EXPIRED: "Request a new verification code and try again.",
};

export function problemDocument(
  code: ProblemCode,
  baseUrl: string,
  format: "json" | "markdown" | "html",
): Response {
  const definition = PROBLEM_DEFINITIONS[code];
  const type = `${baseUrl.replace(/\/$/, "")}/${definition.slug}`;
  const document = {
    object: "problem_type",
    id: definition.slug,
    code,
    title: definition.title,
    status: definition.status,
    retryable: definition.retryable,
    type,
    guidance: guidance[code],
  };
  if (format === "json") {
    return new Response(JSON.stringify(document), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  const markdown =
    `# ${definition.title}\n\n- Code: \`${code}\`\n- HTTP status: \`${definition.status}\`\n- Retryable: \`${definition.retryable}\`\n\n## Recommended action\n\n${
      guidance[code]
    }\n`;
  if (format === "markdown") {
    return new Response(markdown, {
      headers: { "content-type": "text/markdown; charset=utf-8" },
    });
  }
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${definition.title} | mailecho</title><style>${styles}</style></head><body><main><header><strong>mailecho</strong><span>Problem details</span></header><section><p class="status">${definition.status}</p><h1>${definition.title}</h1><p>${
      guidance[code]
    }</p><div class="actions"><a href="${type}">Refresh</a><button onclick="navigator.clipboard?.writeText(location.href)">Copy link</button></div><details><summary>Technical details</summary><dl><dt>Code</dt><dd><code>${code}</code></dd><dt>Type</dt><dd><code>${type}</code></dd><dt>Retryable</dt><dd>${definition.retryable}</dd></dl></details></section></main></body></html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

const styles =
  `:root{color-scheme:dark light;font-family:system-ui,sans-serif;background:#222;color:#fafafa}body{margin:0;min-height:100vh;background:#222;color:#fafafa}main{max-width:720px;margin:0 auto;padding:24px}header{display:flex;justify-content:space-between;border-bottom:1px solid #555;padding-bottom:16px;color:#ccc}section{padding:64px 0}.status{font-size:18px;color:#f87171;font-weight:700}h1{font-size:32px;margin:8px 0 16px}p{line-height:1.6;color:#ddd}.actions{display:flex;gap:12px;margin:28px 0}.actions a,.actions button{border:1px solid #888;background:#333;color:#fff;padding:10px 14px;text-decoration:none;border-radius:4px;cursor:pointer}.actions a{background:#2f6f9f;border-color:#5aa5d6}details{border-top:1px solid #555;padding-top:16px;color:#ccc}dl{display:grid;grid-template-columns:120px 1fr;gap:10px}code{overflow-wrap:anywhere}@media(prefers-color-scheme:light){body{background:#f5f5f5;color:#222}p{color:#444}header{color:#555}.actions button{background:#fff;color:#222}}`;
