import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { originMatchesHost } from "../agent/gateway.js";
import { AppPreferencesStore, InvalidPreferencesError } from "../app/preferences.js";

const MAX_BODY_BYTES = 16 * 1024;

/**
 * `GET/PUT /app/preferences`: the app preferences file the desktop shares (theme, language,
 * new-project defaults, launch and trash behaviour). PUT takes a partial document, deep-merged into the stored one; both answer with
 * the effective preferences. Errors are `{ error: { code, message } }`.
 */
export function registerAppPreferencesRoutes(
  api: Hono,
  options: { store?: AppPreferencesStore } = {},
): void {
  const store = options.store ?? new AppPreferencesStore();
  const failure = (code: string, message: string) => ({ error: { code, message } });

  api.get("/app/preferences", (c) => c.json(store.read()));

  api.put(
    "/app/preferences",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json(failure("invalid_request", "Request body is too large"), 400),
    }),
    async (c) => {
      // A page on another origin must not rewrite the user's app-wide preferences.
      if (!originMatchesHost(c.req.raw)) {
        return c.json(failure("forbidden", "The request Origin does not match its Host."), 403);
      }
      const body: unknown = await c.req.json().catch(() => undefined);
      try {
        return c.json(store.update(body));
      } catch (error) {
        if (error instanceof InvalidPreferencesError) {
          return c.json(failure("invalid_request", error.message), 400);
        }
        throw error;
      }
    },
  );
}
