import { fileURLToPath } from "node:url";

/** Wrangler reached triggers after uploading the Worker, but the API response was unreadable. */
export class TransientTriggerError extends Error {}

export function isTransientTriggerFailure(stderr: string): boolean {
  return stderr.includes("Some triggers failed to deploy")
    && stderr.includes("Received a malformed response from the API");
}

/** Retry only triggers; never repeat the upload, migrations or control requests here. */
export async function deployWorker(
  run: (triggersOnly: boolean) => Promise<unknown>,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await run(attempt > 0);
      return;
    } catch (error) {
      if (!(error instanceof TransientTriggerError) || attempt === 2) throw error;
      console.warn(`Cloudflare trigger API response was malformed; retrying triggers (${attempt + 1}/2).`);
      await sleep(10_000 * (attempt + 1));
    }
  }
}

/** The last lines a failed command printed, to name in its error: the log above may be long, or cut off. */
export function tailLines(text: string, lines = 12): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean).slice(-lines).join("\n");
}

export async function deploymentCommand(args: string[], capture = false): Promise<string> {
  const process = Bun.spawn(args, { cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: capture ? "pipe" : "inherit", stderr: "pipe", stdin: "ignore" });
  const errors = (async () => {
    const decoder = new TextDecoder();
    let tail = "";
    for await (const chunk of process.stderr) {
      await Bun.stderr.write(chunk);
      tail = (tail + decoder.decode(chunk, { stream: true })).slice(-65_536);
    }
    return tail + decoder.decode();
  })();
  const output = capture ? await new Response(process.stdout).text() : "";
  const [status, stderr] = await Promise.all([process.exited, errors]);
  if (status !== 0) {
    const ErrorType = isTransientTriggerFailure(stderr) ? TransientTriggerError : Error;
    // A captured command (`--json`) prints its error to stdout, which nothing else shows.
    const said = tailLines([stderr, capture ? output : ""].filter(Boolean).join("\n"));
    throw new ErrorType(`${args.join(" ")} failed (exit ${status})${said ? `:\n${said}` : ""}`);
  }
  return output;
}
