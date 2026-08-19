import { AppError } from "./errors.ts";

const ALLOWED = new Set(["mailbox", "attachments", "headers"]);

export function parseExpand(value: string | null): string[] {
  if (!value) return [];
  const paths = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (paths.some((path) => !ALLOWED.has(path))) {
    throw new AppError(
      "INVALID_PARAMS",
      "The requested expansion is not supported.",
      "expand",
    );
  }
  return [...new Set(paths)];
}

export function expandQuery(url: URL): string[] {
  return parseExpand(url.searchParams.getAll("expand[]").join(","));
}
