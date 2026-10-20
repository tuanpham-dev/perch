// Tells App that opening a folder just created its session, so it can offer
// the folder's .perch/project.json terminal setup (see App.tsx and
// components/ProjectSetupDialog.tsx). useSessionActions' openProject calls
// notifyProjectCreated; App registers the handler. Re-focusing a session
// that already existed doesn't fire: the offer belongs to opening a project.
let handler: ((sessionName: string, cwd: string) => void) | null = null;

export function setProjectCreatedHandler(fn: ((sessionName: string, cwd: string) => void) | null): void {
  handler = fn;
}

export function notifyProjectCreated(sessionName: string, cwd: string): void {
  handler?.(sessionName, cwd);
}
