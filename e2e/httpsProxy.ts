import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as os from "node:os";
import * as nodePath from "node:path";
import type { Duplex } from "node:stream";

/**
 * A TLS-terminating reverse proxy in front of a Vite dev server, the way nginx
 * fronts a dev server on a company hostname: the browser speaks https to the
 * proxy, the proxy speaks plain http to Vite, keeps the browser's `Host` and
 * adds `X-Forwarded-Proto` and `X-Forwarded-Host`. Like an nginx whose request
 * buffering is cut short, it refuses a request body above `bodyLimit` with a
 * `413` before Vite sees it. WebSocket upgrades (Vite's HMR) pass through.
 *
 * The certificate is self-signed for `localhost`, made with `openssl` per run,
 * so the browser needs `ignoreHTTPSErrors` and the CLI must not insist on a CA
 * it knows.
 */

/** A running proxy: where the browser reaches it, and how to stop it. */
export interface HttpsProxy {
  readonly url: string;
  readonly close: () => Promise<void>;
}

/** A self-signed certificate and key for `localhost`, in a fresh temp dir. */
const selfSignedCertificate = (): { cert: string; key: string } => {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "intervu-e2e-tls-"));
  const certPath = nodePath.join(dir, "cert.pem");
  const keyPath = nodePath.join(dir, "key.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
      "-keyout",
      keyPath,
      "-out",
      certPath,
    ],
    { stdio: "ignore" },
  );
  return {
    cert: fs.readFileSync(certPath, "utf8"),
    key: fs.readFileSync(keyPath, "utf8"),
  };
};

/** nginx's answer to a body above its limit. */
const tooLarge = `<html>
<head><title>413 Request Entity Too Large</title></head>
<body>
<center><h1>413 Request Entity Too Large</h1></center>
<hr><center>nginx</center>
</body>
</html>
`;

/** How a proxy is started: where it listens, where Vite is, what it forwards. */
export interface HttpsProxyOptions {
  readonly port: number;
  readonly vitePort: number;
  readonly bodyLimit: number;
  /**
   * With `false`, the proxy is misconfigured the common way: it rewrites
   * `Host` to the upstream's own and forwards nothing about the browser -
   * an nginx `proxy_pass` without the `proxy_set_header` lines - so the dev
   * server cannot tell the browser's origin is its own.
   */
  readonly forwardHost?: boolean;
}

/** The browser's headers, plus what nginx's `proxy_set_header` lines add. */
const forwardedHeaders = (
  request: http.IncomingMessage,
  options: HttpsProxyOptions,
): Record<string, string> => {
  const headers: Record<string, string> = {};
  const raw = request.rawHeaders;
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const name = raw[index];
    const value = raw[index + 1];
    if (name !== undefined && value !== undefined) {
      headers[name.toLowerCase()] = value;
    }
  }
  if (options.forwardHost === false) {
    headers.host = `localhost:${options.vitePort}`;
    return headers;
  }
  headers["x-forwarded-proto"] = "https";
  headers["x-forwarded-host"] = headers.host ?? "";
  return headers;
};

/** Start the proxy on `port`, forwarding to Vite on `localhost:vitePort`. */
export const startHttpsProxy = (
  options: HttpsProxyOptions,
): Promise<HttpsProxy> => {
  const server = https.createServer(
    selfSignedCertificate(),
    (request, response) => {
      if (Number(request.headers["content-length"] ?? 0) > options.bodyLimit) {
        request.resume();
        response.writeHead(413, "Request Entity Too Large", {
          "content-type": "text/html",
        });
        response.end(tooLarge);
        return;
      }
      const upstream = http.request(
        {
          // Vite listens on `localhost`, which may be IPv6 only.
          host: "localhost",
          port: options.vitePort,
          method: request.method,
          path: request.url,
          headers: forwardedHeaders(request, options),
        },
        (viteResponse) => {
          response.writeHead(
            viteResponse.statusCode ?? 502,
            viteResponse.headers,
          );
          response.flushHeaders();
          viteResponse.pipe(response);
        },
      );
      upstream.on("error", () => response.destroy());
      response.on("close", () => upstream.destroy());
      request.pipe(upstream);
    },
  );

  // Upgraded sockets (Vite's HMR websocket) leave the server's connection
  // tracking, so `closeAllConnections` misses them and `close` would wait on
  // them forever; they are tracked and destroyed here instead.
  const upgraded = new Set<Duplex>();
  server.on("upgrade", (request, socket, head) => {
    upgraded.add(socket);
    socket.on("close", () => upgraded.delete(socket));
    const upstream = net.connect(options.vitePort, "localhost", () => {
      const headers = Object.entries(forwardedHeaders(request, options))
        .map(([name, value]) => `${name}: ${value}\r\n`)
        .join("");
      upstream.write(
        `${request.method} ${request.url} HTTP/1.1\r\n${headers}\r\n`,
      );
      upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });

  return new Promise((resolve) => {
    // Every interface, so `localhost` reaches it over IPv4 and IPv6 alike.
    server.listen(options.port, () =>
      resolve({
        url: `https://localhost:${options.port}`,
        close: () =>
          new Promise<void>((closed) => {
            for (const socket of upgraded) {
              socket.destroy();
            }
            server.closeAllConnections();
            server.close(() => closed());
          }),
      }),
    );
  });
};
