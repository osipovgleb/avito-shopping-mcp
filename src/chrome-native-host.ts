import { readSync } from "node:fs";

import * as z from "zod/v4";

import { ChromeBridge } from "./chrome-bridge.js";
import { safeError } from "./errors.js";

const MAX_MESSAGE_BYTES = 256 * 1024;
const messageSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("claim"), profile: z.string() }),
  z.object({
    action: z.literal("complete"),
    requestId: z.uuid(),
    httpStatus: z.number().int().min(0).max(599),
    payload: z.unknown().optional(),
  }),
]);

function readBytes(length: number): Buffer {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const count = readSync(0, buffer, offset, length - offset, null);
    if (count === 0) throw new Error("Unexpected end of native message");
    offset += count;
  }
  return buffer;
}

function respond(value: object): void {
  const payload = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length);
  process.stdout.write(Buffer.concat([header, payload]));
}

try {
  const length = readBytes(4).readUInt32LE();
  if (length < 1 || length > MAX_MESSAGE_BYTES) throw new Error("Invalid native message length");
  const message = messageSchema.parse(JSON.parse(readBytes(length).toString("utf8")));
  const bridge = new ChromeBridge();
  if (message.action === "claim") {
    respond({ request: await bridge.claim(message.profile) });
  } else {
    const result = await bridge.complete(message.requestId, message.httpStatus, message.payload);
    respond({ status: result.status });
  }
} catch (error) {
  respond({ error: safeError(error) });
}
