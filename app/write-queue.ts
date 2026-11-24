export type ByteWriter = {
  write(bytes: Uint8Array): Promise<unknown>;
};

/**
 * Serializes writes to the serial port so the raw-REPL entry sequence and
 * the program bytes cannot interleave. getWriter is read when each write
 * runs so disconnects between queueing and execution are reflected.
 */
export function createWriteBytes(
  getWriter: () => ByteWriter | null,
): (bytes: Uint8Array) => Promise<void> {
  let queue = Promise.resolve() as Promise<void>;

  return (bytes: Uint8Array) => {
    // Chain off a caught version of the previous write. Without this, one
    // rejected write leaves the queue promise rejected forever, so every
    // later write silently never reaches the device even after reconnecting.
    const next = queue
      .catch(() => undefined)
      .then(async () => {
        const writer = getWriter();
        if (!writer) throw new Error("XIAO is not connected.");
        await writer.write(bytes);
      });
    queue = next;
    return next;
  };
}
