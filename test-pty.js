// Run this in Obsidian's DevTools console to test PTY methods
(() => {
  const cp = require("child_process");
  const results = {};

  // Test python3 openpty
  try {
    const r = cp.spawnSync("python3", ["-c", 'import pty,os; m,s=pty.openpty(); os.close(m); os.close(s); print("openpty works")'], {timeout:3000});
    results.python_openpty = r.stdout?.toString().trim() || r.stderr?.toString().trim() || "empty";
  } catch(e) { results.python_openpty = e.message; }

  // Test unbuffer
  try {
    const r = cp.spawnSync("which", ["unbuffer"], {timeout:3000});
    results.unbuffer = r.stdout?.toString().trim() || "not found";
  } catch(e) { results.unbuffer = e.message; }

  // Test expect
  try {
    const r = cp.spawnSync("which", ["expect"], {timeout:3000});
    results.expect = r.stdout?.toString().trim() || "not found";
  } catch(e) { results.expect = e.message; }

  // Test script directly
  try {
    const r = cp.spawnSync("/usr/bin/script", ["-q", "/dev/null", "/bin/echo", "hello"], {timeout:3000});
    results.script_exit = r.status;
    results.script_stdout = r.stdout?.toString().trim().substring(0, 100) || "empty";
    results.script_stderr = r.stderr?.toString().trim().substring(0, 100) || "empty";
  } catch(e) { results.script = e.message; }

  return JSON.stringify(results, null, 2);
})();
