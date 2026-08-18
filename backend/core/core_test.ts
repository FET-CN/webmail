import { configFromEnv } from "./config.ts";
import { AppError, problemResponse, toProblem } from "./errors.ts";
import { decodeCursor, encodeCursor, listResponse } from "./pagination.ts";
import { MemorySessionStore, SessionService } from "./session.ts";
import { signToken, verifyToken } from "./jwt.ts";
import { MemoryEventHub, event } from "./events.ts";

function assert(condition: unknown, message = "Assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T): void {
  if (actual !== expected) throw new Error(`Expected ${String(expected)}, got ${String(actual)}`);
}

async function assertRejects(action: () => Promise<unknown>, type: new (...args: any[]) => Error): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (error instanceof type) return;
    throw error;
  }
  throw new Error("Expected action to reject");
}

const config = configFromEnv({
  JWT_SECRET: "test-secret-that-is-long-enough",
  APP_ORIGIN: "http://localhost:3000",
});

Deno.test("access and refresh tokens rotate and reject reuse", async () => {
  const service = new SessionService(new MemorySessionStore(), config);
  const first = await service.create({ username: "user@example.com", password: "password" });
  const second = await service.refresh(first.refreshToken);
  assert(second.accessToken !== first.accessToken);
  await assertRejects(() => service.refresh(first.refreshToken), AppError);
});

Deno.test("concurrent refresh attempts consume a token once", async () => {
  const service = new SessionService(new MemorySessionStore(), config);
  const first = await service.create({ username: "race@example.com", password: "password" });
  const results = await Promise.allSettled([service.refresh(first.refreshToken), service.refresh(first.refreshToken)]);
  assertEquals(results.filter((result) => result.status === "fulfilled").length, 1);
  assertEquals(results.filter((result) => result.status === "rejected").length, 1);
});

Deno.test("JWT rejects a token with the wrong type", async () => {
  const token = await signToken("user", "session", "access", 60, config.jwtSecret);
  await assertRejects(() => verifyToken(token, "refresh", config.jwtSecret), AppError);
});

Deno.test("cursor pagination round-trips and binds to a mailbox", async () => {
  const cursor = encodeCursor({ version: 1, mailbox: "INBOX", date: "2026-08-19T00:00:00Z", uid: 42, page: 2 });
  assertEquals(decodeCursor(cursor, "INBOX").uid, 42);
  await assertRejects(() => Promise.resolve(decodeCursor(cursor, "Archive")), AppError);
  assert(listResponse([{ id: 1 }], 2, 25, cursor).has_more);
});

Deno.test("problem details include RFC 9457 fields and extensions", () => {
  const problem = toProblem(new AppError("RATE_LIMITED", "Try later."), "/v1/messages/send", "req_test", "https://api.example/problems");
  assertEquals(problem.type, "https://api.example/problems/rate-limited");
  assertEquals(problem.object, "error");
  assertEquals(problem.retryable, true);
});

Deno.test("problem details negotiate HTML and Markdown without leaking stack traces", async () => {
  const request = new Request("https://mail.example/v1/messages/send", {
    headers: { accept: "text/html" },
  });
  const html = await problemResponse(new AppError("INVALID_PARAMS", "Fix the request."), request, config.problemTypeBaseUrl).text();
  assert(html.includes("mailecho"));
  assert(!html.includes("Error: "));
  const markdownRequest = new Request(request, { headers: { accept: "text/markdown" } });
  const markdown = await problemResponse(new AppError("INVALID_PARAMS", "Fix the request."), markdownRequest, config.problemTypeBaseUrl).text();
  assert(markdown.startsWith("# Invalid parameters"));
});

Deno.test("event hub publishes and unsubscribes listeners", () => {
  const hub = new MemoryEventHub();
  const events: string[] = [];
  const unsubscribe = hub.subscribe((value) => events.push(value.type));
  hub.publish(event("message.updated", { mailbox: "INBOX" }));
  unsubscribe();
  hub.publish(event("message.deleted", { mailbox: "INBOX" }));
  assertEquals(events.join(","), "message.updated");
});
