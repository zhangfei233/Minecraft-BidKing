import fs from "node:fs";
import path from "node:path";

export const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

export function sendJson(res, payload, status = 200) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": MIME_TYPES[".json"],
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

export function sendFile(res, filePath) {
  fs.stat(filePath, (statError, stat) => {
    if (statError || !stat.isFile()) {
      const fallbackPath = imageFallbackPath(filePath);
      if (fallbackPath) {
        sendFile(res, fallbackPath);
        return;
      }
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    const lastModified = stat.mtime.toUTCString();

    if (res.req?.headers["if-none-match"] === etag || res.req?.headers["if-modified-since"] === lastModified) {
      res.writeHead(304, {
        etag,
        "last-modified": lastModified,
      });
      res.end();
      return;
    }

    res.writeHead(200, {
      "content-type": MIME_TYPES[ext] || "application/octet-stream",
      "content-length": stat.size,
      etag,
      "last-modified": lastModified,
      "cache-control": "no-cache",
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

function imageFallbackPath(filePath) {
  if (path.extname(filePath).toLowerCase() !== ".png") return null;
  const basePath = filePath.slice(0, -path.extname(filePath).length);
  for (const ext of [".gif", ".webp"]) {
    const candidate = `${basePath}${ext}`;
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // Try the next supported image format.
    }
  }
  return null;
}

export function safeJoin(baseDir, requestPath) {
  const decoded = decodeURIComponent(requestPath);
  const target = path.normalize(path.join(baseDir, decoded));
  return target.startsWith(baseDir) ? target : null;
}
