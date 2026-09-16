// The Router handed to an extension's server entry, made async-safe (see
// createExtensionRouter below). Its own module, importing nothing but express,
// so its test can load it under Node's type stripping without pulling in the
// rest of the extension host.
import { Router, type NextFunction, type Request, type Response } from "express";

// Express 4 calls a route handler and ignores what it returns. A handler
// written `async (req, res) => { ... }` that throws after its first await
// therefore rejects a promise nobody is holding, and with no
// unhandledRejection handler Node exits the whole server over one extension's
// bug. Wrapping the call in extensionHookMiddleware cannot help: router(req,
// res, next) has already returned by the time the handler rejects.
//
// So the Router handed to activate() is patched at the one place a handler
// enters it - the route-registering methods - and each handler's returned
// promise has its rejection forwarded to next(err), exactly as a synchronous
// throw already is. Every docs example (`router.get("/x", async ...)`) is
// then safe as written, and extensions that already catch their own errors
// are unaffected.
const ROUTER_METHODS = ["get", "post", "put", "patch", "delete", "all", "use"] as const;
const ROUTE_METHODS = ["get", "post", "put", "patch", "delete", "all"] as const;

type AnyHandler = (...args: unknown[]) => unknown;

function forwardRejection(result: unknown, next: unknown): void {
  if (result && typeof (result as Promise<unknown>).then === "function" && typeof next === "function") {
    (result as Promise<unknown>).then(undefined, (err: unknown) => {
      // next(undefined) would mean "carry on to the next route", not "fail".
      (next as NextFunction)(err ?? new Error("route handler rejected without a reason"));
    });
  }
}

// Express tells an error handler from a normal one by arity (4 vs ≤3), so the
// wrapper must keep it. A Router passed to use() is itself a 3-arity function
// returning undefined, and passes through a wrapper unharmed.
function wrapHandler(arg: unknown): unknown {
  if (Array.isArray(arg)) return arg.map(wrapHandler);
  if (typeof arg !== "function") return arg;
  const fn = arg as AnyHandler;
  if (fn.length === 4) {
    return function (this: unknown, err: unknown, req: unknown, res: unknown, next: unknown) {
      forwardRejection(fn.call(this, err, req, res, next), next);
    };
  }
  return function (this: unknown, req: unknown, res: unknown, next: unknown) {
    forwardRejection(fn.call(this, req, res, next), next);
  };
}

function patchMethods(target: Record<string, unknown>, methods: readonly string[]): void {
  for (const method of methods) {
    const original = target[method];
    if (typeof original !== "function") continue;
    target[method] = function (this: unknown, ...args: unknown[]) {
      return (original as AnyHandler).apply(this, args.map(wrapHandler));
    };
  }
}

export function createExtensionRouter(): Router {
  const router = Router();
  const target = router as unknown as Record<string, unknown>;
  patchMethods(target, ROUTER_METHODS);
  // router.route(path).get(...) registers through the Route, not the Router.
  const route = target.route as AnyHandler;
  target.route = function (this: unknown, ...args: unknown[]) {
    const created = route.apply(this, args) as Record<string, unknown>;
    patchMethods(created, ROUTE_METHODS);
    return created;
  };
  return router;
}

// Runs one extension's router, answering whatever error escapes it (a
// forwarded rejection or a synchronous throw) with a JSON 500 in the shape
// every client helper already reads, instead of Express's default HTML page.
// Handled here, in the router's own completion callback, rather than as an
// error middleware registered on the router: that would have to come after
// the extension's routes, and an extension may register routes after an
// await in activate().
export function runExtensionRouter(
  id: string,
  router: Router,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  router(req, res, (err?: unknown) => {
    if (err === undefined || err === null || err === "router" || err === "route") {
      next();
      return;
    }
    console.error(`[ext:${id}] route ${req.method} ${req.originalUrl} failed:`, err);
    if (res.headersSent) {
      // Too late for a status: let Express close the connection.
      next(err);
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message || "internal error" });
  });
}
