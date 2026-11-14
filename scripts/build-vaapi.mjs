// Optional Linux host setup. No root privileges, global libraries or Python packages are changed.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "linux") throw new Error("VA-API setup is available on Linux hosts only");
const source = fileURLToPath(new URL("../helper/screen/vaapi-encoder.c", import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--sdk")) throw new Error("Usage: node scripts/build-vaapi.mjs [--sdk extracted-dev-packages-root]");
const sdk = args[1] ? path.resolve(args[1]) : undefined;
let flags;
if (sdk) {
  const triplet = execFileSync("cc", ["-dumpmachine"], { encoding: "utf8" }).trim();
  const include = path.join(sdk, "usr/include", triplet);
  const major = (name) => {
    let header;
    try { header = readFileSync(path.join(include, name, "version_major.h"), "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; header = readFileSync(path.join(include, name, "version.h"), "utf8"); }
    const match = header.match(new RegExp(`#define\\s+${name.toUpperCase()}_VERSION_MAJOR\\s+(\\d+)`));
    if (!match) throw new Error(`Cannot identify ${name} headers`);
    return match[1];
  };
  flags = ["-I", include, `-l:libavcodec.so.${major("libavcodec")}`, `-l:libavutil.so.${major("libavutil")}`];
} else {
  flags = execFileSync("pkg-config", ["--cflags", "--libs", "libavcodec", "libavutil"], { encoding: "utf8" }).trim().split(/\s+/);
}
const root = process.env.PASEO_SCREEN_ROOT || path.join(homedir(), ".local/share/paseo-screen");
const binary = path.join(root, "bin/vaapi-encoder-v1"), partial = `${binary}.${process.pid}.partial`;
mkdirSync(path.dirname(binary), { recursive: true, mode: 0o700 });
try {
  execFileSync("cc", ["-O2", "-std=c11", "-Wall", "-Wextra", "-Werror", source, ...flags, "-o", partial], { stdio: "inherit" });
  const version = JSON.parse(execFileSync(partial, ["--version"], { encoding: "utf8" }));
  if (version.protocol !== 1) throw new Error("Unexpected VA-API helper protocol");
  renameSync(partial, binary);
  writeFileSync(`${binary}.json`, JSON.stringify({ ...version, sourceHash: createHash("sha256").update(readFileSync(source)).digest("hex") }) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ binary, ...version }));
} finally { rmSync(partial, { force: true }); }
