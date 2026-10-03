import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { TrendReport, TrendTopic } from "../shared/types.js";
import { Engine, DomainError } from "./engine.js";
const escape = (s: unknown) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export function createApp(
  engine: Engine,
  options: {
    refreshProviders?: () => Promise<unknown>;
    probeProviders?: () => Promise<unknown>;
    refreshTrends?: (topic: TrendTopic) => Promise<TrendReport>;
    now?: () => number;
  } = {},
) {
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    let path: string;
    try {
      path = decodeURIComponent(req.path);
    } catch {
      return res.status(404).json({ error: "Not found" });
    }
    if (
      path.split("/").some((part) => part.startsWith(".")) ||
      /^\/(?:server|data|tests|@fs)(?:\/|$)/.test(path)
    )
      return res.status(404).json({ error: "Not found" });
    next();
  });
  app.use(express.json({ limit: "100kb" }));
  const now = options.now ?? Date.now;
  const godSessions = new Map<string, number>();
  const godStreams = new Map<string, Set<Response>>();
  const hasGodSession = (token: string) => {
    const expiry = godSessions.get(token);
    if (expiry !== undefined && expiry > now()) return true;
    godSessions.delete(token);
    for (const stream of godStreams.get(token) ?? []) stream.end();
    godStreams.delete(token);
    return false;
  };
  const starts = new Map<string, string>();
  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  const local = (req: Request, res: Response, next: NextFunction) => {
    const remote = req.socket.remoteAddress ?? "";
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote))
      return res.status(403).json({ error: "Local demo access only" });
    next();
  };
  app.use("/api", (req, res, next) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method))
      return local(req, res, next);
    next();
  });
  const god = (req: Request, res: Response, next: NextFunction) => {
    const token = (req.get("cookie") ?? "")
      .split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith("produce_god="))
      ?.slice(12);
    if (!token || !hasGodSession(token))
      return res
        .status(403)
        .json({ error: "God view requires a local demo session" });
    next();
  };
  app.get("/api/health", (_req, res) =>
    res.json({ ok: true, service: "produce-purchasing", simulation: true }),
  );
  app.get("/api/bootstrap", (_req, res) => res.json(engine.bootstrap()));
  app.get("/api/capabilities", (_req, res) => res.json(engine.capabilities()));
  app.get("/api/trends", (_req, res) => res.json(engine.trendsSnapshot()));
  let refreshingTrends: Promise<TrendReport> | undefined;
  let trendRefreshAt = 0;
  let refreshingTopic: TrendTopic | undefined;
  app.post("/api/trends/refresh", local, async (req, res) => {
    const topic = req.body?.skuId ?? "cucumbers";
    if (
      !["cucumbers", "avocados", "strawberries", "apples", "bananas"].includes(
        topic,
      )
    )
      throw new DomainError("Choose one of the five supported produce topics");
    if (!options.refreshTrends)
      throw new DomainError("Trend provider unavailable", 409);
    if (refreshingTrends) {
      if (refreshingTopic !== topic) throw new DomainError("Another produce topic is being refreshed; wait for it to finish.", 409);
      await refreshingTrends;
      return res.json(engine.trendsSnapshot());
    }
    if (trendRefreshAt && Date.now() - trendRefreshAt < 300000)
      throw new DomainError(
        "Wait five minutes before another paid trend refresh; cached results remain available.",
        429,
      );
    trendRefreshAt = Date.now();
    refreshingTopic = topic as TrendTopic;
    refreshingTrends = options.refreshTrends(topic as TrendTopic);
    try {
      const report = await refreshingTrends;
      engine.setTrends(report);
      res.json(engine.trendsSnapshot());
    } finally {
      refreshingTrends = undefined;
      refreshingTopic = undefined;
    }
  });
  app.post("/api/providers/refresh", async (_req, res) => {
    if (!options.refreshProviders)
      throw new DomainError("Provider refresh unavailable", 409);
    await options.refreshProviders();
    res.json(engine.capabilities());
  });
  app.post("/api/providers/probe", local, god, async (_req, res) => {
    if (!options.probeProviders)
      throw new DomainError("Provider probe unavailable", 409);
    res.json(await options.probeProviders());
  });
  app.post("/api/session/god", local, (req, res) => {
    if (req.body?.enabled !== true)
      return res
        .status(400)
        .json({ error: "Explicit local god-view activation is required" });
    const token = randomBytes(24).toString("hex");
    godSessions.set(token, now() + 4 * 60 * 60 * 1000);
    res.cookie("produce_god", token, {
      httpOnly: true,
      sameSite: "strict",
      path: "/api",
      maxAge: 4 * 60 * 60 * 1000,
    });
    res.json({ enabled: true, scope: "local-demo" });
  });
  app.delete("/api/session/god", (req, res) => {
    const token = (req.get("cookie") ?? "")
      .split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith("produce_god="))
      ?.slice(12);
    if (token) {
      godSessions.delete(token);
      for (const stream of godStreams.get(token) ?? []) stream.end();
      godStreams.delete(token);
    }
    res.clearCookie("produce_god", { path: "/api" });
    res.json({ enabled: false });
  });
  app.post("/api/runs", (req, res) => {
    const key = req.get("idempotency-key");
    if (key && starts.has(key))
      return res.json(engine.snapshot(starts.get(key)!));
    const run = engine.create(req.body ?? {});
    if (key) starts.set(key, run.id);
    res.status(201).json(run);
  });
  app.get("/api/runs/:id", (req, res) =>
    res.json(engine.snapshot(String(req.params.id))),
  );
  app.get("/api/runs/:id/god", god, (req, res) =>
    res.json(engine.godSnapshot(String(req.params.id))),
  );
  const stream =
    (isGod = false) =>
    (req: Request, res: Response) => {
      const id = String(req.params.id);
      const godToken = isGod
        ? (req.get("cookie") ?? "")
            .split(";")
            .map((x) => x.trim())
            .find((x) => x.startsWith("produce_god="))
            ?.slice(12)
        : undefined;
      if (isGod && (!godToken || !hasGodSession(godToken)))
        return res.status(403).end();
      if (godToken) {
        const sessions = godStreams.get(godToken) ?? new Set<Response>();
        sessions.add(res);
        godStreams.set(godToken, sessions);
      }
      const snapshot = () =>
        isGod ? engine.godSnapshot(id) : engine.snapshot(id);
      snapshot();
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
      const write = () => {
        if (res.writableEnded) return;
        if (godToken && !hasGodSession(godToken)) return res.end();
        const s = snapshot();
        res.write(
          `id: ${s.eventSeq}\nevent: snapshot\ndata: ${JSON.stringify(s)}\n\n`,
        );
      };
      write();
      const off = engine.subscribe((changed) => {
        if (changed === id) write();
      });
      const heartbeat = setInterval(() => {
        if (godToken && !hasGodSession(godToken)) return res.end();
        if (!res.writableEnded) res.write(": heartbeat\n\n");
      }, 15000);
      req.on("close", () => {
        off();
        clearInterval(heartbeat);
        if (godToken) {
          const sessions = godStreams.get(godToken);
          sessions?.delete(res);
          if (!sessions?.size) godStreams.delete(godToken);
        }
      });
    };
  app.get("/api/runs/:id/events", stream());
  app.get("/api/runs/:id/god/events", god, stream(true));
  app.post("/api/runs/:id/cancel", (req, res) =>
    res.json(engine.cancel(String(req.params.id))),
  );
  app.post("/api/runs/:id/approve", (req, res) =>
    res.json(engine.approve(String(req.params.id), Number(req.body?.revision))),
  );
  app.post("/api/runs/:id/flyer", (req, res) =>
    res.json(engine.flyer(String(req.params.id))),
  );
  app.get("/api/runs/:id/flyer", (req, res) =>
    res.json(engine.snapshot(String(req.params.id)).flyer),
  );
  app.get("/api/runs/:id/flyer/preview", (req, res) => {
    const r = engine.snapshot(String(req.params.id));
    if (r.flyer.status !== "ready")
      return res.status(409).send("Approve and compose the flyer first.");
    res
      .type("html")
      .send(
        `<!doctype html><html><head><meta charset="utf-8"><title>${escape(r.store.name)} produce offers</title><style>body{margin:0;background:#f1eadc;color:#173e32;font-family:Georgia,serif}.flyer{max-width:900px;margin:30px auto;padding:44px;background:#fff9ed;border:1px solid #cad4bd}h1{font-size:64px;margin:8px 0}.kicker{text-transform:uppercase;letter-spacing:.2em}img{width:100%;max-height:300px;object-fit:cover}.offers{display:flex;gap:20px;margin:30px 0}.offer{flex:1;border-top:2px solid;padding-top:20px}.price{font-size:48px}small{display:block;margin-top:16px}button{padding:12px}@media print{button{display:none}.flyer{margin:0;border:0}}</style></head><body><main class="flyer"><div class="kicker">${escape(r.store.neighborhood)} · fresh produce</div><h1>${escape(r.store.name)}</h1><p>Good food. Neighborly prices.</p><img src="${escape(r.flyer.artworkUrl)}" alt="AI-generated produce artwork"><div class="offers">${r.promotions.map((p) => `<section class="offer"><h2>${escape(p.name)}</h2><div class="price">$${(p.retailPriceCents / 100).toFixed(2)}</div><div>per ${escape(p.unit)}</div><small>Up to ${p.quantityCap} ${escape(p.unit)} available at this offer.</small></section>`).join("")}</div><p>Offers valid October 4–5, 2026, while allocated supplies last.</p><small>Fictional store · simulated purchasing demo · approved promotion revision ${r.promotionRevision}. Artwork was generated in advance; offer text is rendered from the approved plan.</small><button onclick="window.print()">Print flyer</button></main></body></html>`,
      );
  });
  app.use(express.static(resolve("public")));
  if (existsSync("dist/client/index.html")) {
    app.use(express.static(resolve("dist/client")));
    app.get("/{*path}", (_req, res) =>
      res.sendFile(resolve("dist/client/index.html")),
    );
  } else
    app.get("/", (_req, res) =>
      res.json({
        message: "Backend ready. Start npm run dev:ui for the React interface.",
        ui: "http://127.0.0.1:5173",
      }),
    );
  app.use(
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const status = error instanceof DomainError ? error.status : 400;
      res.status(status).json({
        error:
          error instanceof DomainError
            ? error.message
            : "Request could not be processed",
      });
    },
  );
  return app;
}
