/** Host-only bounded output capability. Numeric write descriptors are created by the trusted
 * host adapter; runtime RPC may never nominate descriptors, source paths or transport factories. */
export interface HostOutputTransport {
  stdoutFd: number;
  stderrFd: number;
  closeWriters(): void;
  pause(): void;
  resume(): void;
  start(onStdout: (chunk: Buffer) => void, onStderr: (chunk: Buffer) => void): Promise<unknown>;
  dispose(): void;
}
export type HostOutputTransportFactory = () => Promise<HostOutputTransport>;
