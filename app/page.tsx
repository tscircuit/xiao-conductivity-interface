"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type PathState = "unknown" | "connected" | "cut";
type ProgramState = "idle" | "starting" | "running";

type SerialPortLike = {
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
};

type SerialApi = {
  requestPort(): Promise<SerialPortLike>;
  addEventListener(type: "disconnect", listener: () => void): void;
  removeEventListener(type: "disconnect", listener: () => void): void;
};

type ConnectionDefinition = {
  id: string;
  corner: string;
  pair: string;
  output: string;
  input: string;
};

const CONNECTIONS: ConnectionDefinition[] = [
  { id: "d7-d8", corner: "Corner 1", pair: "GPIO 7 ↔ 8", output: "D8", input: "D7" },
  { id: "d5-d6", corner: "Corner 2", pair: "GPIO 5 ↔ 6", output: "D5", input: "D6" },
  { id: "d10-d9", corner: "Corner 3", pair: "GPIO 10 ↔ 9", output: "D10", input: "D9" },
  { id: "d3-d4", corner: "Corner 4", pair: "GPIO 3 ↔ 4", output: "D3", input: "D4" },
];

const DEFAULT_CODE = `from machine import Pin
from time import sleep_ms

# Set source pins HIGH.
outputs = {
    "D3": Pin(29, Pin.OUT, value=1),
    "D5": Pin(7, Pin.OUT, value=1),
    "D10": Pin(3, Pin.OUT, value=1),
    "D8": Pin(2, Pin.OUT, value=1),
}

# Read destination pins. Unconnected pins remain LOW.
inputs = {
    "D4": Pin(6, Pin.IN, Pin.PULL_DOWN),
    "D6": Pin(0, Pin.IN, Pin.PULL_DOWN),
    "D9": Pin(4, Pin.IN, Pin.PULL_DOWN),
    "D7": Pin(1, Pin.IN, Pin.PULL_DOWN),
}

connections = [
    ("D3", "D4"),
    ("D5", "D6"),
    ("D10", "D9"),
    ("D8", "D7"),
]

def scan_connections():
    sleep_ms(10)

    print("\\nConnection test")
    print("-----------------------")

    all_connected = True

    for output_name, input_name in connections:
        connected = inputs[input_name].value() == 1
        status = "CONNECTED" if connected else "NOT CONNECTED"

        print("{} -> {}: {}".format(
            output_name,
            input_name,
            status,
        ))

        if not connected:
            all_connected = False

    print("-----------------------")
    print("OVERALL:", "PASS" if all_connected else "FAIL")


while True:
    input("\\nPress Enter to run the test...")
    scan_connections()
`;

const initialStates = Object.fromEntries(
  CONNECTIONS.map((connection) => [connection.id, "unknown" as PathState]),
) as Record<string, PathState>;

function getSerialApi(): SerialApi | null {
  if (typeof navigator === "undefined" || !("serial" in navigator)) return null;
  return (navigator as Navigator & { serial: SerialApi }).serial;
}

