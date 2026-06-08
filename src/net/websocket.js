import crypto from "node:crypto";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function acceptWebSocket(req, socket) {
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return false;
  }

  const accept = crypto.createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n"),
  );
  socket.setKeepAlive?.(true, 10_000);
  socket.setTimeout?.(0);
  return true;
}

export function sendWsJson(socket, payload) {
  if (!socket.destroyed) socket.write(encodeWsText(JSON.stringify(payload)));
}

export function decodeWsText(buffer) {
  const opcode = buffer[0] & 0x0f;
  if (opcode === 0x8) return null;

  let offset = 2;
  let length = buffer[1] & 0x7f;
  if (length === 126) {
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    return null;
  }

  const masked = (buffer[1] & 0x80) === 0x80;
  if (!masked) return buffer.subarray(offset, offset + length).toString("utf8");

  const mask = buffer.subarray(offset, offset + 4);
  offset += 4;
  const payload = Buffer.alloc(length);
  for (let i = 0; i < length; i += 1) {
    payload[i] = buffer[offset + i] ^ mask[i % 4];
  }
  return payload.toString("utf8");
}

function encodeWsText(text) {
  const payload = Buffer.from(text);
  if (payload.length > 65535) {
    const header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
    return Buffer.concat([header, payload]);
  }
  if (payload.length > 125) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }

  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}
