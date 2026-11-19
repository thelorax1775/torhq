import { realpathSync, lstatSync } from "node:fs";
import { resolve, sep, isAbsolute, join, dirname, basename } from "node:path";

export class PathValidationError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "PathValidationError";
  }
}

/** Normalize an approved root to an absolute, trailing-sep form for prefix checks. */
function withSep(p: string): string {
  return p.endsWith(sep) ? p : p + sep;
}

/**
 * Pure containment check: is `candidate` inside `root` (or equal to it)?
 * Operates on already-resolved absolute paths; no filesystem access.
 * Guards against prefix aliasing (/srv/torhq vs /srv/torhq-evil).
 */
export function isWithinRoot(candidate: string, root: string): boolean {
  const c = resolve(candidate);
  const r = resolve(root);
  if (c === r) return true;
  return c.startsWith(withSep(r));
}

/** Is the candidate inside ANY approved root? */
export function isWithinApprovedRoots(candidate: string, roots: string[]): boolean {
  return roots.some((r) => isWithinRoot(candidate, r));
}

export interface ResolveOptions {
  /** Require the path to already exist on disk (default true). */
  mustExist?: boolean;
  /** Reject symlinks anywhere in the resolved chain that escape roots (default true). */
  denySymlinks?: boolean;
}

/**
 * Validate & canonicalize a filesystem path against approved roots.
 *
 * Defense in depth:
 *  1. Lexical resolve() collapses `..` / `.` traversal before any FS touch.
 *  2. Lexical containment check against approved roots.
 *  3. realpath() resolves symlinks; the REAL target must also be contained
 *     (blocks symlink-escape out of an approved root).
 *
 * Returns the canonical real path when it exists, otherwise the lexically
 * resolved path (for not-yet-created destinations).
 */
export function safeResolve(
  inputPath: string,
  approvedRoots: string[],
  opts: ResolveOptions = {},
): string {
  const { mustExist = true, denySymlinks = true } = opts;

  if (!inputPath || typeof inputPath !== "string") {
    throw new PathValidationError("Empty path", "EMPTY");
  }
  if (inputPath.includes("\0")) {
    throw new PathValidationError("Null byte in path", "NULL_BYTE");
  }
  if (!isAbsolute(inputPath)) {
    throw new PathValidationError("Path must be absolute", "NOT_ABSOLUTE");
  }

  const lexical = resolve(inputPath);

  // Step 2: lexical containment (defends even if the path does not exist yet).
  if (!isWithinApprovedRoots(lexical, approvedRoots)) {
    throw new PathValidationError(
      `Path escapes approved roots: ${lexical}`,
      "OUTSIDE_ROOT",
    );
  }

  let real: string;
  try {
    real = realpathSync(lexical);
  } catch (err: unknown) {
    if (mustExist) {
      throw new PathValidationError(`Path does not exist: ${lexical}`, "NOT_FOUND");
    }
    // Not-yet-created destination: resolve the deepest ancestor that exists and
    // require THAT real folder to be approved, so a symlinked parent cannot
    // lead a new path outside the roots.
    let ancestor = lexical;
    const rest: string[] = [];
    for (;;) {
      let present = true;
      try { lstatSync(ancestor); } catch { present = false; }
      if (present) {
        try {
          const realAncestor = realpathSync(ancestor);
          if (!isWithinApprovedRoots(realAncestor, approvedRoots)) {
            throw new PathValidationError(
              `Symlink target escapes approved roots: ${realAncestor}`,
              "SYMLINK_ESCAPE",
            );
          }
          return rest.length ? join(realAncestor, ...rest) : realAncestor;
        } catch (e) {
          if (e instanceof PathValidationError) throw e;
          // Present but unresolvable (a dangling symlink): writing through it
          // would land somewhere unchecked.
          throw new PathValidationError(`Broken symlink in path: ${ancestor}`, "SYMLINK_ESCAPE");
        }
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) return lexical;
      rest.unshift(basename(ancestor));
      ancestor = parent;
    }
  }

  // Step 3: the symlink-resolved real path must ALSO be contained.
  if (!isWithinApprovedRoots(real, approvedRoots)) {
    throw new PathValidationError(
      `Symlink target escapes approved roots: ${real}`,
      "SYMLINK_ESCAPE",
    );
  }

  if (denySymlinks) {
    try {
      if (lstatSync(lexical).isSymbolicLink() && real !== lexical) {
        // A symlink is allowed only if it stays within roots (already checked),
        // but we surface it so callers can decide. Here we reject by default.
        throw new PathValidationError(`Symlink not allowed: ${lexical}`, "SYMLINK");
      }
    } catch (e) {
      if (e instanceof PathValidationError) throw e;
      // lstat race — ignore, real path already validated.
    }
  }

  return real;
}

/** Reject unsafe filename characters and produce a safe basename. */
export function safeFilename(name: string): string {
  const base = name.replace(/^.*[\\/]/, ""); // strip any dir components
  const cleaned = base
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[<>:"|?*]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .trim();
  if (!cleaned || cleaned === "." || cleaned === "..") {
    throw new PathValidationError("Invalid filename", "BAD_FILENAME");
  }
  return cleaned.slice(0, 255);
}
