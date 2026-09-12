import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
const exec = promisify(execFile);
const digest = s => createHash("sha256").update(s).digest("hex");
function spawnInput(command, args, text) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${command} timed out`)); }, 3000);
    child.once("error", e => { clearTimeout(timer); reject(e); });
    child.once("exit", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)); });
    child.stdin.once("error", e => { clearTimeout(timer); child.kill(); reject(e); });
    child.stdin.end(text);
  });
}
async function readOutput(command, args, bytes) {
  const { stdout } = await exec(command, args, { encoding: "utf8", timeout: 3000, maxBuffer: bytes + 65536, windowsHide: true });
  return stdout;
}
function emitOsc52(text) {
  if (!process.stdout?.isTTY) return false;
  try { process.stdout.write(`\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`); return true; }
  catch { return false; }
}

/** Test transports can be injected; production uses only local clipboard tools. */
export async function copyText(text, options = {}) {
  const source = String(text), bytes = Buffer.byteLength(source), sha256 = digest(source);
  const platform = options.platform || process.platform, env = options.env || process.env;
  const write = options.write || spawnInput, read = options.read || readOutput, osc = options.osc || emitOsc52;
  const candidates = [];
  const powershell = ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[Console]::InputEncoding=[System.Text.UTF8Encoding]::new(); Set-Clipboard -Value ([Console]::In.ReadToEnd())"], "powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); [Console]::Write((Get-Clipboard -Raw))"]];
  if (platform === "darwin") candidates.push(["pbcopy", [], "pbpaste", []]);
  else if (platform === "win32") candidates.push(powershell);
  else {
    if (env.WAYLAND_DISPLAY) candidates.push(["wl-copy", [], "wl-paste", ["--no-newline"]]);
    if (env.DISPLAY) {
      candidates.push(["xclip", ["-selection", "clipboard"], "xclip", ["-selection", "clipboard", "-o"]]);
      candidates.push(["xsel", ["--clipboard", "--input"], "xsel", ["--clipboard", "--output"]]);
    }
    if (env.WSL_DISTRO_NAME) candidates.push(powershell);
  }
  for (const [command, args, reader, readArgs] of candidates) {
    try { await write(command, args, source); } catch { continue; }
    let readback;
    try { readback = await read(reader, readArgs, bytes); }
    catch { return { method: command, bytes, sha256, verification: "sent-unverified", warning: "写入命令已完成，但剪贴板无法回读核验；接收端仍须检查结束标记。" }; }
    if (readback === source || String(readback).replace(/\r\n/g, "\n") === source.replace(/\r\n/g, "\n"))
      return { method: command, bytes, sha256, verification: "readback-matched", normalization: readback === source ? "none" : "CRLF-to-LF" };
    throw new Error("剪贴板回读与报告不一致，可能截断或被其他程序改写；未确认复制完整，请按 s 保存完整文件。");
  }
  if (bytes > 75000) throw new Error("报告超过安全终端剪贴板大小；请按 s 保存完整文件。没有截断内容。");
  if (osc(source)) return { method: "OSC 52", bytes, sha256, verification: "sent-unverified", warning: "已发送，但终端无回执、不能回读；请核对结束标记或保存文件。" };
  throw new Error("无可用剪贴板传输，请按 s 保存完整文件。");
}
