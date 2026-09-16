import { useCallback, useEffect, useState } from "react";
import {
  fetchAgentHooks,
  installAgentHooks,
  uninstallAgentHooks,
  type AgentHooksDto,
  type AgentHookStateDto,
} from "../../api";
import { copyText } from "../../clipboard";
import type { AppSettings } from "../../settings";
import Icon from "../Icon";
import { useSettingsContext } from "./context";

// Settings → AI Providers. One place answers "what is an AI agent", for the app and
// every extension that asks (plans/agent-platform-core.md) — which pane is
// running an agent (SOURCE CONTROL's diff comments, the element pickers in
// LIVE PREVIEW and PORTS, AGENT MONITOR), which agents can be launched to
// work on a branch or a ticket, and which hook format each one speaks.
//
// The Agents group inside Settings → AI Providers (AiProvidersSection renders
// it above the API providers).
//
// Shaped as a catalog rather than an editor: the agents come from extensions and
// from extensions that contribute them, so there is nothing to define by
// hand. Each row is enable/disable plus a link, and an agent whose CLI is not
// on this machine is dimmed rather than offered as if it would run. The
// settings document stays hand-editable for anyone who needs an entry the
// catalog does not have.

// How often the panel re-reads agent and hook state while Settings is on
// screen. The config files it reports on are edited outside the app, an
// extension can be enabled elsewhere, and a CLI can be installed while the
// panel is open — so it polls rather than trusting what it read on mount.
const POLL_MS = 5000;

const STATE_LABELS: Record<AgentHookStateDto["state"], string> = {
  unsupported: "No hooks",
  "not-installed": "Not installed",
  installed: "Installed",
  stale: "Needs reinstalling",
};

// Core's own event names, as the panel spells them for a reader. The agent's
// raw names (SessionStart, PreInvocation) are shown where they matter: the
// actual contents of a config file.
const EVENT_LABELS: Record<string, string> = {
  "session-start": "session start",
  "prompt-submit": "turn start",
  "tool-start": "tool call start",
  "tool-end": "tool call end",
  permission: "permission prompt",
  stop: "turn end",
  "subagent-stop": "subagent finished",
};

function eventList(events: readonly string[]): string {
  return events.map((e) => EVENT_LABELS[e] ?? e).join(", ");
}

