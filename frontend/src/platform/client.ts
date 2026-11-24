let csrf = "";
let sessionUserId: string | undefined;
type Session = { csrf?: string; userId?: string };
let csrfRefresh: Promise<Session | null> | undefined;

function refreshCsrf() {
  csrfRefresh ??= fetch("/platform/auth/session", {
    credentials: "same-origin",
    cache: "no-store",
  })
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null)
    .finally(() => {
      csrfRefresh = undefined;
    });
  return csrfRefresh;
}

export class PlatformRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
export async function platform<T>(
  path: string,
  method = "GET",
  body?: unknown,
  retry = true,
): Promise<T> {
  const mutation = method !== "GET" && method !== "HEAD";
  const authenticatedAction =
    !path.startsWith("/auth/") || path === "/auth/logout";
  if (mutation && authenticatedAction && !csrf && !sessionUserId) {
    const session = await refreshCsrf();
    if (session?.userId && session.csrf) {
      sessionUserId = session.userId;
      csrf = session.csrf;
    }
  }
  const originalUser = sessionUserId;
  const response = await fetch(`/platform${path}`, {
    method,
    credentials: "same-origin",
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(mutation && csrf ? { "x-krono-csrf": csrf } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 204) return undefined as T;
  const result = await response.json().catch(() => ({
    error: {
      message: "The Krono service is unavailable.",
    },
  }));
  if (
    response.status === 403 &&
    retry &&
    mutation &&
    result.error?.code === "CSRF"
  ) {
    const session = await refreshCsrf();
    if (originalUser && session?.userId && session.userId !== originalUser)
      throw new PlatformRequestError(
        "Your account changed in another tab. Reload Krono before submitting this action.",
        403,
      );
    // A CSRF rejection occurs before the handler runs. Retry only for the same user.
    if (
      originalUser &&
      sessionUserId === originalUser &&
      session?.userId === originalUser &&
      session.csrf
    ) {
      csrf = session.csrf;
      return platform<T>(path, method, body, false);
    }
  }
  if (
    response.status === 401 &&
    retry &&
    (!path.startsWith("/auth/") || path === "/auth/session")
  ) {
    const refresh = await fetch("/platform/auth/refresh", {
      method: "POST",
      credentials: "same-origin",
    });
    if (refresh.ok) {
      if (!mutation) return platform<T>(path, method, body, false);
      throw Error(
        "Your session was refreshed. Review and submit the action again; it was not resent automatically.",
      );
    }
  }
  if (!response.ok)
    throw new PlatformRequestError(
      result.error?.message ?? "Krono request failed",
      response.status,
    );
  if (path === "/auth/session") {
    sessionUserId = result.userId;
    csrf = result.csrf ?? "";
  } else if (path === "/auth/logout" || result.csrf) {
    sessionUserId = undefined;
    csrf = result.csrf ?? "";
  }
  return result as T;
}
