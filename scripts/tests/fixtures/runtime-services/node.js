const http = require("node:http");

let count = 0;
http.createServer((request, response) => {
  const current = ++count;
  const chunks = [];
  let length = 0;
  let rejected = false;
  const send = (status, value) => {
    const payload = Buffer.from(JSON.stringify(value), "utf8");
    response.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": payload.length,
      "Connection": "close",
    });
    response.end(payload);
  };
  request.on("data", (chunk) => {
    if (rejected) return;
    length += chunk.length;
    if (length > 65536) {
      rejected = true;
      chunks.length = 0;
      send(413, { error: "Body too large" });
      return;
    }
    chunks.push(chunk);
  });
  request.on("end", () => {
    if (rejected) return;
    send(200, {
      family: "node", method: request.method, path: request.url,
      body: Buffer.concat(chunks).toString("utf8"), count: current,
    });
  });
  request.on("error", () => {
    if (!response.headersSent) send(400, { error: "Cannot read body" });
  });
}).listen(Number(process.argv[2] || 8080), "0.0.0.0");
