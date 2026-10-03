import {
  fetchTrendSignals,
  loadCachedTrendReport,
} from "./integrations/trends.js";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { fetchEvidence } from "./evidence.js";
import { Engine } from "./engine.js";
import { createApp } from "./app.js";
import { createIntegrationService } from "./integrations/index.js";
const engine = new Engine();
const cachedTrends = loadCachedTrendReport();
if (cachedTrends) engine.setTrends(cachedTrends);
const integration = createIntegrationService();
engine.attachBridge(integration);
const port = Number(process.env.PORT ?? 3001);
const refreshProviders = async () => {
  const values = parseEnv(readFileSync(".env", "utf8"));
  for (const [name, value] of Object.entries(values))
    if (
      /^(BAND(?:_|$)|ZOOWORK_API_KEY$|USDA_AMS_API_KEY$|CENSUS_API_KEY$|GLASSER_API_KEY$)/.test(
        name,
      )
    )
      process.env[name] = value;
  await integration.start();
  void fetchEvidence()
    .then((e) => engine.setEvidence(e))
    .catch(() => {});
  return integration.status();
};
const server = createApp(engine, {
  refreshProviders,
  probeProviders: () => integration.probeTransport(),
  refreshTrends: fetchTrendSignals,
}).listen(port, "127.0.0.1", () =>
  console.log(`Produce purchasing server: http://127.0.0.1:${port}`),
);
void fetchEvidence()
  .then((e) => engine.setEvidence(e))
  .catch(() =>
    console.warn("Evidence request incomplete; fixtures remain labeled."),
  );
void integration
  .start()
  .catch(() =>
    console.warn(
      "Provider startup incomplete; simulation remains available. Check /api/capabilities.",
    ),
  );
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    server.close();
    void integration.stop().finally(() => {
      engine.close();
      process.exit(0);
    });
  });
