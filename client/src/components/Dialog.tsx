import { useEffect, useMemo, useRef, useState } from "react";
import { filterPickItems, type PickItem } from "../lib/pickFilter";
import Icon from "./Icon";

export interface DialogRequest {
  type: "confirm" | "prompt" | "pick";
  message: string;
  defaultValue?: string;
  danger?: boolean;
  confirmLabel?: string;
  // "pick" only: the rows, the id to start highlighted, and the filter
  // input's placeholder.
  items?: PickItem[];
  current?: string;
  placeholder?: string;
  resolve: (result: string | boolean | null) => void;
}

interface Props {
  dialog: DialogRequest;
}

export default function Dialog({ dialog }: Props) {
  if (dialog.type === "pick") return <PickDialog dialog={dialog} />;
  return <MessageDialog dialog={dialog} />;
}

function MessageDialog({ dialog }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (dialog.type === "prompt") {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else {
      confirmRef.current?.focus();
    }
  }, [dialog]);

  const cancel = () => dialog.resolve(dialog.type === "prompt" ? null : false);
  const confirm = () =>
    dialog.resolve(dialog.type === "prompt" ? (inputRef.current?.value ?? "") : true);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    } else if (e.key === "Enter") {
      e.preventDefault();
      confirm();
    }
  };

  return (
    <div className="dialog-overlay" onMouseDown={cancel}>
      <div
        className="dialog"
        role="dialog"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="dialog-message">{dialog.message}</div>
        {dialog.type === "prompt" && (
          <input
            ref={inputRef}
            className="dialog-input"
            defaultValue={dialog.defaultValue ?? ""}
          />
        )}
        <div className="dialog-buttons">
          <button className="dialog-button secondary" onClick={cancel}>
            Cancel
          </button>
          <button
            ref={confirmRef}
            className={`dialog-button primary${dialog.danger ? " danger" : ""}`}
            onClick={confirm}
          >
            {dialog.confirmLabel ?? "OK"}
          </button>
        </div>
      </div>
    </div>
  );
}

// Rows a PageUp/PageDown moves by — about one screenful of the list.
const PAGE_ROWS = 10;

// A filterable list that resolves the chosen row's id (null on cancel).
// Focus stays in the filter input the whole time; the arrow keys move the
// highlight, the way the quick switcher works.
function PickDialog({ dialog }: Props) {
  const items = dialog.items ?? [];
  const [query, setQuery] = useState("");
  const shown = useMemo(() => filterPickItems(items, query), [items, query]);
  const [active, setActive] = useState(() => {
    const at = items.findIndex((item) => item.id === dialog.current);
    return at === -1 ? 0 : at;
  });
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // A new query starts at the top of what it matched. Compared against the
  // last query rather than skipping the first run, which StrictMode's
  // double-run of effects would defeat (and lose the `current` highlight).
  const lastQuery = useRef(query);
  useEffect(() => {
    if (lastQuery.current === query) return;
    lastQuery.current = query;
    setActive(0);
  }, [query]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, shown]);

  const cancel = () => dialog.resolve(null);
  const choose = (index: number) => {
    const item = shown[index];
    if (item) dialog.resolve(item.id);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const last = shown.length - 1;
    const move = (to: number) => {
      e.preventDefault();
      setActive(Math.max(0, Math.min(last, to)));
    };
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        cancel();
        break;
      case "Enter":
        e.preventDefault();
        choose(active);
        break;
      case "ArrowDown":
        move(active + 1);
        break;
      case "ArrowUp":
        move(active - 1);
        break;
      case "PageDown":
        move(active + PAGE_ROWS);
        break;
      case "PageUp":
        move(active - PAGE_ROWS);
        break;
      case "Home":
        if (e.ctrlKey || e.metaKey) move(0);
        break;
      case "End":
        if (e.ctrlKey || e.metaKey) move(last);
        break;
    }
  };

  return (
    <div className="dialog-overlay" onMouseDown={cancel}>
      <div
        className="dialog dialog-pick"
        role="dialog"
        aria-label={dialog.message}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="dialog-message">{dialog.message}</div>
        <input
          ref={inputRef}
          className="dialog-input"
          placeholder={dialog.placeholder ?? "Type to filter"}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          role="combobox"
          aria-expanded="true"
          aria-controls="dialog-pick-list"
          aria-activedescendant={shown[active] ? `dialog-pick-${active}` : undefined}
        />
        <div className="dialog-pick-list" id="dialog-pick-list" role="listbox" ref={listRef}>
          {shown.map((item, index) => (
            <div
              key={item.id}
              id={`dialog-pick-${index}`}
              data-index={index}
              role="option"
              aria-selected={index === active}
              className={`dialog-pick-row${index === active ? " active" : ""}${item.id === dialog.current ? " current" : ""}`}
              onMouseMove={() => setActive(index)}
              onClick={() => choose(index)}
            >
              {item.icon && <Icon name={item.icon} className="dialog-pick-icon" />}
              <span className="dialog-pick-label">{item.label}</span>
              {item.detail && <span className="dialog-pick-detail">{item.detail}</span>}
            </div>
          ))}
          {shown.length === 0 && <div className="dialog-pick-empty">No matches</div>}
        </div>
        <div className="dialog-buttons">
          <button className="dialog-button secondary" onClick={cancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
