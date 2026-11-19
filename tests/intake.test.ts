import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync,
  statSync, lstatSync, symlinkSync, readlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { initDb, getDb } from "../server/src/db/index.js";
import { runMigrations } from "../server/src/db/migrate.js";
import { deriveKey } from "../server/src/lib/crypto.js";
import { upsertLibrary } from "../server/src/config/store.js";
import { jobs } from "../server/src/db/schema.js";
import { previewIntake, runIntake } from "../server/src/queue/intake.js";
import { enqueue, Worker, getJob } from "../server/src/queue/queue.js";
import { PathValidationError } from "../server/src/security/paths.js";
import { execFileSync } from "node:child_process";

/** node has no mkfifo; the point is a directory entry that is not a regular file. */
function mkfifoSync(path: string): void {
  execFileSync("mkfifo", [path]);
}

let root: string;
let dataDir: string;
const masterKey = deriveKey("intake-test-master-key");

function libDir(...p: string[]) { return join(root, ...p); }

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "torhq-intake-"));
  dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(libDir("downloads"), { recursive: true });
  mkdirSync(libDir("staging", "manga"), { recursive: true });
  mkdirSync(libDir("libraries", "manga"), { recursive: true });
  mkdirSync(libDir("staging", "seeded"), { recursive: true });
  mkdirSync(libDir("libraries", "seeded"), { recursive: true });

  initDb(dataDir);
  runMigrations();
  upsertLibrary({
    key: "kavita-manga", label: "Manga", kind: "manga", targetService: "kavita",
    destPath: libDir("libraries", "manga"), stagingPath: libDir("staging", "manga"),
    rescan: true, importMode: "move",
  });
  // The same library wired for hardlink imports, so a torrent can keep seeding
  // from the source after its content has been imported.
  upsertLibrary({
    key: "kavita-seeded", label: "Seeded", kind: "manga", targetService: "kavita",
    destPath: libDir("libraries", "seeded"), stagingPath: libDir("staging", "seeded"),
    rescan: true, importMode: "link",
  });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

beforeEach(() => {
  // Clear the jobs table so each test starts clean.
  getDb().delete(jobs).run();
});

/** Create a source folder with a couple of files under downloads/. */
function makeSource(name: string): string {
  const src = libDir("downloads", name);
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "ch1.cbz"), "chapter one");
  writeFileSync(join(src, "ch2.cbz"), "chapter two");
  return src;
}

describe("previewIntake", () => {
  it("lists entries and computes the destination without touching disk", async () => {
    const src = makeSource("Preview Series");
    const p = await previewIntake({ libraryKey: "kavita-manga", sourcePath: src }, [root]);
    expect(p.entries.map((e) => e.name).sort()).toEqual(["ch1.cbz", "ch2.cbz"]);
    expect(p.totalBytes).toBeGreaterThan(0);
    expect(p.destPath).toBe(libDir("libraries", "manga", "Preview Series"));
    // Preview must not move anything.
    expect(existsSync(src)).toBe(true);
    expect(existsSync(p.destPath)).toBe(false);
  });

  it("rejects a source that escapes approved roots", async () => {
    await expect(previewIntake({ libraryKey: "kavita-manga", sourcePath: "/etc/passwd" }, [root]))
      .rejects.toThrow(PathValidationError);
  });

  it("honors a safe targetName for the destination", async () => {
    const src = makeSource("raw-name");
    const p = await previewIntake({ libraryKey: "kavita-manga", sourcePath: src, targetName: "Clean Name" }, [root]);
    expect(p.destPath).toBe(libDir("libraries", "manga", "Clean Name"));
  });
});

