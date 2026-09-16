import { useEffect, useState } from "react";
import { fetchTerminalBackends, type TerminalBackendOption } from "../../api";
import type { ExtensionInfo } from "../../types";

// The terminal engines the server offers, re-listed when extensions change
// (enabling an extension can register one).
export function useTerminalBackends(extensions: ExtensionInfo[]): TerminalBackendOption[] {
  const [backends, setBackends] = useState<TerminalBackendOption[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetchTerminalBackends()
      .then((list) => !cancelled && setBackends(list))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [extensions]);
  return backends;
}
