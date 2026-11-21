let csrf = "";

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
  const response = await fetch(`/platform${path}`, {
    method,
    credentials: "same-origin",
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(method !== "GET" && csrf ? { "x-krono-csrf": csrf } : {}),
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
    response.status === 401 &&
    retry &&
    (!path.startsWith("/auth/") || path === "/auth/session")
  ) {
    const refresh = await fetch("/platform/auth/refresh", {
      method: "POST",
      credentials: "same-origin",
    });
    if (refresh.ok) {
      const session = await refresh.json();
      csrf = session.csrf;
      if (method === "GET") return platform<T>(path, method, body, false);
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
  if (result.csrf) csrf = result.csrf;
  return result as T;
}
