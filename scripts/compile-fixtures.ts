export async function compile(tsconfig: string): Promise<{ ok: boolean; output: string }> {
  const proc = Bun.spawn(["bunx", "tsc", "--noEmit", "-p", tsconfig], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
  return { ok: (await proc.exited) === 0, output: out };
}
