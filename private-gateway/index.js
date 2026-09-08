#!/usr/bin/env node

import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

const port = Number(process.env.AI_GATEWAY_PORT || 8787);
const host = process.env.AI_GATEWAY_HOST || "127.0.0.1";
const apiFormat = String(process.env.AI_UPSTREAM_API_FORMAT || "openai").toLowerCase() === "gemini" ? "gemini" : "openai";
const allowClientKeys = String(process.env.AI_ALLOW_CLIENT_KEYS || "false").toLowerCase() === "true";
const allowedOrigins = String(process.env.AI_CORS_ORIGIN || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

function upstreamBaseUrl() {
    const value = String(process.env.AI_UPSTREAM_BASE_URL || "").trim();
    if (!value) return null;
    try {
        const url = new URL(value);
        if (url.protocol !== "http:" && url.protocol !== "https:") return null;
        return url;
    } catch {
        return null;
    }
}

function corsHeaders(req) {
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
    const allowOrigin = allowedOrigins.includes("*") ? "*" : allowedOrigins.includes(origin) ? origin : "";
    return {
        ...(allowOrigin ? { "access-control-allow-origin": allowOrigin } : {}),
        "access-control-allow-methods": "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS",
        "access-control-allow-headers": "Authorization, Content-Type, Accept, X-Api-Key, X-Goog-Api-Key",
        "access-control-expose-headers": "Content-Type, Content-Length, Location",
        "access-control-max-age": "86400",
    };
}

function sendJson(req, res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, { ...corsHeaders(req), "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
    res.end(body);
}

function targetUrl(req) {
    const base = upstreamBaseUrl();
    if (!base) return null;
    const incoming = new URL(req.url || "/", "http://private-gateway.local");
    if (!/^\/v1(?:beta)?(?:\/|$)/i.test(incoming.pathname)) return null;

    let suffix = incoming.pathname;
    const basePath = base.pathname.replace(/\/+$/, "");
    if (basePath && basePath !== "/" && suffix.toLowerCase().startsWith(basePath.toLowerCase())) suffix = suffix.slice(basePath.length) || "/";
    const target = new URL(base);
    target.pathname = `${basePath}/${suffix.replace(/^\/+/, "")}`.replace(/\/+/g, "/");
    target.search = incoming.search;
    return target;
}

function requestHeaders(req, target) {
    const headers = { ...req.headers, host: target.host };
    const clientAuthorization = headers.authorization;
    const clientApiKey = headers["x-api-key"];
    const clientGoogleApiKey = headers["x-goog-api-key"];
    for (const name of ["connection", "origin", "referer", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "authorization", "x-api-key", "x-goog-api-key"]) delete headers[name];
    const key = String(process.env.AI_UPSTREAM_API_KEY || "").trim();
    if (apiFormat === "gemini") {
        if (key) headers["x-goog-api-key"] = key;
        else if (allowClientKeys) {
            if (clientGoogleApiKey) headers["x-goog-api-key"] = clientGoogleApiKey;
            else if (clientApiKey) headers["x-api-key"] = clientApiKey;
            else if (clientAuthorization) headers.authorization = clientAuthorization;
        }
    } else if (key) {
        headers.authorization = `Bearer ${key}`;
    } else if (allowClientKeys) {
        if (clientAuthorization) headers.authorization = clientAuthorization;
        else if (clientApiKey) headers["x-api-key"] = clientApiKey;
        else if (clientGoogleApiKey) headers["x-goog-api-key"] = clientGoogleApiKey;
    }
    return headers;
}

function responseHeaders(req, upstream) {
    const headers = { ...corsHeaders(req) };
    for (const [name, value] of Object.entries(upstream.headers)) {
        if (["connection", "content-length", "content-encoding", "keep-alive", "transfer-encoding"].includes(name.toLowerCase())) continue;
        if (name.toLowerCase().startsWith("access-control-")) continue;
        headers[name] = value;
    }
    return headers;
}

function forward(req, res) {
    const target = targetUrl(req);
    if (!target) {
        sendJson(req, res, 404, { error: "Only /v1 and /v1beta upstream paths are available." });
        return;
    }
    const transport = target.protocol === "https:" ? https : http;
    const upstream = transport.request(target, { method: req.method, headers: requestHeaders(req, target) }, (response) => {
        res.writeHead(response.statusCode || 502, responseHeaders(req, response));
        response.pipe(res);
    });
    upstream.on("error", (error) => {
        if (res.headersSent) {
            res.destroy(error);
            return;
        }
        sendJson(req, res, 502, { error: "Upstream request failed." });
    });
    req.pipe(upstream);
}

const server = http.createServer((req, res) => {
    if (req.method === "OPTIONS") {
        res.writeHead(204, corsHeaders(req));
        res.end();
        return;
    }
    if (req.url === "/healthz") {
        const configured = Boolean(upstreamBaseUrl() && (String(process.env.AI_UPSTREAM_API_KEY || "").trim() || allowClientKeys));
        sendJson(req, res, configured ? 200 : 503, { service: "infinite-canvas-private-gateway", configured, clientKeysAllowed: allowClientKeys, apiFormat });
        return;
    }
    forward(req, res);
});

server.listen(port, host, () => {
    console.log(`infinite-canvas private gateway listening on http://${host}:${port}`);
});
