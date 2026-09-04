const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  DEFAULT_MIRROR_PORT,
  checkHttpEndpoint,
  isSocketEndpoint,
  mirrorArgv,
  parseEndpointArg,
  resolveMirror,
  takeMirrorFlags,
} = require("../dist/mirror.js");

const alive = () => Promise.resolve(true);
const dead = () => Promise.resolve(false);
const noHttpCheck = async () => {};

function profile(id, contents) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-options-"));
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "DevToolsActivePort"), contents);
  return { id, name: id, roots: [dir], dir };
}

test("without --mirror the mirror options are a mistake", () => {
  assert.equal(takeMirrorFlags(["github.com"]), null);
  assert.throws(() => takeMirrorFlags(["--port", "9222"]), /--port only applies to --mirror/);
  assert.throws(() => takeMirrorFlags(["--browser", "helium"]), /--browser only applies to --mirror/);
  assert.throws(() => takeMirrorFlags(["--cdp", "9222"]), /--cdp only applies to --mirror/);
  assert.throws(
    () => takeMirrorFlags(["--user-data-dir", "/tmp/x"]),
    /--user-data-dir only applies to --mirror/,
  );
  assert.throws(() => takeMirrorFlags(["--new-tab"]), /--new-tab only applies to --mirror/);
});

test("plain --mirror asks for no endpoint at all, and leaves other arguments alone", () => {
  const args = ["--mirror", "--split", "right", "example.com"];
  assert.deepEqual(takeMirrorFlags(args), {
    endpoint: null,
    browser: null,
    userDataDir: null,
    target: null,
    newTab: false,
  });
  assert.deepEqual(args, ["--split", "right", "example.com"]);
});

test("two ways of picking a browser is one too many", () => {
  assert.throws(
    () => takeMirrorFlags(["--mirror", "--browser", "helium", "--port", "9222"]),
    /pick different browsers/,
  );
  assert.throws(
    () => takeMirrorFlags(["--mirror", "--cdp", "9222", "--user-data-dir", "/tmp/x"]),
    /pick different browsers/,
  );
  assert.throws(
    () => takeMirrorFlags(["--mirror", "--target", "abc", "--new-tab"]),
    /only one of them/,
  );
  assert.throws(() => takeMirrorFlags(["--mirror", "--browser", "safari"]), /unknown --browser/);
});

test("an endpoint is a browser websocket or a loopback http address", () => {
  assert.equal(parseEndpointArg("9222", "--cdp"), "http://127.0.0.1:9222");
  assert.equal(parseEndpointArg("http://localhost:9333", "--cdp"), "http://127.0.0.1:9333");
  assert.equal(
    parseEndpointArg("ws://127.0.0.1:18744/devtools/browser/91D9-46", "--cdp"),
    "ws://127.0.0.1:18744/devtools/browser/91D9-46",
  );
  assert.throws(() => parseEndpointArg("ws://127.0.0.1:18744/devtools/page/x", "--cdp"), /devtools\/browser/);
  assert.throws(() => parseEndpointArg("http://example.com:9222", "--cdp"), /this machine/);
  assert.throws(() => parseEndpointArg("nonsense", "--cdp"), /invalid --cdp/);
  assert.throws(() => parseEndpointArg("0", "--port"), /invalid --port 0/);
  assert.throws(() => parseEndpointArg("70000", "--port"), /invalid --port/);
});

test("an endpoint we cannot speak is refused rather than quietly rewritten", () => {
  // a wss url used to come back as ws, which would have dropped the encryption without saying so
  assert.throws(() => parseEndpointArg("wss://127.0.0.1:18744/devtools/browser/a", "--cdp"), /not wss/);
  assert.throws(() => parseEndpointArg("https://127.0.0.1:9222", "--cdp"), /not https/);
  assert.throws(() => parseEndpointArg("ftp://127.0.0.1:9222", "--cdp"), /invalid --cdp/);
  assert.throws(() => parseEndpointArg("http://user:pw@127.0.0.1:9222", "--cdp"), /no sign in/);
  assert.throws(
    () => parseEndpointArg("ws://127.0.0.1:18744/devtools/browser/a?x=1", "--cdp"),
    /nothing after the path/,
  );
  assert.throws(
    () => parseEndpointArg("ws://127.0.0.1:18744/devtools/browser/a#x", "--cdp"),
    /nothing after the path/,
  );
  assert.throws(() => parseEndpointArg("http://[::1]:9222", "--cdp"), /ipv6/);
  assert.throws(() => parseEndpointArg("http://127.0.0.1:9222/json", "--cdp"), /invalid --cdp/);
});

test("mirroring is about a browser on this machine", () => {
  assert.throws(() => takeMirrorFlags(["--mirror", "--ssh=me@box"]), /cannot use --ssh/);
  assert.throws(() => takeMirrorFlags(["--mirror", "--app-mode"]), /cannot use --app-mode/);
});

test("the flags we pass ourselves when opening a pane are read back, not doubled", () => {
  const endpoint = "ws://127.0.0.1:18744/devtools/browser/91D9-46";
  const args = ["--mirror", `--mirror-cdp=${endpoint}`, "--mirror-target=page-7", "--split-dir=right"];
  const asked = takeMirrorFlags(args);
  assert.deepEqual(asked, {
    endpoint,
    browser: null,
    userDataDir: null,
    target: "page-7",
    newTab: false,
  });
  assert.deepEqual(args, ["--split-dir=right"]);
  assert.deepEqual(mirrorArgv({ endpoint, target: "page-7", newTab: false }), [
    "--mirror",
    `--mirror-cdp=${endpoint}`,
    "--mirror-target=page-7",
  ]);
});