describe("previewIntake when the destination name is taken", () => {
  it("warns that the destination already exists", async () => {
    const src = makeSource("Taken Preview");
    const dest = libDir("libraries", "manga", "Taken Preview");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "other.cbz"), "a different book");

    const p = await previewIntake({ libraryKey: "kavita-manga", sourcePath: src }, [root]);
    const text = p.warnings.join(" ");
    expect(text).toContain("already exists");
    expect(text).toContain(dest);
    expect(text).toContain("nothing will be deleted");
    // Still only a preview.
    expect(readdirSync(src).sort()).toEqual(["ch1.cbz", "ch2.cbz"]);
    expect(readdirSync(dest)).toEqual(["other.cbz"]);
  });

  it("says so when the destination holds the same files", async () => {
    const src = makeSource("Same Preview");
    const dest = libDir("libraries", "manga", "Same Preview");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "ch1.cbz"), "chapter one");
    writeFileSync(join(dest, "ch2.cbz"), "chapter two");

    const p = await previewIntake({ libraryKey: "kavita-manga", sourcePath: src }, [root]);
    const text = p.warnings.join(" ");
    expect(text).toContain("already exists");
    expect(text).toContain("same files");
  });

  it("gives no such warning when the destination is free", async () => {
    const src = makeSource("Free Preview");
    const p = await previewIntake({ libraryKey: "kavita-manga", sourcePath: src }, [root]);
    expect(p.warnings.join(" ")).not.toContain("already exists");
  });
});

describe("runIntake when the destination name is taken", () => {
  /** A library item that is NOT the download: same folder name, another file. */
  function makeOther(library: string, name: string): string {
    const dest = libDir("libraries", library, name);
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "old-edition.epub"), "the edition already held");
    return dest;
  }
  function makeDownload(name: string): string {
    const src = libDir("downloads", name);
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "new-edition.epub"), "a newer, different edition");
    return src;
  }

  it("move mode: refuses, keeps the download and leaves the library alone", async () => {
    const dest = makeOther("manga", "Greatest Hits");
    const src = makeDownload("Greatest Hits");

    const run = runIntake("job-taken-move", { libraryKey: "kavita-manga", sourcePath: src }, [root], masterKey);
    await expect(run).rejects.toThrow(/nothing was deleted/);
    await expect(
      runIntake("job-taken-move-2", { libraryKey: "kavita-manga", sourcePath: src }, [root], masterKey),
    ).rejects.toThrow(dest);

    expect(readdirSync(src)).toEqual(["new-edition.epub"]);
    expect(statSync(join(src, "new-edition.epub")).size).toBe("a newer, different edition".length);
    expect(readdirSync(dest)).toEqual(["old-edition.epub"]);
    expect(readdirSync(libDir("staging", "manga"))).toEqual([]);
  });

  it("link mode: refuses instead of reporting an import", async () => {
    const dest = makeOther("seeded", "Greatest Hits");
    const src = makeDownload("Greatest Hits Seeded");

    const run = runIntake(
      "job-taken-link",
      { libraryKey: "kavita-seeded", sourcePath: src, targetName: "Greatest Hits" },
      [root], masterKey,
    );
    await expect(run).rejects.toThrow(/nothing was deleted/);

    expect(readdirSync(src)).toEqual(["new-edition.epub"]);
    expect(readdirSync(dest)).toEqual(["old-edition.epub"]);
    expect(readdirSync(libDir("staging", "seeded"))).toEqual([]);
  });

  it("refuses when the names match but a size differs", async () => {
    const dest = libDir("libraries", "manga", "Size Series");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "ch1.cbz"), "chapter one");
    writeFileSync(join(dest, "ch2.cbz"), "a longer second chapter");
    const src = makeSource("Size Series");

    await expect(runIntake("job-size", { libraryKey: "kavita-manga", sourcePath: src }, [root], masterKey))
      .rejects.toThrow(/nothing was deleted/);
    expect(readdirSync(src).sort()).toEqual(["ch1.cbz", "ch2.cbz"]);
  });

  it("refuses when a file sits where the download is a folder", async () => {
    const dest = libDir("libraries", "manga", "Shape Series");
    writeFileSync(dest, "a single file with the folder's name");
    const src = makeSource("Shape Series");

    await expect(runIntake("job-shape", { libraryKey: "kavita-manga", sourcePath: src }, [root], masterKey))
      .rejects.toThrow(/nothing was deleted/);
    expect(existsSync(src)).toBe(true);
    expect(statSync(dest).isFile()).toBe(true);
  });

  it("crash retry: same files and sizes at the destination finishes cleanly", async () => {
    // What a crash between the atomic rename and the source cleanup leaves.
    const src = libDir("downloads", "Retry Series");
    const dest = libDir("libraries", "manga", "Retry Series");
    for (const base of [src, dest]) {
      mkdirSync(join(base, "Vol 1"), { recursive: true });
      writeFileSync(join(base, "Vol 1", "ch1.cbz"), "chapter one");
      writeFileSync(join(base, "cover.jpg"), "cover");
    }

    const res = await runIntake("job-retry", { libraryKey: "kavita-manga", sourcePath: src }, [root], masterKey);
    expect(res.alreadyImported).toBe(true);
    expect(existsSync(src)).toBe(false);
    expect(readdirSync(dest).sort()).toEqual(["Vol 1", "cover.jpg"]);
  });

  it("ignores symlinks when comparing", async () => {
    const src = makeSource("Symlink Retry");
    symlinkSync("../elsewhere/target.cbz", join(src, "link.cbz"));
    const dest = libDir("libraries", "manga", "Symlink Retry");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "ch1.cbz"), "chapter one");
    writeFileSync(join(dest, "ch2.cbz"), "chapter two");

    const res = await runIntake("job-symretry", { libraryKey: "kavita-manga", sourcePath: src }, [root], masterKey);
    expect(res.alreadyImported).toBe(true);
  });
});

