/**
 * Identifies browser document requests that an API runtime may satisfy with the
 * generated webmail HTML. API and problem-document paths always stay owned by
 * the application handler, and protocol upgrades never receive a document.
 */
export function isEmbeddedWebmailRequest(request: Request): boolean {
  if (
    request.method !== "GET" && request.method !== "HEAD" ||
    request.headers.has("upgrade")
  ) {
    return false;
  }
  const pathname = new URL(request.url).pathname;
  return !(
    pathname === "/v1" || pathname.startsWith("/v1/") ||
    pathname === "/problems" || pathname.startsWith("/problems/")
  );
}
