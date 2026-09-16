#!/usr/bin/env node
// GIT_ASKPASS / SSH_ASKPASS forwarder for the git-scm extension. git and
// ssh exec this directly (it must be a bare, argument-less executable path
// — "node <path>" fails with "cannot exec") with the prompt text as
// argv[2]. All policy — prompt classification, the credential cache, user
// interaction — lives in server.js's relay; this just ships the prompt
// over the relay's unix socket and prints whatever answer comes back.
// Exit 1 with nothing on stdout tells git/ssh to abort the operation.
const http = require("node:http");

const socketPath = process.env.GIT_SCM_RELAY_SOCKET;
const token = process.env.GIT_SCM_RELAY_TOKEN;
const op = process.env.GIT_SCM_OP_ID;
const prompt = process.argv[2] || "";

if (!socketPath || !token || !op) process.exit(1);

const body = JSON.stringify({ token, op, prompt });
const req = http.request(
  {
    socketPath,
    method: "POST",
    path: "/ask",
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
  },
  (res) => {
    let data = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => (data += chunk));
    res.on("end", () => {
      if (res.statusCode === 200) {
        process.stdout.write(`${data}\n`);
        process.exit(0);
      }
      process.exit(1);
    });
  },
);
req.on("error", () => process.exit(1));
// No timeout here: the relay enforces prompt expiry itself and either
// answers or closes the connection — a second timer racing it adds nothing.
req.end(body);