// Two-state control, the shape the rest of this panel's choices take:
// Enabled/Disabled per agent, Yolo/Manual for permissions. A pair of buttons
// rather than a checkbox, because both sides are named — "off" for
// permissions means "ask me", which a cleared checkbox does not say.
function Segmented<T extends string>({
  value,
  options,
  disabled,
  ariaLabel,
  onChange,
}: {
  value: T;
  options: { value: T; label: string; title?: string }[];
  disabled?: boolean;
  ariaLabel: string;
  onChange: (next: T) => void;
}) {
  return (
    <div className="settings-segmented" role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`settings-segment${value === option.value ? " active" : ""}`}
          aria-pressed={value === option.value}
          disabled={disabled}
          title={option.title}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

// The hook detail for one agent: which file, what is in it, who asked for it,
// and the snippet for anyone who would rather paste it themselves. Collapsed
// by default — with the master toggle doing the work, this is the "show me
// what you wrote" view rather than the primary control.
function HookDetail({
  hooks,
  subscribers,
  onChanged,
}: {
  hooks: AgentHookStateDto;
  subscribers: AgentHooksDto["subscribers"];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const run = async (write: typeof installAgentHooks, done: string) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const result = await write(hooks.agentId);
      setNote(result.backup ? `${done} The previous file was kept as ${result.backup}.` : done);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="agent-row-detail">
      <div className="settings-hint">
        {hooks.ownership === "whole-file" ? (
          <>
            This agent keeps its hooks in a file of its own, <code>{hooks.file}</code>. The app merges
            into it, adding only its own entries and leaving anything you put there alone - but the
            snippet below is that whole file, so do not paste it over hooks of your own.
          </>
        ) : (
          <>
            The app adds its own entries to <code>{hooks.file}</code> and never touches anything else
            in it.
          </>
        )}
      </div>

      {hooks.error && <div className="settings-hint settings-error">{hooks.error}</div>}
      {hooks.state === "stale" && hooks.staleReason && (
        <div className="settings-hint settings-error">{hooks.staleReason}</div>
      )}

      {hooks.installedEvents.length > 0 && (
        <div className="settings-hint">
          Installed for: <code>{hooks.installedEvents.join(", ")}</code>
        </div>
      )}
      {hooks.wantedEvents.length > 0 ? (
        <div className="settings-hint">
          Would install: <code>{hooks.wantedEvents.join(", ")}</code>
        </div>
      ) : (
        <div className="settings-hint">
          Nothing is subscribed to agent hooks right now, so there is nothing to install. Enable an
          extension that uses them first.
        </div>
      )}
      <div className="settings-hint">
        {subscribers.length > 0
          ? `Asked for by: ${subscribers.map((s) => `${s.extensionId} (${eventList(s.events)})`).join("; ")}`
          : "No extension is subscribed."}
      </div>

      {hooks.snippet && (
        <>
          <pre className="agent-hook-snippet">{hooks.snippet.text}</pre>
          <div className="agent-hook-actions">
            <button
              className="dialog-button secondary"
              onClick={() => {
                copyText(hooks.snippet!.text)
                  .then(() => setCopied(true))
                  .catch((err) => setError(err instanceof Error ? err.message : String(err)));
              }}
            >
              {copied ? "Copied" : "Copy snippet"}
            </button>
            <button
              className="dialog-button secondary"
              disabled={busy}
              onClick={() => void run(installAgentHooks, "Installed.")}
            >
              {hooks.state === "not-installed" ? "Install" : "Install again"}
            </button>
            {hooks.state !== "not-installed" && (
              <button
                className="dialog-button secondary"
                disabled={busy}
                onClick={() => void run(uninstallAgentHooks, "Removed.")}
              >
                Remove
              </button>
            )}
          </div>
        </>
      )}

      {note && <div className="settings-hint">{note}</div>}
      {error && <div className="settings-hint settings-error">{error}</div>}
    </div>
  );
}

function AgentRow({
  agent,
  enabled,
  hooksEnabled,
  subscribers,
  onToggle,
  onHooksChanged,
}: {
  agent: AgentHookStateDto;
  // From the settings document this client is holding, NOT from `agent`.
  // The server's copy of it only catches up after the settings save (400ms
  // debounced, then a read-merge-write round trip), so rendering that made a
  // click take about four and a half seconds to show - measured.
  enabled: boolean;
  hooksEnabled: boolean;
  subscribers: AgentHooksDto["subscribers"];
  onToggle: (enabled: boolean) => void;
  onHooksChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const hookable = agent.state !== "unsupported";

  return (
    <div className={`agent-row${agent.installed ? "" : " missing"}`}>
      <div className="agent-row-head">
        {/* The agent's own picture when it has one - the app serves its own,
            and a contributing extension's path is already resolved to a URL
            server-side. An agent with no image falls back to a codicon, so a
            row is never left with a hole in it. */}
        <span className="agent-row-icon">
          {agent.iconUrl ? (
            <img src={agent.iconUrl} alt="" />
          ) : (
            <Icon name={agent.icon || "hubot"} />
          )}
        </span>
        <div className="agent-row-name">
          <span className="agent-row-label">{agent.label}</span>
          <code className="agent-row-command">{agent.command || agent.agentId}</code>
          <span className="settings-hint agent-row-meta">
            {agent.installed ? "" : "not installed on this machine"}
            {agent.contributedBy ? `${agent.installed ? "" : " · "}from ${agent.contributedBy}` : ""}
            {hooksEnabled && hookable
              ? `${agent.installed && !agent.contributedBy ? "" : " · "}hooks: ${STATE_LABELS[agent.state].toLowerCase()}`
              : ""}
          </span>
        </div>

        <Segmented
          ariaLabel={`${agent.label} enabled`}
          value={enabled ? "enabled" : "disabled"}
          // An agent whose CLI is absent can still be disabled - what it
          // cannot usefully be is enabled, so the control is left alone and
          // the row is simply dimmed.
          options={[
            { value: "enabled", label: "Enabled" },
            { value: "disabled", label: "Disabled" },
          ]}
          onChange={(next) => onToggle(next === "enabled")}
        />

        {hooksEnabled && hookable && (
          <button
            className="icon-button"
            title={open ? "Hide hook details" : "Show what the app writes for this agent"}
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            <Icon name={open ? "chevron-down" : "chevron-right"} />
          </button>
        )}

        {agent.docsUrl ? (
          <a
            className="icon-button"
            href={agent.docsUrl}
            target="_blank"
            rel="noreferrer noopener"
            title={agent.installed ? `About ${agent.label}` : `How to install ${agent.label}`}
          >
            <Icon name="link-external" />
          </a>
        ) : (
          <span className="icon-button-placeholder" />
        )}
      </div>

      {open && hooksEnabled && hookable && (
        <HookDetail hooks={agent} subscribers={subscribers} onChanged={onHooksChanged} />
      )}
    </div>
  );
}

export default function AgentsSection() {
  const { active, settings, onSettingsChange } = useSettingsContext();
  // One write per change, however many keys it touches — the context's own
  // `set` rebuilds from the render it was called in, so two calls in a row
  // would have the second overwrite the first (see AiSection).
  const patch = (next: Partial<AppSettings>) => onSettingsChange({ ...settings, ...next });
  const [info, setInfo] = useState<AgentHooksDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setInfo(await fetchAgentHooks());
    } catch {
      // Keep the last state we read; the next tick tries again.
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [active, refresh]);

  // A registry or subscription change moves what the app would install, so
  // re-read rather than waiting out the poll — but only once the change has
  // actually reached the server. Settings saves are debounced 400ms and then
  // read-merge-written, so firing this immediately (as it first did) just
  // fetched the old answer back.
  useEffect(() => {
    const timer = setTimeout(() => void refresh(), 700);
    return () => clearTimeout(timer);
  }, [settings.agents, settings.agentHooksHighFrequencyEvents, refresh]);

  const agents = info?.agents ?? [];
  const hookable = agents.filter((a) => a.state !== "unsupported");

  // The master switch does the installing, so that a user who wants agent
  // states does not have to press Install once per agent. Turning it off
  // takes every one of the app's own entries back out; nothing reinstalls
  // while it is off.
  const setHooksEnabled = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    patch({ agentHooksEnabled: enabled });
    try {
      for (const agent of hookable) {
        if (enabled && agent.enabled) await installAgentHooks(agent.agentId);
        if (!enabled) await uninstallAgentHooks(agent.agentId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  // While the switch is on, an agent whose installed events no longer match
  // what the extensions ask for is put back in step without the user pressing
  // anything: that is what "stop reinstalling them" being the OFF behaviour
  // means. Only ever a reinstall of the app's own entries.
  useEffect(() => {
    if (!settings.agentHooksEnabled || busy) return;
    const stale = agents.find((a) => a.state === "stale" && a.enabled && !a.error);
    if (!stale) return;
    void installAgentHooks(stale.agentId)
      .then(() => refresh())
      .catch(() => {
        // Surfaced by the row's own state on the next read rather than as a
        // toast: this runs unattended.
      });
  }, [settings.agentHooksEnabled, agents, busy, refresh]);

  const toggleAgent = (agent: AgentHookStateDto, enabled: boolean) => {
    const existing = settings.agents.find((a) => a.id === agent.agentId);
    const entry = {
      id: agent.agentId,
      label: agent.label,
      program: existing?.program ?? "",
      command: agent.command,
      skipPermissionsArgs: agent.skipPermissionsArgs,
      docsUrl: agent.docsUrl,
      iconUrl: agent.iconUrl,
      icon: agent.icon,
      enabled,
      contributedBy: agent.contributedBy,
    };
    // In place when it is already stored: the list renders in stored order,
    // so rewriting an entry at the end would make a row jump down the list
    // the moment you toggled it. An agent an extension contributed has no
    // stored entry yet and is appended, which leaves the rendered order
    // alone too - the contributed ones already sort after the stored ones.
    patch({
      agents: existing
        ? settings.agents.map((a) => (a.id === agent.agentId ? entry : a))
        : [...settings.agents, entry],
    });
  };

  return (
    <>
      <div className="settings-row">
        <span className="settings-label">Agent status hooks</span>
        <div className="settings-split">
          <div className="settings-hint">
            Shows working, waiting and done states for each agent pane. Turn it off to remove the
            app&apos;s own hooks from every agent&apos;s config file and stop putting them back. Only
            the app&apos;s entries are ever touched - a hook you wrote by hand is left alone either
            way.
          </div>
          <Segmented
            ariaLabel="Agent status hooks"
            value={settings.agentHooksEnabled ? "on" : "off"}
            disabled={busy || hookable.length === 0}
            options={[
              { value: "on", label: "On" },
              { value: "off", label: "Off" },
            ]}
            onChange={(next) => void setHooksEnabled(next === "on")}
          />
        </div>
        {error && <div className="settings-hint settings-error">{error}</div>}
      </div>

      {settings.agentHooksEnabled && (
        <label className="settings-row checkbox-row">
          <input
            type="checkbox"
            checked={settings.agentHooksHighFrequencyEvents}
            onChange={(e) => patch({ agentHooksHighFrequencyEvents: e.target.checked })}
          />
          <span>Also hook every tool call</span>
        </label>
      )}
      {settings.agentHooksEnabled && (
        <div className="settings-hint">
          Off, an agent reports when a turn starts and ends. On, it also reports every tool call: one
          short-lived process per call, measured at around 30ms each, in exchange for knowing exactly
          when an agent is working rather than inferring it from timing.
        </div>
      )}

      <div className="settings-row">
        <span className="settings-label">Agent permissions</span>
        <div className="settings-split">
          <div className="settings-hint">
            Whether the app launches agents with fewer permission prompts or with manual checks. Each
            agent has its own flag for this and they are not interchangeable, so Yolo appends
            whichever one that agent documents. This is the only place it is asked - every launch
            follows it, including the New Worktree form and an extension&apos;s &quot;Start work&quot;.
          </div>
          <Segmented
            ariaLabel="Agent permissions"
            value={settings.agentPermissions}
            options={[
              { value: "yolo", label: "Yolo", title: "Launch with the agent's skip-permissions flag" },
              { value: "manual", label: "Manual", title: "Launch with permission prompts on" },
            ]}
            onChange={(next) => patch({ agentPermissions: next })}
          />
        </div>
      </div>

      {/* This group's heading, rendered here rather than by the parent
          section because it carries the count and the count comes from the
          catalog this component fetches. */}
      <div className="settings-row settings-group-heading">
        <span className="settings-label">
          Agents{" "}
          {/* No chip at zero: the empty state below already says "No agents",
              and "0 agents" above it said the same thing twice. */}
          {agents.length > 0 && (
            <span className="settings-count">
              {agents.length} {agents.length === 1 ? "agent" : "agents"}
            </span>
          )}
        </span>
        <div className="settings-hint">
          Every agent an extension contributes. The app itself ships none - the bundled Agents
          extension supplies Claude Code and Codex, and any extension can add more. A dimmed row is
          one whose command is not on this machine - install it and the row lights up on the next
          check. Extensions read this list instead of each keeping their own.
        </div>
      </div>

      <div className="agent-list">
        {agents.map((agent) => (
          <AgentRow
            key={agent.agentId}
            agent={agent}
            // The stored entry is the authority on enabled; the catalog's own
            // value covers an agent this document has never stored (one an
            // extension contributed).
            enabled={settings.agents.find((a) => a.id === agent.agentId)?.enabled ?? agent.enabled}
            hooksEnabled={settings.agentHooksEnabled}
            subscribers={info?.subscribers ?? []}
            onToggle={(enabled) => toggleAgent(agent, enabled)}
            onHooksChanged={() => void refresh()}
          />
        ))}
        {info === null && <div className="settings-hint">Reading the agent list…</div>}
        {info !== null && agents.length === 0 && (
          <div className="settings-hint">
            No agents. Agents come from extensions, so nothing is detected as an agent and nothing
            is offered to launch until one is installed - start with the bundled Agents extension in
            the Extensions tab.
          </div>
        )}
      </div>
    </>
  );
}