function delay(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

export default function Home() {
  const [code, setCode] = useState(DEFAULT_CODE);
  const [isConnected, setIsConnected] = useState(false);
  const [programState, setProgramState] = useState<ProgramState>("idle");
  const [pathStates, setPathStates] = useState<Record<string, PathState>>(initialStates);
  const [connectionNote, setConnectionNote] = useState("Connect the XIAO to begin.");
  const [terminalLines, setTerminalLines] = useState<string[]>([]);
  const [lastScan, setLastScan] = useState<string | null>(null);
  const [isSerialSupported, setIsSerialSupported] = useState(true);

  const portRef = useRef<SerialPortLike | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const writerRef = useRef<WritableStreamDefaultWriter<Uint8Array> | null>(null);
  const readBufferRef = useRef("");
  const writeQueueRef = useRef(Promise.resolve());

  const appendTerminal = useCallback((text: string) => {
    const newLines = text.replace(/\r/g, "").split("\n").filter(Boolean);
    if (!newLines.length) return;
    setTerminalLines((current) => [...current, ...newLines].slice(-40));
  }, []);

  const processSerialText = useCallback(
    (text: string) => {
      appendTerminal(text);
      readBufferRef.current += text.replace(/\r/g, "");
      const lines = readBufferRef.current.split("\n");
      readBufferRef.current = lines.pop() ?? "";

      for (const line of lines) {
        const result = line.match(/(D\d+)\s*->\s*(D\d+):\s*(CONNECTED|NOT CONNECTED)/);
        if (result) {
          const connection = CONNECTIONS.find(
            (item) => item.output === result[1] && item.input === result[2],
          );
          if (connection) {
            setPathStates((current) => ({
              ...current,
              [connection.id]: result[3] === "CONNECTED" ? "connected" : "cut",
            }));
          }
        }

        if (/OVERALL:\s*(PASS|FAIL)/.test(line)) {
          setLastScan(
            new Intl.DateTimeFormat(undefined, {
              hour: "numeric",
              minute: "2-digit",
              second: "2-digit",
            }).format(new Date()),
          );
        }
      }
    },
    [appendTerminal],
  );

  const markDisconnected = useCallback(() => {
    setIsConnected(false);
    setProgramState("idle");
    setPathStates(initialStates);
    setConnectionNote("XIAO connection lost. Reconnect the USB cable or port.");
  }, []);

  useEffect(() => {
    const serial = getSerialApi();
    setIsSerialSupported(Boolean(serial));
    if (!serial) return;

    const handleDisconnect = () => {
      if (portRef.current) markDisconnected();
    };
    serial.addEventListener("disconnect", handleDisconnect);
    return () => serial.removeEventListener("disconnect", handleDisconnect);
  }, [markDisconnected]);

  const readFromPort = useCallback(
    async (port: SerialPortLike) => {
      if (!port.readable) return;
      const reader = port.readable.getReader();
      readerRef.current = reader;
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) processSerialText(decoder.decode(value, { stream: true }));
        }
      } catch {
        if (portRef.current === port) markDisconnected();
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // The port may already be gone.
        }
        if (readerRef.current === reader) readerRef.current = null;
        if (portRef.current === port) markDisconnected();
      }
    },
    [markDisconnected, processSerialText],
  );

  const writeBytes = useCallback((bytes: Uint8Array) => {
    writeQueueRef.current = writeQueueRef.current.then(async () => {
      const writer = writerRef.current;
      if (!writer) throw new Error("XIAO is not connected.");
      await writer.write(bytes);
    });
    return writeQueueRef.current;
  }, []);

  const writeText = useCallback(
    (text: string) => writeBytes(new TextEncoder().encode(text)),
    [writeBytes],
  );

  const connect = async () => {
    const serial = getSerialApi();
    if (!serial) {
      setConnectionNote("Web Serial is unavailable. Open this page in Chrome or Edge.");
      return;
    }

    try {
      setConnectionNote("Choose the XIAO serial port…");
      const port = await serial.requestPort();
      await port.open({ baudRate: 115200 });
      if (!port.writable) throw new Error("The selected port is not writable.");

      portRef.current = port;
      writerRef.current = port.writable.getWriter();
      readBufferRef.current = "";
      setTerminalLines([]);
      setPathStates(initialStates);
      setIsConnected(true);
      setConnectionNote("XIAO connected. Run the code to start monitoring.");
      void readFromPort(port);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not open the serial port.";
      setConnectionNote(message);
    }
  };

  const disconnect = async () => {
    const port = portRef.current;
    portRef.current = null;
    setProgramState("idle");

    try {
      await readerRef.current?.cancel();
    } catch {
      // Reader may already be closed.
    }
    try {
      writerRef.current?.releaseLock();
    } catch {
      // Writer may already be closed.
    }
    readerRef.current = null;
    writerRef.current = null;
    try {
      await port?.close();
    } catch {
      // A removed USB device cannot be closed again.
    }

    setIsConnected(false);
    setPathStates(initialStates);
    setConnectionNote("Disconnected.");
  };

  const runCode = async () => {
    if (!isConnected) return;
    setProgramState("starting");
    setPathStates(initialStates);
    setLastScan(null);
    setConnectionNote("Starting the monitor…");

    try {
      // Stop the current program and enter MicroPython raw REPL mode.
      await writeText("\x03\x03");
      await delay(120);
      await writeText("\x01");
      await delay(180);

      const source = new TextEncoder().encode(code.endsWith("\n") ? code : `${code}\n`);
      for (let index = 0; index < source.length; index += 128) {
        await writeBytes(source.slice(index, index + 128));
        await delay(8);
      }
      await writeText("\x04");
      await delay(250);
      await writeText("\r\n");

      setProgramState("running");
      setConnectionNote("Monitoring continuously. Laser cuts will appear in red.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "The code could not be started.";
      setProgramState("idle");
      setConnectionNote(message);
    }
  };

  useEffect(() => {
    if (!isConnected || programState !== "running") return;
    const interval = window.setInterval(() => {
      void writeText("\r\n").catch(() => markDisconnected());
    }, 1000);
    return () => window.clearInterval(interval);
  }, [isConnected, markDisconnected, programState, writeText]);

  const states = Object.values(pathStates);
  const cutCount = states.filter((state) => state === "cut").length;
  const connectedCount = states.filter((state) => state === "connected").length;

  const overall = useMemo(() => {
    if (!isConnected) {
      return { tone: "offline", eyebrow: "Device offline", title: "XIAO not connected" };
    }
    if (cutCount > 0) {
      return {
        tone: "danger",
        eyebrow: `${cutCount} ${cutCount === 1 ? "break" : "breaks"} detected`,
        title: "Conductive path broken",
      };
    }
    if (connectedCount === CONNECTIONS.length) {
      return { tone: "good", eyebrow: "All four paths connected", title: "Board conductivity is good" };
    }
    return { tone: "waiting", eyebrow: "Waiting for readings", title: "Run the monitor" };
  }, [connectedCount, cutCount, isConnected]);

  return (
    <main>
      <div className="shell">
        <header className="topbar">
          <div>
            <p className="kicker">XIAO · LASER TEST</p>
            <h1>Conductivity monitor</h1>
          </div>
          <button
            className={isConnected ? "button buttonSecondary" : "button buttonPrimary"}
            onClick={isConnected ? disconnect : connect}
            type="button"
          >
            <span className={`buttonDot ${isConnected ? "buttonDotLive" : ""}`} />
            {isConnected ? "Disconnect" : "Connect XIAO"}
          </button>
        </header>

        {!isSerialSupported && (
          <div className="browserNotice" role="status">
            Open this dashboard in Chrome or Edge on your Mac to connect over USB.
          </div>
        )}

        <section className={`overall overall-${overall.tone}`} aria-live="assertive">
          <div className="overallIcon" aria-hidden="true">
            {overall.tone === "danger" ? "!" : overall.tone === "good" ? "✓" : "•"}
          </div>
          <div>
            <p>{overall.eyebrow}</p>
            <h2>{overall.title}</h2>
          </div>
          <div className="overallMeta">{lastScan ? `Last scan ${lastScan}` : "No scan yet"}</div>
        </section>

        <section aria-labelledby="corners-title">
          <div className="sectionHeading">
            <div>
              <p className="kicker">LIVE BOARD</p>
              <h2 id="corners-title">Four corner paths</h2>
            </div>
            <p className="connectionNote">{connectionNote}</p>
          </div>

          <div className="cornerGrid">
            {CONNECTIONS.map((connection) => {
              const state = pathStates[connection.id];
              return (
                <article className={`cornerCard cornerCard-${state}`} key={connection.id}>
                  <div className="cornerTopline">
                    <span>{connection.corner}</span>
                    <span className={`statusPill statusPill-${state}`}>
                      {state === "connected" ? "CONNECTED" : state === "cut" ? "OPEN / CUT" : "WAITING"}
                    </span>
                  </div>
                  <div className="pairRow">
                    <span className={`pathLight pathLight-${state}`} aria-hidden="true" />
                    <strong>{connection.pair}</strong>
                  </div>
                  <p>{connection.output} output → {connection.input} input</p>
                </article>
              );
            })}
          </div>
        </section>

        <section className="editorSection" aria-labelledby="editor-title">
          <div className="sectionHeading editorHeading">
            <div>
              <p className="kicker">MICROPYTHON</p>
              <h2 id="editor-title">Code editor</h2>
            </div>
            <button
              className="button buttonRun"
              disabled={!isConnected || programState === "starting"}
              onClick={runCode}
              type="button"
            >
              {programState === "starting" ? "Starting…" : programState === "running" ? "Restart code" : "Run & monitor"}
            </button>
          </div>

          <textarea
            aria-label="MicroPython test code"
            className="codeEditor"
            onChange={(event) => setCode(event.target.value)}
            spellCheck={false}
            value={code}
          />
          <p className="editorHelp">
            The dashboard presses Enter once per second and reads the four connection results. Keep the same output format when editing the test.
          </p>

          <details className="terminal">
            <summary>Serial output {terminalLines.length ? `(${terminalLines.length} recent lines)` : ""}</summary>
            <pre>{terminalLines.length ? terminalLines.join("\n") : "No serial output yet."}</pre>
          </details>
        </section>
      </div>
    </main>
  );
}
