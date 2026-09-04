const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  CdpConnection,
  endpointOf,
  listTargets,
  parseEndpoint,
  pickTarget,
} = require("../dist/mirror/cdp.js");
const { fakeBrowser } = require("./fake-devtools.js");

test("an endpoint can be a port, a host and port, or a url", () => {
  assert.deepEqual(parseEndpoint("9222"), {
    host: "127.0.0.1",
    port: 9222,
    origin: "http://127.0.0.1:9222",
  });
  assert.equal(parseEndpoint("localhost:9333").origin, "http://127.0.0.1:9333");
  assert.equal(parseEndpoint("http://127.0.0.1:9444").port, 9444);
  assert.throws(() => parseEndpoint(""), /looks like/);
  assert.throws(() => parseEndpoint("127.0.0.1:0"), /port/);
  assert.throws(() => parseEndpoint("127.0.0.1:99999"), /not a debugging endpoint/);
});

test("a pinned tab is taken exactly, never by url", () => {
  const targets = [
    { id: "a", type: "page", title: "", url: "https://example.com" },
    { id: "b", type: "page", title: "", url: "https://example.com" },
    { id: "worker", type: "service_worker", title: "", url: "https://example.com/sw.js" },
  ];
  assert.equal(pickTarget(targets, "b").id, "b");
  assert.equal(pickTarget(targets, null).id, "a");
  assert.throws(() => pickTarget(targets, "missing"), /no tab missing/);
  assert.throws(() => pickTarget(targets, "worker"), /service_worker, not a tab/);
  assert.throws(() => pickTarget([], null), /no tab open to mirror/);
});

test("devtools windows are not something to mirror", () => {
  const targets = [
    { id: "devtools", type: "page", title: "", url: "devtools://devtools/bundled.html" },
    { id: "real", type: "page", title: "", url: "https://example.com" },
  ];
  assert.equal(pickTarget(targets, null).id, "real");
});

test("a port with nothing behind it says so, with the flag to fix it", async () => {
  const endpoint = parseEndpoint("9");
  await assert.rejects(listTargets(endpoint), (error) => {
    assert.match(error.message, /nothing is listening for debugging on http:\/\/127\.0\.0\.1:9/);
    assert.match(error.message, /--remote-debugging-port=9/);
    return true;
  });
});

test("we talk to a tab through the browser we attached to", async () => {
  const browser = await fakeBrowser();
  const endpoint = endpointOf(browser.port);
  const connection = await CdpConnection.open(endpoint);
  const attached = await connection.send("Target.attachToTarget", {
    targetId: "page-1",
    flatten: true,
  });
  assert.equal(attached.sessionId, "session-1");

  const seen = [];
  connection.on("session-1", "Page.screencastFrame", (params) => seen.push(params));
  connection.on("other-session", "Page.screencastFrame", () => {
    throw new Error("another mirror's session must not see our frames");
  });
  browser.send({
    method: "Page.screencastFrame",
    sessionId: "session-1",
    params: { data: "AAA", sessionId: 7 },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(seen, [{ data: "AAA", sessionId: 7 }]);

  await assert.rejects(connection.send("Boom.throw"), /no such method/);
  assert.deepEqual(
    browser.received.map((request) => request.method),
    ["Target.attachToTarget", "Boom.throw"],
  );
  connection.close();
  await browser.close();
});

test("a browser that goes away closes the connection and fails what was in flight", async () => {
  const browser = await fakeBrowser({ answer: () => null });
  const endpoint = endpointOf(browser.port);
  const connection = await CdpConnection.open(endpoint);
  const closed = new Promise((resolve) => {
    connection.onClose = resolve;
  });
  const pending = connection.send("Page.navigate", { url: "https://example.com" });
  browser.drop();
  await closed;
  await assert.rejects(pending, /closed|reset|socket/i);
  await browser.close();
});
