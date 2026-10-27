import * as React from "react";

/**
 * Ties a visible label to the shared controls under it (audit 2026-10-20,
 * X5.1). A field wrapper renders its label with an id and provides that id
 * here; Input, Textarea, SelectTrigger, Switch, Checkbox and Slider inside it
 * take it as aria-labelledby, unless they are already named. A <label> around
 * the field would do the same for inputs, but it also renames every button
 * inside it (merge-token buttons, Add, Remove) to the label's text.
 */
export const FieldLabelContext = React.createContext<string | undefined>(undefined);

/** The label id for a control inside a labelled field, or undefined if it has its own name. */
export function useFieldLabelledBy(props: { "aria-label"?: string; "aria-labelledby"?: string }): string | undefined {
  const id = React.useContext(FieldLabelContext);
  if (props["aria-label"] || props["aria-labelledby"]) return undefined;
  return id;
}