describe("runIntake state machine", () => {
  it("stages then atomically imports, consuming the source and clearing staging", async () => {
    const src = makeSource("Real Series");
    const res = await runIntake("job-import", { libraryKey: "kavita-manga", sourcePath: src }, [root], masterKey);

    expect(res.alreadyImported).toBe(false);
    const dest = libDir("libraries", "manga", "Real Series");
    expect(res.destPath).toBe(dest);
    // Imported content is present at the destination.
    expect(readdirSync(dest).sort()).toEqual(["ch1.cbz", "ch2.cbz"]);
    // Source consumed.
    expect(existsSync(src)).toBe(false);
    // Staging left clean — no hidden .intake-* remnants.
    expect(readdirSync(libDir("staging", "manga"))).toEqual([]);
  });

  it("is idempotent: a second run with the destination present does not duplicate", async () => {
    const src = makeSource("Idem Series");
    await runIntake("job-1", { libraryKey: "kavita-manga", sourcePath: src }, [root], masterKey);

    // Re-create the source and run again with the same target — dest already there.
    const src2 = makeSource("Idem Series");
    const res = await runIntake("job-2", { libraryKey: "kavita-manga", sourcePath: src2 }, [root], masterKey);
    expect(res.alreadyImported).toBe(true);
    // Destination still has exactly the original two files.
    expect(readdirSync(libDir("libraries", "manga", "Idem Series")).sort()).toEqual(["ch1.cbz", "ch2.cbz"]);
    // The redundant source was cleaned up too.
    expect(existsSync(src2)).toBe(false);
  });

  it("succeeds idempotently when the source is already gone but the destination exists", async () => {
    // Pre-place a destination directly.
    const dest = libDir("libraries", "manga", "Ghost Series");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "vol1.cbz"), "x");
    const res = await runIntake(
      "job-ghost",
      { libraryKey: "kavita-manga", sourcePath: libDir("downloads", "Ghost Series") },
      [root], masterKey,
    );
    expect(res.alreadyImported).toBe(true);
  });

  it("throws a path error when neither source nor destination exists", async () => {
    await expect(runIntake(
      "job-missing",
      { libraryKey: "kavita-manga", sourcePath: libDir("downloads", "Nope") },
      [root], masterKey,
    )).rejects.toThrow(PathValidationError);
  });
});

