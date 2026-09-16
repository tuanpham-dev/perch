import { useEffect, useRef } from "react";
import Icon from "./Icon";

interface Props {
  query: string;
  onQueryChange: (query: string) => void;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
}

// Overlay for scrollback search — the terminal engine owns the actual search
// (see server's searchScrollback), this just drives it. Enter/Shift+Enter
// double as "start" on the first press and "next"/"prev" afterward; App-level
// key handling never sees these since they're stopped here first.
export default function SearchBar({ query, onQueryChange, onNext, onPrev, onClose }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div
      className="terminal-search-bar"
      onKeyDown={(e) => {
        // Stop propagation so this never reaches the terminal's own key handling or
        // App's global shortcuts (e.g. Ctrl+W) while the search box is
        // focused.
        e.stopPropagation();
        if (e.key === "Enter" && !e.ctrlKey && !e.altKey && !e.metaKey) {
          e.preventDefault();
          if (e.shiftKey) onPrev();
          else onNext();
        } else if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <input
        ref={inputRef}
        type="text"
        className="terminal-search-input"
        placeholder="Search scrollback"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
      />
      <button
        className="terminal-search-btn"
        title="Previous match (Shift+Enter)"
        onClick={onPrev}
      >
        <Icon name="chevron-up" />
      </button>
      <button className="terminal-search-btn" title="Next match (Enter)" onClick={onNext}>
        <Icon name="chevron-down" />
      </button>
      <button className="terminal-search-btn" title="Close (Esc)" onClick={onClose}>
        <Icon name="close" />
      </button>
    </div>
  );
}
