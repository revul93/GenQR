/**
 * Process lifecycle helpers. Under systemd (Restart=always) exiting cleanly is a restart;
 * elsewhere the operator must start the process again.
 */

let shutdownHandler: ((reason: string) => void) | undefined;

export function onShutdown(handler: (reason: string) => void): void {
  shutdownHandler = handler;
}

/** True when a service manager will start the process again after it exits. */
export const canSelfRestart = () => !!process.env.INVOCATION_ID || process.env.GENQR_SUPERVISED === '1';

export function restartSoon(delayMs = 1500): void {
  setTimeout(() => (shutdownHandler ? shutdownHandler('restart') : process.exit(0)), delayMs);
}