describe("hardlink import mode", () => {
  // The point of link mode: import without copying bytes and without taking the
  // files away from whatever is still using them — a seeding torrent, usually.
  it("imports without copying and leaves the source in place", async () => {
    const src = makeSource("Linked Series");
    const res = await runIntake("job-link", { libraryKey: "kavita-seeded", sourcePath: src }, [root], masterKey);

    const dest = libDir("libraries", "seeded", "Linked Series");
    expect(res.destPath).toBe(dest);
    expect(readdirSync(dest).sort()).toEqual(["ch1.cbz", "ch2.cbz"]);
    // The source survives, intact.
    expect(readdirSync(src).sort()).toEqual(["ch1.cbz", "ch2.cbz"]);
    expect(readdirSync(libDir("staging", "seeded"))).toEqual([]);
  });

  it("shares inodes rather than duplicating the data", async () => {
    const src = makeSource("Inode Series");
    await runIntake("job-inode", { libraryKey: "kavita-seeded", sourcePath: src }, [root], masterKey);
    const a = statSync(join(src, "ch1.cbz"));
    const b = statSync(libDir("libraries", "seeded", "Inode Series", "ch1.cbz"));
    expect(b.ino).toBe(a.ino);
    expect(b.nlink).toBe(2);
  });

  it("recreates symlinks verbatim instead of linking through them", async () => {
    const src = makeSource("Symlink Series");
    symlinkSync("../elsewhere/target.cbz", join(src, "link.cbz"));
    await runIntake("job-symlink", { libraryKey: "kavita-seeded", sourcePath: src }, [root], masterKey);
    const imported = libDir("libraries", "seeded", "Symlink Series", "link.cbz");
    expect(lstatSync(imported).isSymbolicLink()).toBe(true);
    expect(readlinkSync(imported)).toBe("../elsewhere/target.cbz");
  });

  it("does not delete the source on the idempotent already-imported path", async () => {
    const src = makeSource("Twice Series");
    await runIntake("job-twice-1", { libraryKey: "kavita-seeded", sourcePath: src }, [root], masterKey);
    const res = await runIntake("job-twice-2", { libraryKey: "kavita-seeded", sourcePath: src }, [root], masterKey);
    expect(res.alreadyImported).toBe(true);
    expect(existsSync(src)).toBe(true);
  });

  it("links a single-file source, not just a directory", async () => {
    const src = libDir("downloads", "Single.cbz");
    writeFileSync(src, "one chapter");
    await runIntake("job-single", { libraryKey: "kavita-seeded", sourcePath: src }, [root], masterKey);
    const dest = libDir("libraries", "seeded", "Single.cbz");
    expect(statSync(dest).ino).toBe(statSync(src).ino);
    expect(existsSync(src)).toBe(true);
  });

  it("reproduces a nested directory tree rather than flattening it", async () => {
    const src = libDir("downloads", "Nested Series");
    mkdirSync(join(src, "Vol 1", "extras"), { recursive: true });
    writeFileSync(join(src, "Vol 1", "ch1.cbz"), "a");
    writeFileSync(join(src, "Vol 1", "extras", "cover.jpg"), "b");
    await runIntake("job-nested", { libraryKey: "kavita-seeded", sourcePath: src }, [root], masterKey);

    const dest = libDir("libraries", "seeded", "Nested Series");
    expect(readdirSync(join(dest, "Vol 1")).sort()).toEqual(["ch1.cbz", "extras"]);
    expect(statSync(join(dest, "Vol 1", "extras", "cover.jpg")).ino)
      .toBe(statSync(join(src, "Vol 1", "extras", "cover.jpg")).ino);
  });

  it("leaves no staging remnant when the link step fails", async () => {
    // A source containing something that cannot be hardlinked: the import must
    // fail, and it must not leave a half-built tree behind for the next attempt.
    const src = libDir("downloads", "Broken Series");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "ok.cbz"), "fine");
    mkfifoSync(join(src, "pipe"));

    await expect(runIntake("job-broken", { libraryKey: "kavita-seeded", sourcePath: src }, [root], masterKey))
      .rejects.toThrow(/not a regular file/);
    expect(readdirSync(libDir("staging", "seeded"))).toEqual([]);
    expect(existsSync(libDir("libraries", "seeded", "Broken Series"))).toBe(false);
    expect(existsSync(src)).toBe(true); // and the source is untouched
  });

  it("warns about deletion only for a library that actually deletes", async () => {
    const move = await previewIntake({ libraryKey: "kavita-manga", sourcePath: makeSource("W1") }, [root]);
    const link = await previewIntake({ libraryKey: "kavita-seeded", sourcePath: makeSource("W2") }, [root]);
    expect(move.importMode).toBe("move");
    expect(move.warnings.join(" ")).toContain("deleted");
    expect(link.importMode).toBe("link");
    expect(link.warnings.join(" ")).not.toContain("deleted");
  });
});

