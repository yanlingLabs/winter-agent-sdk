// WS-21 lane L1b, Task L1b.4 (controller-narrowed to this file only; spec §6.3 item 12, F18):
// claude stores file checkpoints at `file-history/<sessionId>/`, not `backups/<uuid>/` -- the R5-11
// amendment's own report-over-brief ruling is REVERSED here, now that WS-21 makes the layout track
// claude's on purpose rather than by accident. This file's own header (`:5-11`ish, above) carries the
// citation; this test pins the two primitives everything else in `checkpoint/` builds on.
//
// The FLOORS that still name `backups` (`permissions/protected.ts`, `sandbox/profile.ts`,
// `engine.ts`'s `["projects","backups"]`) are OUT OF SCOPE for this task by controller ruling --
// they land in lane L1a's own fix round, not here.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CHECKPOINT_DIRNAME, sessionCheckpointDir } from "./file-history.ts";

describe("the renamed checkpoint layout (F18): file-history/<sessionId>/, not backups/<uuid>/", () => {
  test("CHECKPOINT_DIRNAME is \"file-history\"", () => {
    expect(CHECKPOINT_DIRNAME).toBe("file-history");
  });

  test("sessionCheckpointDir joins <home>/file-history/<sessionId>", () => {
    expect(sessionCheckpointDir("/home/.winter/sdk", "sess-1")).toBe(join("/home/.winter/sdk", "file-history", "sess-1"));
  });
});
