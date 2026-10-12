/** Shared with the trusted host broker; raw model command is matched before wrapping. */
export function buildPwdCaptureScript(command: string, pwdFile: string): string {
  const quoted = `'${pwdFile.replace(/'/g, "'\\''")}'`;
  return `${command}\n__winter_bash_rc=$?\npwd > ${quoted} 2>/dev/null\nexit "$__winter_bash_rc"\n`;
}
