// Where an extension's settings components render inside its Settings
// section: directly after the declared property their `after` names, or at
// the bottom below every scalar control.
//
// Placement exists because a custom control often belongs WITH a particular
// field rather than at the end - an API token beside the site URL and email
// it authenticates, a table editor right under the JSON setting it edits. An
// `after` that names no declared property of this extension (a typo, or a
// property a later version dropped) falls back to the bottom rather than
// vanishing, which is also exactly where every component rendered before
// placement existed.
export interface PlaceableSettingsComponent {
  after?: string;
}

export interface SettingsComponentPlacement<T> {
  // Keyed by the full dotted property key, in registration order.
  anchored: Map<string, T[]>;
  trailing: T[];
}

export function placeSettingsComponents<T extends PlaceableSettingsComponent>(
  components: readonly T[],
  propertyKeys: Iterable<string>,
): SettingsComponentPlacement<T> {
  const keys = new Set(propertyKeys);
  const anchored = new Map<string, T[]>();
  const trailing: T[] = [];
  for (const component of components) {
    if (component.after !== undefined && keys.has(component.after)) {
      const list = anchored.get(component.after);
      if (list) list.push(component);
      else anchored.set(component.after, [component]);
    } else {
      trailing.push(component);
    }
  }
  return { anchored, trailing };
}
