const assert = require("node:assert/strict");
const http = require("node:http");
const { test } = require("node:test");

const {
  DEFAULT_MIRROR_PORT,
  checkMirrorEndpoint,
  mirrorArgv,
  takeMirrorFlags,
} = require("../dist/mirror.js");

test("without --mirror the mirror options are a mistake", () => {
  assert.equal(takeMirrorFlags(["github.com"]), null);
  assert.throws(() => takeMirrorFlags(["--port", "9222"]), /--port only applies to --mirror/);
  assert.throws(() => takeMirrorFlags(["--target", "abc"]), /--target only applies to --mirror/);
  assert.throws(() => takeMirrorFlags(["--new-tab"]), /--new-tab only applies to --mirror/);
});

test("--mirror takes the default port and leaves the rest of the arguments alone", () => {
  const args = ["--mirror", "--split", "right", "example.com"];
  const request = takeMirrorFlags(args);
  assert.deepEqual(request, { port: DEFAULT_MIRROR_PORT, target: null, newTab: false });
  assert.deepEqual(args, ["--split", "right", "example.com"]);
  assert.deepEqual(mirrorArgv(request), ["--mirror", "--mirror-port=9222"]);
});

test("a pinned tab and a fresh tab are two different asks", () => {
  assert.throws(
    () => takeMirrorFlags(["--mirror", "--target", "abc", "--new-tab"]),
    /only one of them/,
  );
  assert.deepEqual(mirrorArgv(takeMirrorFlags(["--mirror", "--target", "abc"])), [
    "--mirror",
    "--mirror-port=9222",
    "--mirror-target=abc",
  ]);
  assert.deepEqual(mirrorArgv(takeMirrorFlags(["--mirror", "--new-tab", "--port", "9333"])), [
    "--mirror",
    "--mirror-port=9333",
    "--mirror-new-tab",
  ]);
});

test("the flags we pass ourselves when opening a pane are read back, not doubled", () => {
  const args = ["--mirror", "--mirror-port=9333", "--mirror-target=page-7", "--split-dir=right"];
  const request = takeMirrorFlags(args);
  assert.deepEqual(request, { port: 9333, target: "page-7", newTab: false });
  assert.deepEqual(args, ["--split-dir=right"]);
  assert.deepEqual(mirrorArgv(request), [
    "--mirror",
    "--mirror-port=9333",
    "--mirror-target=page-7",
  ]);
});

test("a port has to be a port", () => {
  assert.throws(() => takeMirrorFlags(["--mirror", "--port", "nope"]), /invalid --port nope/);
  assert.throws(() => takeMirrorFlags(["--mirror", "--port", "0"]), /invalid --port 0/);
  assert.throws(() => takeMirrorFlags(["--mirror", "--port", "70000"]), /invalid --port/);
  assert.throws(() => takeMirrorFlags(["--mirror", "--port"]), /--port requires a value/);
});

test("mirroring is about a browser on this machine", () => {
  assert.throws(() => takeMirrorFlags(["--mirror", "--ssh=me@box"]), /cannot use --ssh/);
  assert.throws(() => takeMirrorFlags(["--mirror", "--app-mode"]), /cannot use --app-mode/);
});

test("a port with nothing behind it explains how to open one", async () => {
  await assert.rejects(checkMirrorEndpoint({ port: 9, target: null, newTab: false }), (error) => {
    assert.match(error.message, /nothing is listening for debugging on http:\/\/127\.0\.0\.1:9/);
    assert.match(error.message, /--remote-debugging-port=9/);
    return true;
  });
});

test("a tab that is not there lists the ones that are", async () => {
  const targets = [
    { id: "page-1", type: "page", title: "one", url: "https://example.com" },
    { id: "worker", type: "service_worker", title: "", url: "https://example.com/sw.js" },
  ];
  const server = http.createServer((request, response) => {
    const body = request.url === "/json/version" ? { Browser: "Chrome/1" } : targets;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    await checkMirrorEndpoint({ port, target: null, newTab: false });
    await checkMirrorEndpoint({ port, target: "page-1", newTab: false });
    await assert.rejects(
      checkMirrorEndpoint({ port, target: "gone", newTab: false }),
      (error) => {
        assert.match(error.message, /no tab gone/);
        assert.match(error.message, /page-1/);
        assert.doesNotMatch(error.message, /worker/, "only tabs can be mirrored");
        return true;
      },
    );
    await assert.rejects(
      checkMirrorEndpoint({ port, target: "worker", newTab: false }),
      /service_worker, not a tab/,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
