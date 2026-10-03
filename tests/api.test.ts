import test from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../server/engine.js";
import { createApp } from "../server/app.js";
test("HTTP and SSE privacy, explicitlocalgodsession, origin-independent mutations, approval revision", async () => {
  const e = new Engine(":memory:", 0),
    r = e.create({}, false);
  await e.execute(r.id);
  let probeCalls = 0;
  const server = createApp(e, {
    probeProviders: async () => {
      probeCalls++;
      return { ok: true, modelCalls: 0 };
    },
  }).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  try {
    for (const path of [
      "/.env",
      "/server/fixtures.ts",
      "/server%2Ffixtures.ts?raw",
      "/data/produce.sqlite",
      "/tests/api.test.ts",
      "/@fs/server/fixtures.ts",
    ])
      assert.equal((await fetch(`${base}${path}`)).status, 404);
    assert.equal((await fetch(`${base}/api/runs/${r.id}/god`)).status, 403);
    assert.equal(
      (await fetch(`${base}/api/runs/${r.id}/god/events`)).status,
      403,
    );
    assert.equal(
      (await fetch(`${base}/api/providers/probe`, { method: "POST" })).status,
      403,
    );
    assert.equal(probeCalls, 0);
    const publicResponse = await fetch(`${base}/api/runs/${r.id}`);
    assert.equal(publicResponse.status, 200);
    const body = await publicResponse.text();
    for (const field of [
      "floorCaseCents",
      "targetCaseCents",
      "privateSuppliers",
    ])
      assert.ok(!body.includes(field));
    const controller = new AbortController();
    const stream = await fetch(`${base}/api/runs/${r.id}/events`, {
      signal: controller.signal,
    });
    const reader = stream.body!.getReader();
    const first = await reader.read();
    const event = new TextDecoder().decode(first.value);
    assert.match(event, /event: snapshot/);
    assert.ok(!event.includes("floorCaseCents"));
    assert.ok(!event.includes("targetCaseCents"));
    controller.abort();
    const crossOrigin = await fetch(`${base}/api/session/god`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://other-client.example",
      },
      body: '{"enabled":true}',
    });
    assert.equal(crossOrigin.status, 200);
    const login = await fetch(`${base}/api/session/god`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"enabled":true}',
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    assert.equal(
      (
        await fetch(`${base}/api/providers/probe`, {
          method: "POST",
          headers: { cookie },
        })
      ).status,
      200,
    );
    assert.equal(probeCalls, 1);
    assert.equal(
      (
        await fetch(`${base}/api/providers/probe`, {
          method: "POST",
          headers: { cookie, origin: "https://other-client.example" },
        })
      ).status,
      200,
    );
    assert.equal(probeCalls, 2);
    const god = await fetch(`${base}/api/runs/${r.id}/god`, {
      headers: { cookie },
    });
    assert.equal(god.status, 200);
    assert.ok((await god.text()).includes("floorCaseCents"));
    const privateStream = await fetch(`${base}/api/runs/${r.id}/god/events`, {
      headers: { cookie },
    });
    const privateReader = privateStream.body!.getReader();
    let privateSnapshot = "";
    while (!privateSnapshot.includes("\n\n"))
      privateSnapshot += new TextDecoder().decode(
        (await privateReader.read()).value,
      );
    assert.match(privateSnapshot, /floorCaseCents/);
    await fetch(`${base}/api/session/god`, {
      method: "DELETE",
      headers: { cookie },
    });
    const streamEnded = await Promise.race([
      privateReader.read(),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Revoked god stream stayed open")),
          1000,
        );
        timer.unref();
      }),
    ]);
    assert.equal(
      streamEnded.done,
      true,
      "Revocation closes existing private streams immediately",
    );
    assert.equal(
      (await fetch(`${base}/api/runs/${r.id}/god`, { headers: { cookie } }))
        .status,
      403,
    );
    const stale = await fetch(`${base}/api/runs/${r.id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"revision":999}',
    });
    assert.equal(stale.status, 409);
    const approve = await fetch(`${base}/api/runs/${r.id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: e.snapshot(r.id).promotionRevision }),
    });
    assert.equal(approve.status, 200);
    assert.equal(
      ((await approve.json()) as { status: string }).status,
      "flyer_ready",
    );
    const blockedLive = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"mode":"live"}',
    });
    assert.equal(blockedLive.status, 409);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    e.close();
  }
});

test("god session expiration is enforced server-side for retained cookies and open streams", async () => {
  const e = new Engine(":memory:", 0),
    run = e.create({}, false);
  let time = Date.now();
  const server = createApp(e, { now: () => time }).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const login = await fetch(base + "/api/session/god", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"enabled":true}',
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const stream = await fetch(`${base}/api/runs/${run.id}/god/events`, {
      headers: { cookie },
    });
    const reader = stream.body!.getReader();
    let frame = "";
    while (!frame.includes("\n\n"))
      frame += new TextDecoder().decode((await reader.read()).value);
    time += 4 * 60 * 60 * 1000 + 1;
    assert.equal(
      (await fetch(`${base}/api/runs/${run.id}/god`, { headers: { cookie } }))
        .status,
      403,
    );
    assert.equal((await reader.read()).done, true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    e.close();
  }
});
