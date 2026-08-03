#!/usr/bin/env node

// One-time interactive OAuth helper for connecting a specific YouTube channel.
// It never prints OAuth credentials or tokens. After Google consent it verifies
// the live channel identity and waits for an explicit CONFIRM before installing
// the credentials as GitHub Actions secrets.

import http from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chmod, readFile, writeFile } from "node:fs/promises";

const HERE = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(HERE, ".env")); } catch {}

const REPOSITORY = process.env.PLOTRECKON_GITHUB_REPO || "dreamkid5/plotreckon-stories";
const CLIENT_ID = process.env.YT_CLIENT_ID || "";
const CLIENT_SECRET = process.env.YT_CLIENT_SECRET || "";
const PRIVACY = ["private", "unlisted", "public"].includes(process.env.CF_YT_PRIVACY)
  ? process.env.CF_YT_PRIVACY
  : "private";
const SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly"
];

if (!CLIENT_ID || !CLIENT_SECRET) {
  throw new Error("YT_CLIENT_ID and YT_CLIENT_SECRET must be configured in worker/.env");
}

let pending = null;
const state = randomBytes(24).toString("hex");

function runWithInput(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let error = "";
    child.stdout.resume();
    child.stderr.on("data", (chunk) => { error += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0
      ? resolve()
      : reject(new Error(command + " exited " + code + ": " + error.slice(-300))));
    child.stdin.end(input);
  });
}

async function installSecrets(bundle) {
  const entries = [
    ["YT_CLIENT_ID", CLIENT_ID],
    ["YT_CLIENT_SECRET", CLIENT_SECRET],
    ["YT_REFRESH_TOKEN", bundle.refreshToken]
  ];
  for (const [name, value] of entries) {
    await runWithInput("gh", ["secret", "set", name, "--repo", REPOSITORY], value);
  }
  await runWithInput("gh", ["variable", "set", "CF_YT_PRIVACY", "--repo", REPOSITORY], PRIVACY);

  const envPath = path.join(HERE, ".env");
  let envText = "";
  try { envText = await readFile(envPath, "utf8"); } catch {}
  for (const [name, value] of entries) {
    const line = `${name}=${String(value).replace(/[\r\n]/g, "")}`;
    const pattern = new RegExp(`^${name}=.*$`, "m");
    envText = pattern.test(envText)
      ? envText.replace(pattern, line)
      : envText.replace(/\s*$/, "\n") + line + "\n";
  }
  await writeFile(envPath, envText.replace(/^\n/, ""), { mode: 0o600 });
  await chmod(envPath, 0o600);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  if (url.pathname !== "/oauth/callback") {
    response.writeHead(404).end("Not found");
    return;
  }
  try {
    if (url.searchParams.get("state") !== state) throw new Error("OAuth state did not match");
    if (url.searchParams.get("error")) throw new Error("Google consent returned: " + url.searchParams.get("error"));
    const code = url.searchParams.get("code");
    if (!code) throw new Error("Google did not return an authorization code");

    const address = server.address();
    const redirectUri = `http://127.0.0.1:${address.port}/oauth/callback`;
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri
      })
    });
    const tokens = await tokenResponse.json();
    if (!tokenResponse.ok) throw new Error("Token exchange failed: " + (tokens.error_description || tokens.error || tokenResponse.status));
    if (!tokens.refresh_token) throw new Error("Google did not return a refresh token; repeat consent with prompt=consent");

    const channelResponse = await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", {
      headers: { authorization: "Bearer " + tokens.access_token }
    });
    const channelData = await channelResponse.json();
    if (!channelResponse.ok) throw new Error("Channel verification failed: " + (channelData.error?.message || channelResponse.status));
    const channels = channelData.items || [];
    if (channels.length !== 1) throw new Error("Expected exactly one YouTube channel, found " + channels.length);
    const channel = channels[0];
    pending = {
      refreshToken: tokens.refresh_token,
      channel: {
        title: channel.snippet?.title || "Unknown",
        handle: channel.snippet?.customUrl || null,
        channelId: channel.id
      }
    };

    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>YouTube verified</title><style>body{font:18px system-ui;max-width:720px;margin:80px auto;padding:24px}strong{font-size:28px}</style><strong>YouTube channel verified</strong><p>${pending.channel.title}</p><p>You can return to Codex now.</p>`);
    console.log("CHANNEL_JSON=" + JSON.stringify(pending.channel));
    console.log("Type CONFIRM to install this channel in GitHub, or CANCEL to stop.");
  } catch (error) {
    response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    response.end(String(error.message));
    console.error("OAuth callback failed: " + error.message);
  }
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  const redirectUri = `http://127.0.0.1:${address.port}/oauth/callback`;
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.search = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent select_account",
    include_granted_scopes: "true",
    state
  }).toString();
  console.log("AUTH_URL=" + authUrl.toString());
  console.log("Complete Google consent in the browser. No token will be printed.");
});

process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  const command = chunk.trim().toUpperCase();
  if (command === "CANCEL") {
    console.log("Connection cancelled; no GitHub secrets changed.");
    server.close(() => process.exit(0));
    return;
  }
  if (command !== "CONFIRM") return;
  if (!pending) {
    console.log("No verified channel is waiting for confirmation.");
    return;
  }
  try {
    await installSecrets(pending);
    console.log("CONNECTED_JSON=" + JSON.stringify(pending.channel));
    pending.refreshToken = "";
    server.close(() => process.exit(0));
  } catch (error) {
    console.error("GitHub secret installation failed: " + error.message);
  }
});
