import { useEffect, useRef } from "react";
import type { ProjectSetupTerminalDto } from "../api";

// The review shown before a project's .perch/project.json opens any
// terminals: every terminal's name, folder and exact command, because those
// commands come from the repository. Also the preview for "Project: Save
// Terminal Setup", where the file about to be written is shown instead.
export type ProjectSetupDialogProps =
  | {
      mode: "review";
      projectName: string;
      terminals: ProjectSetupTerminalDto[];
      changed: boolean;
      onOpen: () => void;
      onNotNow: () => void;
      onNever: () => void;
    }
  | {
      mode: "save";
      projectName: string;
      content: string;
      exists: boolean;
      onSave: () => void;
      onCancel: () => void;
    };

export default function ProjectSetupDialog(props: ProjectSetupDialogProps) {
  const primary = useRef<HTMLButtonElement>(null);
  useEffect(() => primary.current?.focus(), []);
  const cancel = props.mode === "review" ? props.onNotNow : props.onCancel;

  return (
    <div className="dialog-overlay" onMouseDown={cancel}>
      <div
        className="dialog project-setup-dialog"
        role="dialog"
        aria-label={props.mode === "review" ? "Open terminal setup" : "Save terminal setup"}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          }
        }}
      >
        {props.mode === "review" ? (
          <>
            <div className="dialog-title">Open terminal setup for "{props.projectName}"?</div>
            <div className="dialog-message">
              {props.changed
                ? "This folder's .perch/project.json changed since you last opened it. It will open "
                : "This folder's .perch/project.json will open "}
              {props.terminals.length === 1 ? "1 terminal" : `${props.terminals.length} terminals`} and run these commands:
            </div>
            <div className="project-setup-table" role="table">
              {props.terminals.map((t) => (
                <div key={t.name} className="project-setup-row" role="row">
                  <span className="project-setup-name" role="cell">{t.name}</span>
                  <span className="project-setup-cwd" role="cell">{t.cwd ? `./${t.cwd}` : "./"}</span>
                  <code className="project-setup-command" role="cell">{t.command ?? "(a shell)"}</code>
                </div>
              ))}
            </div>
            <div className="project-setup-warning">Commands come from the repository. Only open them if you trust it.</div>
            <div className="dialog-buttons project-setup-buttons">
              <button className="dialog-button secondary" onClick={props.onNever}>
                Never for This Folder
              </button>
              <button className="dialog-button secondary" onClick={props.onNotNow}>
                Not Now
              </button>
              <button ref={primary} className="dialog-button primary" onClick={props.onOpen}>
                Open Terminals
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="dialog-title">Save terminal setup for "{props.projectName}"</div>
            <div className="dialog-message">
              {props.exists
                ? ".perch/project.json already exists. Saving replaces it with:"
                : "This writes .perch/project.json in the project:"}
            </div>
            <pre className="project-setup-preview">{props.content}</pre>
            <div className="dialog-buttons">
              <button className="dialog-button secondary" onClick={props.onCancel}>
                Cancel
              </button>
              <button ref={primary} className="dialog-button primary" onClick={props.onSave}>
                {props.exists ? "Replace" : "Save"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
