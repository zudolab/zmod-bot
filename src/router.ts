/**
 * Minimal typed router — no external framework dependency. Modeled on
 * readycrew-viewer's `app/src/api/router.ts` (same shape, ~59 lines):
 * method + `URLPattern` -> handler, with `:param` support. This is
 * infrastructure, not business logic, so — unlike the rest of this
 * module skeleton — it is fully implemented here rather than stubbed;
 * later sub-tasks register their own routes in src/index.ts without
 * touching this file.
 */
import type { Env } from "./env";

export interface RouteContext {
  request: Request;
  env: Env;
  ctx: ExecutionContext;
  /** Named path params from the URLPattern match, e.g. `:slug` -> params.slug. */
  params: Record<string, string | undefined>;
}

export type RouteHandler = (context: RouteContext) => Response | Promise<Response>;

interface RouteDefinition {
  method: string;
  pattern: URLPattern;
  handler: RouteHandler;
}

export class Router {
  private readonly routes: RouteDefinition[] = [];

  private register(method: string, pathname: string, handler: RouteHandler): this {
    this.routes.push({ method, pattern: new URLPattern({ pathname }), handler });
    return this;
  }

  get(pathname: string, handler: RouteHandler): this {
    return this.register("GET", pathname, handler);
  }

  post(pathname: string, handler: RouteHandler): this {
    return this.register("POST", pathname, handler);
  }

  async handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    for (const route of this.routes) {
      if (route.method !== request.method) continue;
      const match = route.pattern.exec(url);
      if (!match) continue;
      return route.handler({ request, env, ctx, params: match.pathname.groups });
    }
    return Response.json({ error: "not_found", path: url.pathname }, { status: 404 });
  }
}
