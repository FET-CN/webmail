import type { RpcError } from "../contract/api.ts";
import { PROBLEM_DEFINITIONS, type ProblemCode } from "../contract/problems.ts";

export class AppError extends Error {
  readonly code: ProblemCode;
  readonly param?: string;
  override readonly cause?: unknown;

  constructor(
    code: ProblemCode,
    detail: string,
    param?: string,
    cause?: unknown,
  ) {
    super(detail);
    this.name = "AppError";
    this.code = code;
    this.param = param;
    this.cause = cause;
  }
}

function requestId(): string {
  return `req_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function problemTypeUrl(code: ProblemCode, baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/${PROBLEM_DEFINITIONS[code].slug}`;
}

export function toProblem(
  error: unknown,
  requestPath: string,
  request_id = requestId(),
  baseUrl = "http://localhost:8787/problems",
): RpcError {
  const appError = error instanceof AppError ? error : new AppError(
    "UPSTREAM_UNAVAILABLE",
    "The mail provider is unavailable.",
    undefined,
    error,
  );
  const definition = PROBLEM_DEFINITIONS[appError.code];

  return {
    type: problemTypeUrl(appError.code, baseUrl),
    title: definition.title,
    status: definition.status,
    detail: appError.message,
    instance: `urn:mailecho:request:${request_id}`,
    object: "error",
    code: appError.code,
    request_id,
    retryable: definition.retryable,
    ...(appError.param ? { param: appError.param } : {}),
  };
}

export function jsonProblem(
  error: unknown,
  request: Request,
  baseUrl: string,
): Response {
  const request_id = request.headers.get("x-request-id") || requestId();
  const problem = toProblem(
    error,
    new URL(request.url).pathname,
    request_id,
    baseUrl,
  );
  const headers = new Headers({
    "content-type": "application/problem+json; charset=utf-8",
    "cache-control": "no-store",
    "x-request-id": request_id,
  });
  if (problem.status === 429) headers.set("retry-after", "30");
  return new Response(JSON.stringify(problem), {
    status: problem.status,
    headers,
  });
}

export function problemResponse(
  error: unknown,
  request: Request,
  baseUrl: string,
): Response {
  const request_id = request.headers.get("x-request-id") || requestId();
  const problem = toProblem(
    error,
    new URL(request.url).pathname,
    request_id,
    baseUrl,
  );
  const accept = request.headers.get("accept") || "application/problem+json";
  if (accept.includes("text/html")) {
    const headers = new Headers({
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-request-id": request_id,
    });
    const title = escapeHtml(problem.title);
    const detail = escapeHtml(problem.detail);
    const type = escapeHtml(problem.type);
    const html =
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} | mailecho</title><style>${problemStyles}</style></head><body><main><header><strong>mailecho</strong><span>Problem details</span></header><section><p class="status">${problem.status}</p><h1>${title}</h1><p>${detail}</p><details><summary>Technical details</summary><dl><dt>Code</dt><dd><code>${problem.code}</code></dd><dt>Type</dt><dd><code>${type}</code></dd><dt>Request</dt><dd><code>${problem.request_id}</code></dd></dl></details></section></main></body></html>`;
    return new Response(html, { status: problem.status, headers });
  }
  if (accept.includes("text/markdown")) {
    const headers = new Headers({
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "no-store",
      "x-request-id": request_id,
    });
    const markdown =
      `# ${problem.title}\n\n- Code: \`${problem.code}\`\n- Status: \`${problem.status}\`\n- Request: \`${problem.request_id}\`\n\n${problem.detail}\n`;
    return new Response(markdown, { status: problem.status, headers });
  }
  const headers = new Headers({
    "content-type": "application/problem+json; charset=utf-8",
    "cache-control": "no-store",
    "x-request-id": request_id,
  });
  if (problem.status === 429) headers.set("retry-after", "30");
  return new Response(JSON.stringify(problem), {
    status: problem.status,
    headers,
  });
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

const problemStyles =
  `:root{color-scheme:dark light;font-family:system-ui,sans-serif}body{margin:0;min-height:100vh;background:#202124;color:#f7f7f7}main{max-width:720px;margin:0 auto;padding:24px}header{display:flex;justify-content:space-between;border-bottom:1px solid #555;padding-bottom:16px;color:#c7c7c7}section{padding:64px 0}.status{font-size:18px;color:#f87171;font-weight:700}h1{font-size:32px;margin:8px 0 16px}p{line-height:1.6;color:#ddd}details{border-top:1px solid #555;padding-top:16px;color:#ccc}dl{display:grid;grid-template-columns:120px 1fr;gap:10px}code{overflow-wrap:anywhere}@media(prefers-color-scheme:light){body{background:#f6f7f9;color:#202124}p{color:#414141}header{color:#555}}`;

export function json<T>(
  value: T,
  status = 200,
  headers?: HeadersInit,
): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "application/json; charset=utf-8");
  responseHeaders.set("cache-control", "no-store");
  return new Response(JSON.stringify(value), {
    status,
    headers: responseHeaders,
  });
}

export function readBearer(request: Request): string | null {
  const value = request.headers.get("authorization");
  return value?.startsWith("Bearer ") ? value.slice(7) : null;
}
