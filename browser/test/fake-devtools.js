// A stand in for a browser started with debugging on, so the mirror can be exercised without
// one. Only the server half of the websocket framing lives here.
const crypto = require("node:crypto");
const http = require("node:http");

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function serverFrame(payload) {
  const body = Buffer.from(payload, "utf8");
  const header =
    body.length < 126
      ? Buffer.from([0x81, body.length])
      : body.length < 65536
        ? Buffer.concat([Buffer.from([0x81, 126]), sized(2, body.length)])
        : Buffer.concat([Buffer.from([0x81, 127]), sized(8, body.length)]);
  return Buffer.concat([header, body]);
}

function sized(bytes, value) {
  const out = Buffer.alloc(bytes);
  if (bytes === 2) out.writeUInt16BE(value);
  else out.writeBigUInt64BE(BigInt(value));
  return out;
}

/** reads the masked frames a client sends, one message at a time */
function clientMessages(buffer) {
  const messages = [];
  let closed = false;
  let rest = buffer;
  for (;;) {
    if (rest.length < 2) break;
    const opcode = rest[0] & 0x0f;
    const masked = (rest[1] & 0x80) !== 0;
    const short = rest[1] & 0x7f;
    let at = 2;
    let length = short;
    if (short === 126) {
      if (rest.length < 4) break;
      length = rest.readUInt16BE(2);
      at = 4;
    } else if (short === 127) {
      if (rest.length < 10) break;
      length = Number(rest.readBigUInt64BE(2));
      at = 10;
    }
    const mask = masked ? rest.subarray(at, at + 4) : null;
    if (masked) at += 4;
    if (rest.length < at + length) break;
    const payload = Buffer.from(rest.subarray(at, at + length));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    rest = rest.subarray(at + length);
    if (opcode === 0x1) messages.push(payload.toString("utf8"));
    if (opcode === 0x8) closed = true;
  }
  return { messages, rest, closed };
}

async function fakeBrowser(options = {}) {
  const targets = options.targets ?? [
    { id: "page-1", type: "page", title: "one", url: "https://example.com" },
  ];
  const received = [];
  const asked = [];
  const sockets = [];
  let upgrades = 0;
  const server = http.createServer((request, response) => {
    asked.push(request.url);
    // a browser that asks its human for permission serves the socket and nothing else
    if (options.approvalOnly) {
      response.writeHead(404);
      response.end();
      return;
    }
    const body =
      request.url === "/json/version"
        ? { webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/fake` }
        : targets;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  server.on("upgrade", (request, socket) => {
    upgrades += 1;
    sockets.push(socket);
    socket.on("error", () => {});
    if (options.consent === "deny") {
      socket.destroy();
      return;
    }
    // a prompt nobody answers leaves the handshake unanswered
    if (options.consent === "hang") return;
    const accept = crypto
      .createHash("sha1")
      .update(`${request.headers["sec-websocket-key"]}${GUID}`)
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      const read = clientMessages(Buffer.concat([pending, chunk]));
      pending = read.rest;
      for (const text of read.messages) {
        const message = JSON.parse(text);
        received.push(message);
        const reply = (options.answer ?? defaultAnswer)(message);
        if (reply) write(socket, reply);
      }
      if (read.closed) socket.destroy();
    });
  });
  const write = (socket, value) => {
    if (!socket.destroyed) socket.write(serverFrame(JSON.stringify(value)));
  };
  const latest = () => sockets.filter((socket) => !socket.destroyed).at(-1);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    socketUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/fake`,
    targets,
    received,
    asked,
    upgrades: () => upgrades,
    send: (value) => write(latest(), value),
    drop: () => latest()?.destroy(),
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

function defaultAnswer(request) {
  if (request.method === "Target.attachToTarget") {
    return { id: request.id, result: { sessionId: "session-1" } };
  }
  if (request.method === "Target.getTargets") {
    return {
      id: request.id,
      result: {
        targetInfos: [
          { targetId: "page-1", type: "page", title: "one", url: "https://example.com" },
          { targetId: "worker", type: "service_worker", title: "", url: "https://example.com/sw" },
        ],
      },
    };
  }
  if (request.method === "Boom.throw") {
    return { id: request.id, error: { message: "no such method" } };
  }
  return { id: request.id, result: {} };
}

module.exports = { fakeBrowser };