test("a pane that reopens keeps the browser it was already attached to", async () => {
  const endpoint = "ws://127.0.0.1:18744/devtools/browser/91D9-46";
  const args = ["--mirror", `--mirror-cdp=${endpoint}`, "--split-dir=right"];
  const asked = takeMirrorFlags(args);
  const knocked = [];
  const plan = await resolveMirror(asked, {
    live: (port) => {
      knocked.push(port);
      return Promise.resolve(true);
    },
    check: () => {
      throw new Error("an approval endpoint must never be asked for http");
    },
  });
  assert.deepEqual(plan, { endpoint, target: null, newTab: false });
  assert.deepEqual(knocked, [18744], "only a tcp knock, so the browser does not ask again");
  assert.deepEqual(mirrorArgv(plan), ["--mirror", `--mirror-cdp=${endpoint}`]);
});

test("a browser that stopped sharing says how to turn it back on", async () => {
  const endpoint = "ws://127.0.0.1:18744/devtools/browser/91D9-46";
  await assert.rejects(resolveMirror({ ...takeMirrorFlags(["--mirror", `--mirror-cdp=${endpoint}`]) }, {
    live: dead,
    check: noHttpCheck,
  }), (error) => {
    assert.match(error.message, /nothing is listening on ws:\/\/127\.0\.0\.1:18744/);
    assert.match(error.message, /chrome:\/\/inspect\/#remote-debugging/);
    return true;
  });
});

test("the browser that is sharing a tab is found without being named", async () => {
  const helium = profile("helium", "18744\n/devtools/browser/aaa\n");
  const plan = await resolveMirror(takeMirrorFlags(["--mirror"]), {
    kinds: [helium],
    live: alive,
    check: noHttpCheck,
  });
  assert.equal(plan.endpoint, "ws://127.0.0.1:18744/devtools/browser/aaa");
});

test("several browsers sharing at once ask which one, rather than picking", async () => {
  const kinds = [
    profile("helium", "18744\n/devtools/browser/aaa\n"),
    profile("chrome", "9222\n/devtools/browser/bbb\n"),
  ];
  await assert.rejects(resolveMirror(takeMirrorFlags(["--mirror"]), { kinds, live: alive }), (error) => {
    assert.match(error.message, /several browsers are sharing a tab/);
    assert.match(error.message, /--browser helium/);
    assert.match(error.message, /--browser chrome/);
    return true;
  });
  const plan = await resolveMirror(takeMirrorFlags(["--mirror", "--browser", "chrome"]), {
    kinds,
    live: alive,
  });
  assert.equal(plan.endpoint, "ws://127.0.0.1:9222/devtools/browser/bbb");
});

test("naming a browser that is not sharing never falls back to another one", async () => {
  const kinds = [profile("helium", "18744\n/devtools/browser/aaa\n"), { id: "chrome", name: "Chrome", roots: ["/nope"] }];
  await assert.rejects(
    resolveMirror(takeMirrorFlags(["--mirror", "--browser", "chrome"]), {
      kinds,
      live: alive,
      check: () => {
        throw new Error("a named browser must not fall back to a port");
      },
    }),
    /Chrome is not sharing a tab/,
  );
});

test("a profile directory is mirrored by name", async () => {
  const work = profile("work", "18745\n/devtools/browser/ccc\n");
  const plan = await resolveMirror(
    takeMirrorFlags(["--mirror", "--user-data-dir", work.dir]),
    { live: alive },
  );
  assert.equal(plan.endpoint, "ws://127.0.0.1:18745/devtools/browser/ccc");
  await assert.rejects(
    resolveMirror(takeMirrorFlags(["--mirror", "--user-data-dir", path.join(work.dir, "gone")]), {
      live: alive,
    }),
    /no browser is sharing a tab from/,
  );
});

test("with nothing sharing, a browser started the old way is still found on 9222", async () => {
  const checked = [];
  const plan = await resolveMirror(takeMirrorFlags(["--mirror"]), {
    kinds: [],
    live: (port) => Promise.resolve(port === DEFAULT_MIRROR_PORT),
    check: (endpoint) => {
      checked.push(endpoint);
      return Promise.resolve();
    },
  });
  assert.equal(plan.endpoint, "http://127.0.0.1:9222");
  assert.deepEqual(checked, ["http://127.0.0.1:9222"], "an http endpoint is still asked first");
  assert.equal(isSocketEndpoint(plan.endpoint), false);

  await assert.rejects(
    resolveMirror(takeMirrorFlags(["--mirror"]), { kinds: [], live: dead, check: noHttpCheck }),
    (error) => {
      assert.match(error.message, /no browser is sharing a tab yet/);
      assert.match(error.message, /chrome:\/\/inspect\/#remote-debugging/);
      assert.match(error.message, /--remote-debugging-port=9222/);
      return true;
    },
  );
});

test("an http endpoint is still checked, and an unknown tab lists the ones there are", async () => {
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
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  try {
    await checkHttpEndpoint(endpoint, null);
    await checkHttpEndpoint(endpoint, "page-1");
    await assert.rejects(checkHttpEndpoint(endpoint, "gone"), (error) => {
      assert.match(error.message, /no tab gone/);
      assert.match(error.message, /page-1/);
      assert.doesNotMatch(error.message, /worker/, "only tabs can be mirrored");
      return true;
    });
    await assert.rejects(checkHttpEndpoint(endpoint, "worker"), /service_worker, not a tab/);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await assert.rejects(checkHttpEndpoint("http://127.0.0.1:9", null), (error) => {
    assert.match(error.message, /nothing is listening for debugging/);
    assert.match(error.message, /chrome:\/\/inspect\/#remote-debugging/);
    return true;
  });
});
