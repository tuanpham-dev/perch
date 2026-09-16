// Editor resolution over the extension registry — the `editor` setting's
// counterpart to engines/index.ts, and deliberately shaped like it: editors
// live in extensions registered via ctx.registerEditor, declared statically in
// their manifest so the Settings picker can list them without running any
// extension code, and resolved lazily so opening a file never activates more
// than the one extension it needs.
//
// Two things differ from engines. First, nvim is provided by core rather than
// by a required extension: its open path is entangled with host tab state (the
// window-tab created after `new-window`, the deferred-keystroke handshake, the
// active tab's attachName) that ctx.app doesn't expose, so extracting it would
// mean publishing fragile plumbing for no user-visible gain. The interface is
// the same either way, so it can move later without touching any consumer.
//
// Second, resolution is per *capability*. An editor declares what it can open
// — files, git diffs, merge conflicts — and anything it doesn't declare falls
// through to nvim, which claims all three. Only a broken install resolves to
// nothing, and the caller treats that as "use your own view".
import {
  activateExtensionById,
  extensionEditors,
  getInstalledExtensions,
  whenExtensionsListed,
  type DiffRequest,
  type MergeRequest,
  type RegisteredEditor,
} from "../extensions";
import type { EditorCapability } from "../types";

// The core provider's id — the `editor` setting's default, and the fallback
// for any capability the selected editor doesn't claim.
export const EDITOR_NVIM_ID = "nvim";

// Which installed extension declares (via contributes.editors) the given
// namespaced editor id, resolved from the static manifest list so this never
// activates anything just to find out. Namespaced the same way registerEditor
// does at activation time: ext.<extensionId>.<id>.
function findEditorOwner(editorId: string): string | null {
  for (const ext of getInstalledExtensions()) {
    if (ext.editors.some((e) => `ext.${ext.id}.${e.id}` === editorId)) return ext.id;
  }
  return null;
}

function claims(editor: RegisteredEditor, capability: EditorCapability): boolean {
  if (!editor.capabilities.includes(capability)) return false;
  if (capability === "diff") return typeof editor.openDiff === "function";
  if (capability === "merge") return typeof editor.openMerge === "function";
  return true;
}

// The core nvim provider, built once from App's own open-a-file plumbing.
// Registered here rather than in the extension registry so it can never be
// removed by an uninstall — the guaranteed floor, like xterm-engine is for
// terminals.
let nvimProvider: RegisteredEditor | null = null;

export interface NvimProviderDeps {
  openFile: (path: string, line?: number) => Promise<void>;
  openDiff: (req: DiffRequest) => Promise<void>;
  openMerge: (req: MergeRequest) => Promise<void>;
}

export function setNvimProvider(deps: NvimProviderDeps): void {
  nvimProvider = {
    id: EDITOR_NVIM_ID,
    extensionId: null,
    label: "nvim (terminal window)",
    capabilities: ["file", "diff", "merge"],
    openFile: deps.openFile,
    openDiff: deps.openDiff,
    openMerge: deps.openMerge,
  };
}

/**
 * The editor that should handle `capability` given the stored setting value.
 * Falls back to nvim for any capability the selection doesn't claim (including
 * a stale id whose extension was uninstalled), and returns null only when even
 * nvim is unavailable — which means App hasn't wired the provider yet.
 */
export async function resolveEditor(
  capability: EditorCapability,
  selected: string,
): Promise<RegisteredEditor | null> {
  const fallback = nvimProvider && claims(nvimProvider, capability) ? nvimProvider : null;
  if (selected === EDITOR_NVIM_ID) return fallback;

  await whenExtensionsListed();
  const owner = findEditorOwner(selected);
  // No owner means the setting names an extension that's gone (uninstalled or
  // disabled) — nothing to activate, go straight to nvim.
  if (owner) await activateExtensionById(owner);
  const editor = extensionEditors.find((e) => e.id === selected);
  return editor && claims(editor, capability) ? editor : fallback;
}
