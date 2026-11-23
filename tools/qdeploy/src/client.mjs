import { createReadStream } from "node:fs";
import http from "node:http";
import https from "node:https";

export class ClientError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "ClientError";
    this.status = status;
  }
}

function isInsecure() {
  return process.env.QDEPLOY_INSECURE === "1";
}

function transportFor(url) {
  return url.protocol === "https:" ? https : http;
}

function parseBody(raw, status) {
  const text = raw.toString("utf8").trim();
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : { value };
  } catch {
    return { error: text.slice(0, 500) || `HTTP ${status}` };
  }
}

export class Client {
  constructor(url, token, timeout = 300_000) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`invalid deploy URL: ${url}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`invalid deploy URL: ${url}`);
    }
    this.url = parsed;
    this.prefix = parsed.pathname.replace(/\/+$/, "");
    this.token = token;
    this.timeout = timeout;
  }

  target(path) {
    const url = new URL(this.url.toString());
    url.pathname = `${this.prefix}${path}`;
    url.search = "";
    url.hash = "";
    return url;
  }

  send({ method, path, body, bodyFile, headers = {}, auth = true }) {
    const url = this.target(path);
    const allHeaders = { accept: "application/json", "user-agent": "qdeploy/1.0", ...headers };
    if (auth) allHeaders.authorization = `Bearer ${this.token}`;

    return new Promise((resolve, reject) => {
      let settled = false;
      let responded = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };

      const req = transportFor(url).request(
        url,
        {
          method,
          headers: allHeaders,
          rejectUnauthorized: !isInsecure(),
        },
        (res) => {
          responded = true;
          const chunks = [];
          let total = 0;
          res.on("data", (chunk) => {
            total += chunk.length;
            if (total > 10 * 1024 * 1024) {
              res.destroy();
              finish(reject, new ClientError(res.statusCode || 0, "response too large"));
              return;
            }
            chunks.push(chunk);
          });
          res.on("end", () => {
            const data = parseBody(Buffer.concat(chunks), res.statusCode || 0);
            if ((res.statusCode || 0) >= 400) {
              finish(
                reject,
                new ClientError(
                  res.statusCode || 0,
                  data.error || `HTTP ${res.statusCode}`,
                ),
              );
              return;
            }
            if (data.ok === false) {
              finish(reject, new ClientError(res.statusCode || 200, data.error || "request failed"));
              return;
            }
            finish(resolve, data);
          });
          res.on("error", (err) => finish(reject, err));
        },
      );

      const timer = setTimeout(() => {
        req.destroy(new Error("request timed out"));
        finish(reject, new Error("request timed out"));
      }, this.timeout);

      req.on("error", (err) => {
        if (!responded) finish(reject, err);
      });

      if (bodyFile) {
        const stream = createReadStream(bodyFile);
        stream.on("error", (err) => {
          req.destroy();
          finish(reject, err);
        });
        stream.pipe(req);
      } else {
        req.end(body);
      }
    });
  }

  async requestJson(method, path, body) {
    const headers = {};
    let payload;
    if (body !== undefined) {
      payload = Buffer.from(JSON.stringify(body), "utf8");
      headers["content-type"] = "application/json";
      headers["content-length"] = String(payload.length);
    }
    return this.send({ method, path, body: payload, headers });
  }

  health() {
    return this.send({ method: "GET", path: "/api/v1/health", auth: false });
  }

  listSites() {
    return this.requestJson("GET", "/api/v1/sites");
  }

  getSite(name) {
    return this.requestJson("GET", `/api/v1/sites/${encodeURIComponent(name)}`);
  }

  rollback(name, release) {
    return this.requestJson(
      "POST",
      `/api/v1/sites/${encodeURIComponent(name)}/rollback`,
      release ? { release } : {},
    );
  }

  deleteSite(name) {
    return this.requestJson("DELETE", `/api/v1/sites/${encodeURIComponent(name)}`);
  }

  deploy(name, bundle, meta, size) {
    const metaHeader = Buffer.from(
      JSON.stringify(meta),
      "utf8",
    ).toString("base64url");
    return this.send({
      method: "POST",
      path: `/api/v1/sites/${encodeURIComponent(name)}/deploy`,
      bodyFile: bundle,
      headers: {
        "content-type": "application/gzip",
        "content-length": String(size),
        "x-deploy-meta": metaHeader,
      },
    });
  }
}

export function probeUrl(rawUrl, { timeoutMs = 5000, redirects = 5 } = {}) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      resolve(null);
      return;
    }
    const lib = transportFor(url);
    const req = lib.get(
      url,
      {
        headers: { "user-agent": "qdeploy/1.0" },
        rejectUnauthorized: !isInsecure(),
        timeout: timeoutMs,
      },
      (res) => {
        const status = res.statusCode || 0;
        res.resume();
        if (status >= 300 && status < 400 && res.headers.location && redirects > 0) {
          const next = new URL(res.headers.location, url).toString();
          probeUrl(next, { timeoutMs, redirects: redirects - 1 }).then(resolve);
          return;
        }
        resolve(status);
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => resolve(null));
  });
}
