import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const [mode = "root", marker = ""] = process.argv.slice(2);

process.on("SIGTERM", () => {});

if (mode === "grandchild") {
  console.log(`GRANDCHILD_PID=${process.pid}`);
  const write = () => appendFileSync(marker, `${Date.now()}\n`, "utf8");
  write();
  setInterval(write, 50);
} else if (mode === "child") {
  const grandchild = spawn(process.execPath, [script, "grandchild", marker], {
    detached: true,
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: true,
  });
  console.log(`CHILD_PID=${process.pid}`);
  console.log(`SPAWNED_GRANDCHILD_PID=${grandchild.pid}`);
  setInterval(() => {}, 1000);
} else {
  const child = spawn(process.execPath, [script, "child", marker], {
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: true,
  });
  console.log(`ROOT_PID=${process.pid}`);
  console.log(`SPAWNED_CHILD_PID=${child.pid}`);
  console.log("partial-output-before-timeout");
  console.log(`ARTIFACT heartbeat=${marker}`);
  setInterval(() => {}, 1000);
}
