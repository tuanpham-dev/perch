import { useCallback, useState } from "react";
import type { DialogRequest } from "../components/Dialog";
import type { PickItem } from "../lib/pickFilter";

// Blocking confirm/prompt dialogs, resolved via the shared <Dialog> host
// rendered in App's JSX. Self-contained — no dependency on any other hook.
export function useDialogs() {
  const [dialog, setDialog] = useState<DialogRequest | null>(null);

  const confirmDialog = useCallback(
    (message: string, confirmLabel = "OK") =>
      new Promise<boolean>((res) => {
        setDialog({
          type: "confirm",
          message,
          danger: true,
          confirmLabel,
          resolve: (v) => {
            setDialog(null);
            res(Boolean(v));
          },
        });
      }),
    [],
  );

  const promptDialog = useCallback(
    (message: string, defaultValue = "") =>
      new Promise<string | null>((res) => {
        setDialog({
          type: "prompt",
          message,
          defaultValue,
          resolve: (v) => {
            setDialog(null);
            res(v === null || v === false ? null : String(v));
          },
        });
      }),
    [],
  );

  // A filterable list; resolves the chosen item's id, or null on cancel.
  const pickDialog = useCallback(
    (opts: { title: string; items: PickItem[]; current?: string; placeholder?: string }) =>
      new Promise<string | null>((res) => {
        setDialog({
          type: "pick",
          message: opts.title,
          items: opts.items,
          current: opts.current,
          placeholder: opts.placeholder,
          resolve: (v) => {
            setDialog(null);
            res(typeof v === "string" ? v : null);
          },
        });
      }),
    [],
  );

  return { dialog, confirmDialog, promptDialog, pickDialog };
}
