import type { EnvironmentId, RoutingGroup } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../../state/atom-registry";

/** The group being edited, kept in an atom so its member picker route can change it. */
export type RoutingGroupEditor = {
  readonly environmentId: EnvironmentId;
  /** Null for a group not yet saved. */
  readonly index: number | null;
  readonly group: RoutingGroup;
  /** The member the model picker route edits. */
  readonly memberIndex: number;
};

export const routingGroupEditorAtom = Atom.make<RoutingGroupEditor | null>(null).pipe(
  Atom.keepAlive,
);

export function updateRoutingGroupEditor(
  update: (current: RoutingGroupEditor) => RoutingGroupEditor,
): void {
  const current = appAtomRegistry.get(routingGroupEditorAtom);
  if (current) appAtomRegistry.set(routingGroupEditorAtom, update(current));
}

export function startRoutingGroupEditor(editor: RoutingGroupEditor): void {
  appAtomRegistry.set(routingGroupEditorAtom, editor);
}
