export class PlatformError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export const missing = () =>
  new PlatformError("NOT_FOUND", "Resource not found", 404);
export const conflict = () =>
  new PlatformError(
    "CONFLICT",
    "The resource changed; reload and review again",
    409,
  );
export const denied = (message = "This action is not permitted") =>
  new PlatformError("FORBIDDEN", message, 403);
