import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  safeResolve, isWithinRoot, safeFilename, PathValidationError,
} from "../server/src/security/paths.js";

let root: string;
let outside: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "torhq-root-"));
  outside = mkdtempSync(join(tmpdir(), "torhq-out-"));
  mkdirSync(join(root, "libraries", "music"), { recursive: true });
  writeFileSync(join(root, "libraries", "music", "song.flac"), "x");
  writeFileSync(join(outside, "secret.txt"), "top secret");
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("isWithinRoot", () => {
  it("accepts a path inside the root", () => {
    expect(isWithinRoot("/srv/torhq/libraries/x", "/srv/torhq")).toBe(true);
  });
  it("accepts the root itself", () => {
    expect(isWithinRoot("/srv/torhq", "/srv/torhq")).toBe(true);
  });
  it("rejects prefix-aliasing siblings", () => {
    // /srv/torhq-evil must NOT be considered inside /srv/torhq
    expect(isWithinRoot("/srv/torhq-evil/x", "/srv/torhq")).toBe(false);
  });
  it("rejects a parent path", () => {
    expect(isWithinRoot("/srv", "/srv/torhq")).toBe(false);
  });
});

describe("safeResolve traversal defense", () => {
  it("resolves a legitimate existing path", () => {
    const p = safeResolve(join(root, "libraries", "music", "song.flac"), [root]);
    expect(p).toContain("song.flac");
  });
  it("blocks ../ traversal escaping the root", () => {
    expect(() => safeResolve(join(root, "..", "etc", "passwd"), [root]))
      .toThrow(PathValidationError);
  });
  it("blocks absolute paths outside approved roots", () => {
    expect(() => safeResolve("/etc/passwd", [root])).toThrow(/OUTSIDE_ROOT|escapes/);
  });
  it("rejects relative paths", () => {
    expect(() => safeResolve("relative/path", [root])).toThrow(/absolute/i);
  });
  it("rejects null bytes", () => {
    expect(() => safeResolve("/srv/torhq/a\0b", [root])).toThrow(/null/i);
  });
  it("allows a not-yet-existing destination inside root when mustExist=false", () => {
    const dest = join(root, "libraries", "music", "new-album");
    expect(safeResolve(dest, [root], { mustExist: false })).toContain("new-album");
  });
  it("throws NOT_FOUND for missing path when mustExist=true", () => {
    expect(() => safeResolve(join(root, "nope"), [root])).toThrow(/does not exist/i);
  });
});

describe("symlink escape defense", () => {
  it("rejects a symlink whose target is outside approved roots", () => {
    const link = join(root, "escape-link");
    try { symlinkSync(join(outside, "secret.txt"), link); }
    catch { return; } // symlink may be unsupported in CI; skip silently
    expect(() => safeResolve(link, [root])).toThrow(PathValidationError);
  });
});

describe("safeFilename", () => {
  it("strips directory components", () => {
    expect(safeFilename("../../etc/passwd")).toBe("passwd");
  });
  it("replaces unsafe characters", () => {
    expect(safeFilename('a<b>c:d"e|f?g*h')).toBe("a_b_c_d_e_f_g_h");
  });
  it("rejects dot-only names", () => {
    expect(() => safeFilename("..")).toThrow(PathValidationError);
  });
  it("keeps a normal filename", () => {
    expect(safeFilename("Artist - Album (2024).flac")).toBe("Artist - Album (2024).flac");
  });
});

describe("not-yet-existing paths under a symlinked parent", () => {
  const mk = (): { link: string } => {
    const link = join(root, "link-new");
    symlinkSync(outside, link);
    return { link };
  };
  it("rejects a new path under a symlink that leaves the roots", () => {
    const { link } = mk();
    try {
      expect(() => safeResolve(join(link, "new"), [root], { mustExist: false })).toThrow(PathValidationError);
      try { safeResolve(join(link, "new"), [root], { mustExist: false }); } catch (e) { expect((e as PathValidationError).code).toBe("SYMLINK_ESCAPE"); }
    } finally { rmSync(link); }
  });
  it("rejects it with several missing levels", () => {
    const { link } = mk();
    try {
      let code = "";
      try { safeResolve(join(link, "a", "b", "c"), [root], { mustExist: false }); } catch (e) { code = (e as PathValidationError).code; }
      expect(code).toBe("SYMLINK_ESCAPE");
    } finally { rmSync(link); }
  });
  it("returns the real path when the symlink stays inside the roots", () => {
    const real = join(root, "real-dir");
    mkdirSync(real, { recursive: true });
    const inlink = join(root, "inlink");
    symlinkSync(real, inlink);
    try {
      expect(safeResolve(join(inlink, "new"), [root], { mustExist: false })).toBe(join(realpathSync(real), "new"));
    } finally { rmSync(inlink); }
  });
  it("still returns a new path under a real folder", () => {
    const dest = join(root, "libraries", "music", "another-album");
    expect(safeResolve(dest, [root], { mustExist: false })).toBe(join(realpathSync(root), "libraries", "music", "another-album"));
  });
});
