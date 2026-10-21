// "Restart Perch Server" from the app, for changes that only take effect on
// a restart (an extension whose updated server code couldn't load in place,
// a terminal engine switch). Terminals live in the terminal daemon, which
// isn't restarted, so they keep running and the page reconnects to them.
//
// Offered only when the OS service started this server (systemd, launchd or
// Task Scheduler, each told to bring Perch back when it exits with a
// failure): the server exits with EX_TEMPFAIL (75) and the service manager
// starts it again. Anything else (a `perch start` background instance,
// npm run dev, the desktop app) gets the "run perch restart" hint instead:
// `perch restart` always prefers an installed service, so starting it from
// here could restart a different instance than this one.

export type RestartMethod = "service" | null;

export function restartMethod(): RestartMethod {
  const launcher = process.env.PERCH_LAUNCHER ?? "";
  if (launcher === "service") return "service";
  if (launcher) return null;
  // A systemd unit sets INVOCATION_ID for everything it starts; launchd sets
  // XPC_SERVICE_NAME to the job's label.
  if (process.env.INVOCATION_ID) return "service";
  if (/perch/i.test(process.env.XPC_SERVICE_NAME ?? "")) return "service";
  return null;
}

const EX_TEMPFAIL = 75;

// Starts the restart and returns; the server goes down shortly after, so
// the caller should answer its request first.
export function restartServer(): void {
  if (restartMethod() !== "service") {
    throw new Error("This Perch wasn't started by the system service: run perch restart where it runs.");
  }
  setTimeout(() => process.exit(EX_TEMPFAIL), 300);
}
