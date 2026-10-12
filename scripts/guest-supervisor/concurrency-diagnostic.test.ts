import { expect, test } from "bun:test";
import { concurrencyDiagnostic, observeBuildFailure, observeBuildSuccess, type BuildObservation } from "./concurrency-diagnostic.ts";
const pending: BuildObservation[] = [{ phase: "pending" }, { phase: "pending" }];
const reads = () => Array.from({ length: 10 }, () => ({ output: "hello\n", isError: false }));

test("live build/read overlap, premature exit and timeout have distinct bounded classes", () => {
  const valid = concurrencyDiagnostic(0, pending, reads());
  expect(valid.failedConditions).toEqual({ buildsFinished: false, readErrors: false, readContent: false });
  expect(valid.reads).toEqual({ errors: 0, wrongContent: 0, exactHello: 10, errorCodes: {} });
  const early = concurrencyDiagnostic(1, [observeBuildSuccess({ exitCode: 0, termination: "exit" }), pending[1]!], reads());
  expect(early.failedConditions).toEqual({ buildsFinished: true, readErrors: false, readContent: false });
  expect(early.builds[0]).toEqual({ phase: "fulfilled", exitCode: 0, termination: "exit" });
  expect(observeBuildSuccess({ exitCode: 137, termination: "timeout" })).toEqual({ phase: "fulfilled", exitCode: 137, termination: "timeout" });
  expect(observeBuildSuccess({ exitCode: 1, termination: "output_limit" })).toEqual({ phase: "fulfilled", exitCode: 1, termination: "output_limit" });
});
test("known Read failures and wrong expected bytes are separate without output disclosure", () => {
  const input = reads(); input[0] = { isError: true, output: "Error [capacity_busy]: guest file operation refused" };
  input[1] = { isError: true, output: "Error [transport_lost]: private /path token=not-real" };
  input[2] = { isError: false, output: "unexpected private file contents" };
  const value = concurrencyDiagnostic(0, pending, input);
  expect(value.failedConditions).toEqual({ buildsFinished: false, readErrors: true, readContent: true });
  expect(value.reads).toEqual({ errors: 2, wrongContent: 1, exactHello: 7, errorCodes: { capacity_busy: 1, transport_lost: 1 } });
  expect(JSON.stringify(value)).not.toContain("private"); expect(JSON.stringify(value)).not.toContain("token");
});
test("unknown error text/codes never become diagnostic fields; failure identity is untouched", () => {
  const error = { code: "/secret/credential", effectsUncertain: true, message: "never disclose", authority: { token: "synthetic" } };
  expect(observeBuildFailure(error)).toEqual({ phase: "rejected", errorCode: "other", effectsUncertain: true });
  expect(error.message).toBe("never disclose");
  expect(observeBuildFailure({ code: "authority_denied", effectsUncertain: true })).toEqual({ phase: "rejected", errorCode: "authority_denied", effectsUncertain: true });
  const input = reads(); input[0] = { isError: true, output: "Error [secret_custom]: " + "private".repeat(10000) };
  const wire = JSON.stringify(concurrencyDiagnostic(1, [observeBuildFailure(error), pending[1]!], input));
  expect(wire.length).toBeLessThan(2048);
  for (const secret of ["secret_custom", "/secret", "never disclose", "private", "synthetic"]) expect(wire).not.toContain(secret);
});
test("diagnostic collectors cap unexpected cardinality and do not accept custom outcome enums", () => {
  expect(observeBuildSuccess({ exitCode: Infinity, termination: "/secret/path" })).toEqual({ phase: "fulfilled", exitCode: null, termination: "other" });
  expect(observeBuildFailure({ get code() { throw new Error("private failure"); } })).toEqual({ phase: "rejected", errorCode: "other", effectsUncertain: false });
  const value = concurrencyDiagnostic(999, [...pending, ...pending], Array.from({ length: 1000 }, () => ({ output: "hello\n" })));
  expect(value.finishedBuilds).toBeNull(); expect(value.builds).toHaveLength(2); expect(value.readCount).toBe(10); expect(value.inputShapeValid).toBe(false);
  const custom = concurrencyDiagnostic(1, [{ phase: "rejected", errorCode: "/secret/path", effectsUncertain: true }, pending[1]!], reads());
  expect(custom.builds[0]).toEqual({ phase: "rejected", errorCode: "other", effectsUncertain: true });
  expect(JSON.stringify(custom)).not.toContain("/secret");
});
