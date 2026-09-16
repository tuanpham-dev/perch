// Settings → AI Providers: one section answering "which AIs does this app
// have", in two groups.
//
// Agents first (the CLIs that run in a pane and do work), then API providers
// (the keys and commands that answer one-shot text jobs — commit messages, AI
// command search, prompt refine). They were two separate nav entries, which
// meant the answer lived in two places and neither page said the other
// existed (plans/consolidate-agents-into-ai-providers.md).
//
// Composition, not a merge: both children keep their own file, their own state
// and their own storage. `settings.agents` and `settings.aiProfiles` are
// untouched — a real merge would have had to collapse two id spaces that both
// contain the name "claude", one of which keys the stored API keys.
//
// The "Agents" group heading lives inside AgentsSection rather than here,
// because it carries the agent count and that count comes from the server
// catalog AgentsSection already fetches. Pulling it up to this parent would
// mean either threading a prop back down or fetching the catalog twice.
import AgentsSection from "./AgentsSection";
import DefaultAiFields from "./DefaultAiFields";
import AiSection from "./AiSection";

export default function AiProvidersSection() {
  return (
    <>
      <AgentsSection />

      <div className="settings-row settings-group-heading">
        <span className="settings-label">API providers</span>
        <div className="settings-hint">
          Keys and commands for one-shot text jobs. Add as many as you like and point individual
          features at them; CLIs are not listed here because an agent above already supplies one.
        </div>
      </div>

      <AiSection />

      {/* Last, because it chooses between everything above it: an agent from
          the first group or an API provider from the second. Asking "which one
          answers by default" only makes sense once both lists are in view. */}
      <div className="settings-row settings-group-heading">
        <span className="settings-label">Default AI</span>
      </div>
      <DefaultAiFields />
    </>
  );
}
