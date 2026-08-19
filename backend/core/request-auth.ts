import { AppError, readBearer } from "./errors.ts";
import { SessionService } from "./session.ts";

function cookie(request: Request, name: string): string | null {
  const value = request.headers.get("cookie")?.split(";").map((item) =>
    item.trim()
  ).find((item) => item.startsWith(`${name}=`));
  return value ? decodeURIComponent(value.slice(name.length + 1)) : null;
}

export function refreshCookie(request: Request): string | null {
  return cookie(request, "mailecho_refresh");
}

export async function authenticateRequest(
  request: Request,
  service: SessionService,
) {
  const token = readBearer(request) || cookie(request, "mailecho_access");
  if (!token) {
    throw new AppError("AUTH_REQUIRED", "Authentication is required.");
  }
  return service.access(token);
}
