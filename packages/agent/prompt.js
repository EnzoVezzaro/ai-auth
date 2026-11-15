import { createInterface } from "node:readline";
import { Writable } from "node:stream";

/** Read a secret from the controlling TTY without echo. Refuses non-TTY stdin. */
export function promptSecret(
  question,
  { input = process.stdin, output = process.stderr } = {},
) {
  if (!input.isTTY)
    return Promise.reject(
      new Error("No TTY available to prompt for a passphrase"),
    );
  let muted = false;
  const sink = new Writable({
    write(chunk, _enc, done) {
      if (!muted) output.write(chunk);
      done();
    },
  });
  const rl = createInterface({ input, output: sink, terminal: true });
  return new Promise((resolve, reject) => {
    output.write(question);
    muted = true;
    rl.question("", (answer) => {
      output.write("\n");
      rl.close();
      resolve(answer);
    });
    rl.once("SIGINT", () => {
      rl.close();
      reject(new Error("Prompt cancelled"));
    });
  });
}