describe("durable queue + worker", () => {
  it("enqueue is idempotent on idempotencyKey", () => {
    const a = enqueue({ type: "manual_intake", payload: { libraryKey: "kavita-manga", sourcePath: libDir("downloads", "x") }, idempotencyKey: "dup" });
    const b = enqueue({ type: "manual_intake", payload: { libraryKey: "kavita-manga", sourcePath: libDir("downloads", "y") }, idempotencyKey: "dup" });
    expect(a.id).toBe(b.id);
  });

  it("processes a queued job to completion", async () => {
    const src = makeSource("Worker Series");
    const job = enqueue({ type: "manual_intake", payload: { libraryKey: "kavita-manga", sourcePath: src } });
    const worker = new Worker([root], masterKey);
    await worker.tick();
    const done = getJob(job.id)!;
    expect(done.status).toBe("completed");
    expect(existsSync(libDir("libraries", "manga", "Worker Series"))).toBe(true);
  });

  it("recovers a job orphaned in 'running' by a prior crash", async () => {
    const src = makeSource("Crashed Series");
    const job = enqueue({ type: "manual_intake", payload: { libraryKey: "kavita-manga", sourcePath: src } });
    // Simulate a crash mid-process: the job is stuck in 'running'.
    getDb().update(jobs).set({ status: "running" }).where(eq(jobs.id, job.id)).run();

    const worker = new Worker([root], masterKey);
    const recovered = worker.recoverOrphans();
    expect(recovered).toBe(1);
    expect(getJob(job.id)!.status).toBe("queued");

    await worker.tick();
    expect(getJob(job.id)!.status).toBe("completed");
    expect(existsSync(libDir("libraries", "manga", "Crashed Series"))).toBe(true);
  });

  it("re-queues a failing job with backoff, then marks it dead at maxAttempts", async () => {
    // Non-existent source and no destination → each attempt fails.
    const job = enqueue({
      type: "manual_intake",
      payload: { libraryKey: "kavita-manga", sourcePath: libDir("downloads", "does-not-exist") },
      maxAttempts: 2,
    });
    const worker = new Worker([root], masterKey);

    await worker.tick(); // attempt 1 → back to queued
    let j = getJob(job.id)!;
    expect(j.attempts).toBe(1);
    expect(j.status).toBe("queued");
    expect(j.lastError).toBeTruthy();
    expect(j.nextRunAt).toBeGreaterThan(Date.now()); // backoff scheduled

    // Force it due again and run the final attempt.
    getDb().update(jobs).set({ nextRunAt: Date.now() - 1 }).where(eq(jobs.id, job.id)).run();
    await worker.tick(); // attempt 2 → dead
    j = getJob(job.id)!;
    expect(j.attempts).toBe(2);
    expect(j.status).toBe("dead");
  });

  it("fails a job whose destination name is taken by something else, and never deletes the download", async () => {
    const dest = libDir("libraries", "manga", "Queue Clash");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "old-edition.epub"), "the edition already held");
    const src = libDir("downloads", "Queue Clash");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "new-edition.epub"), "a newer, different edition");

    const job = enqueue({
      type: "manual_intake",
      payload: { libraryKey: "kavita-manga", sourcePath: src },
      maxAttempts: 2,
    });
    const worker = new Worker([root], masterKey);

    await worker.tick(); // attempt 1 → back to queued
    let j = getJob(job.id)!;
    expect(j.attempts).toBe(1);
    expect(j.status).toBe("queued");
    expect(j.lastError).toContain("nothing was deleted");
    expect(j.lastError).toContain(dest);
    expect(readdirSync(src)).toEqual(["new-edition.epub"]);

    getDb().update(jobs).set({ nextRunAt: Date.now() - 1 }).where(eq(jobs.id, job.id)).run();
    await worker.tick(); // attempt 2 → dead
    j = getJob(job.id)!;
    expect(j.attempts).toBe(2);
    expect(j.status).toBe("dead");
    expect(j.lastError).toContain("nothing was deleted");
    expect(readdirSync(src)).toEqual(["new-edition.epub"]);
    expect(readdirSync(dest)).toEqual(["old-edition.epub"]);
  });
});
