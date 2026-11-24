import assert from "node:assert/strict";
import test from "node:test";
import { createWriteBytes } from "../app/write-queue.ts";

test("writes execute in order", async () => {
  const written: number[] = [];
  const writeBytes = createWriteBytes(() => ({
    write: async (bytes: Uint8Array) => {
      written.push(bytes[0]);
    },
  }));

  await writeBytes(new Uint8Array([1]));
  await writeBytes(new Uint8Array([2]));
  await writeBytes(new Uint8Array([3]));
  assert.deepEqual(written, [1, 2, 3]);
});

test("a failed write does not poison later writes", async () => {
  const written: number[] = [];
  let shouldFail = true;
  const writeBytes = createWriteBytes(() => ({
    write: async (bytes: Uint8Array) => {
      if (shouldFail) {
        shouldFail = false;
        throw new Error("serial glitch");
      }
      written.push(bytes[0]);
    },
  }));

  // The failing write must still reject for its own caller.
  await assert.rejects(writeBytes(new Uint8Array([1])), /serial glitch/);

  // A later write (for example after reconnecting) must still reach the
  // device instead of chaining off the rejected promise forever.
  await writeBytes(new Uint8Array([2]));
  assert.deepEqual(written, [2]);
});

test("a write while disconnected rejects but does not block reconnected writes", async () => {
  const written: number[] = [];
  let connected = false;
  const writeBytes = createWriteBytes(() =>
    connected
      ? {
          write: async (bytes: Uint8Array) => {
            written.push(bytes[0]);
          },
        }
      : null,
  );

  await assert.rejects(writeBytes(new Uint8Array([1])), /not connected/);

  connected = true;
  await writeBytes(new Uint8Array([2]));
  assert.deepEqual(written, [2]);
});

test("caller-visible rejection only affects the write that failed", async () => {
  const writeBytes = createWriteBytes(() => ({
    write: async (bytes: Uint8Array) => {
      if (bytes[0] === 2) throw new Error("boom");
    },
  }));

  await writeBytes(new Uint8Array([1]));
  await assert.rejects(writeBytes(new Uint8Array([2])));
  await writeBytes(new Uint8Array([3]));
});
