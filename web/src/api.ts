let actionToken = "";

export function setActionToken(token: string) {
  actionToken = token;
}

export class ApiError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const method = options.method ?? "GET";
  const response = await fetch(path, {
    method,
    headers:
      method === "GET"
        ? undefined
        : {
            "Content-Type": "application/json",
            "X-Action-Token": actionToken,
          },
    body: method === "GET" ? undefined : JSON.stringify(options.body ?? {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = payload.error ?? {};
    throw new ApiError(error.code ?? "UNKNOWN_ERROR", error.message ?? "Request failed");
  }
  return payload as T;
}
