import fs from "node:fs";
import path from "node:path";

let logFile = null;

export function initLogger(rootDir) {
  const dir = path.join(rootDir, "logs");
  fs.mkdirSync(dir, { recursive: true });
  logFile = path.join(dir, "server.log");
  info("logger initialized");
}

export function info(message, meta = null) {
  write("INFO", message, meta);
}

export function error(message, err = null, meta = null) {
  write("ERROR", message, { ...serializeError(err), ...(meta || {}) });
}

function write(level, message, meta = null) {
  const line = JSON.stringify({
    time: new Date().toISOString(),
    level,
    message,
    ...(meta ? { meta } : {}),
  });
  if (logFile) fs.appendFileSync(logFile, `${line}\n`, "utf8");
  if (level === "ERROR") console.error(line);
  else console.log(line);
}

function serializeError(err) {
  if (!err) return {};
  return {
    name: err.name,
    message: err.message,
    stack: err.stack,
  };
}
