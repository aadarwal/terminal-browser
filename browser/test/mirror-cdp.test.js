const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  CONSENT_TIMEOUT_MS,
  CdpConnection,
  endpointLabel,
  endpointOf,
  leaseConnection,
  listTargets,
  parseEndpoint,
  pickTarget,
} = require("../dist/mirror/cdp.js");
const { fakeBrowser } = require("./fake-devtools.js");

test("an endpoint can be a port, a host and port, or a url", () => {
  assert.deepEqual(parseEndpoint("9222"), { host: "127.0.0.1", port: 9222, socketUrl: null });
  assert.equal(endpointLabel(parseEndpoint("localhost:9333")), "http://127.0.0.1:9333");
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
  const closed = new Promise((resolve) => connection.onClosed(resolve));
  const pending = connection.send("Page.navigate", { url: "https://example.com" });
  browser.drop();
  await closed;
  await assert.rejects(pending, /closed|reset|socket/i);
  await browser.close();
});

test("an exact browser websocket is an endpoint of its own", () => {
  const endpoint = parseEndpoint("ws://localhost:18744/devtools/browser/91D9-46");
  assert.deepEqual(endpoint, {
    host: "127.0.0.1",
    port: 18744,
    socketUrl: "ws://127.0.0.1:18744/devtools/browser/91D9-46",
  });
  assert.equal(endpointLabel(endpoint), "ws://127.0.0.1:18744/devtools/browser/91D9-46");
  assert.equal(endpointLabel(endpointOf(9222)), "http://127.0.0.1:9222");
  assert.throws(() => parseEndpoint("ws://127.0.0.1:18744/devtools/page/x"), /browser websocket/);
  assert.throws(() => parseEndpoint("wss://127.0.0.1:18744/devtools/browser/a"), /ws:\/\/ or http:\/\//);
  assert.throws(() => parseEndpoint("https://127.0.0.1:9222"), /ws:\/\/ or http:\/\//);
  assert.throws(() => parseEndpoint("ws://127.0.0.1:18744/devtools/browser/a?x=1"), /more than/);
});

test("a browser that serves no http is attached to directly", async () => {
  const browser = await fakeBrowser({ approvalOnly: true });
  const connection = await CdpConnection.open(parseEndpoint(browser.socketUrl));
  assert.deepEqual(browser.asked, [], "no http request, so no second permission prompt");

  const targets = await connection.targets();
  assert.deepEqual(
    targets.map((target) => target.id),
    ["page-1", "worker"],
  );
  assert.equal(pickTarget(targets, null).id, "page-1");
  assert.equal(pickTarget(targets, "page-1").url, "https://example.com");
  assert.deepEqual(
    browser.received.map((request) => request.method),
    ["Target.getTargets"],
  );
  connection.close();
  await browser.close();
});

test("a browser that turns us down says so at once, not after the long wait", async () => {
  const browser = await fakeBrowser({ approvalOnly: true, consent: "deny" });
  const started = Date.now();
  await assert.rejects(
    CdpConnection.open(parseEndpoint(browser.socketUrl), 30_000),
    (error) => {
      assert.match(error.message, /turned down/);
      assert.doesNotMatch(error.message, /--remote-debugging-port/, "it was there, it said no");
      return true;
    },
  );
  assert.ok(Date.now() - started < 3000, "a refusal is an answer, so there is nothing to wait for");
  await browser.close();
});

test("a permission prompt nobody answers gives up with advice, after a long wait", async () => {
  const browser = await fakeBrowser({ approvalOnly: true, consent: "hang" });
  await assert.rejects(CdpConnection.open(parseEndpoint(browser.socketUrl), 250), (error) => {
    assert.match(error.message, /did not let us in within/);
    assert.match(error.message, /permission prompt/);
    return true;
  });
  assert.equal(CONSENT_TIMEOUT_MS, 60_000, "a human needs longer than a network timeout");
  await browser.close();
});

test("panes on one browser share a connection, so it only asks once", async () => {
  const browser = await fakeBrowser({ approvalOnly: true });
  const endpoint = parseEndpoint(browser.socketUrl);
  const first = await leaseConnection(endpoint);
  const second = await leaseConnection(endpoint);
  assert.equal(first.connection, second.connection, "one connection feeds both panes");
  assert.equal(browser.upgrades(), 1, "the browser was only asked once");

  first.release();
  await second.connection.send("Target.getTargets");
  assert.ok(browser.received.length >= 1, "letting one pane go leaves the other working");

  second.release();
  await assert.rejects(second.connection.send("Target.getTargets"), /closed/);

  const third = await leaseConnection(endpoint);
  assert.notEqual(third.connection, first.connection, "the next pane opens a fresh connection");
  assert.equal(browser.upgrades(), 2);
  third.release();
  await browser.close();
});

test("everything sharing a connection hears it end", async () => {
  const browser = await fakeBrowser({ approvalOnly: true });
  const lease = await leaseConnection(parseEndpoint(browser.socketUrl));
  const heard = [];
  lease.connection.onClosed(() => heard.push("a"));
  lease.connection.onClosed(() => heard.push("b"));
  browser.drop();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(heard, ["a", "b"]);
  lease.release();
  await browser.close();
});
