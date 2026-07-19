/**
 * CustomFieldsPanel — renders and saves an entity's custom field values.
 *
 * The Custom Fields feature shipped with a full admin UI for DEFINING fields
 * (per entity, with types, options, required and show-in-list flags) and a
 * complete server API for reading and writing values — and nothing in the app
 * ever called getValues/setValues. So an admin could define a field, mark it
 * Required, and there was no place in the product to ever fill it in, see it,
 * or have it validated. This panel is the missing consumer.
 *
 * Values live in each entity's existing `customFields` JSON column, keyed by
 * the definition's fieldKey.
 *
 * Renders nothing at all when the workspace has defined no fields for this
 * entity type — an empty "Custom fields" card on every record would be noise.
 */
import { useEffect, useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, SlidersHorizontal } from "lucide-react";
import { toast } from "sonner";

type EntityType = "lead" | "contact" | "account" | "opportunity";

type FieldDef = {
  id: number;
  fieldKey: string;
  label: string;
  fieldType: "text" | "number" | "date" | "boolean" | "select" | "multiselect" | "url";
  options?: Array<{ value: string; label: string }> | null;
  required: boolean;
  sortOrder: number;
};

/** Normalise a stored value into what the input element expects. */
function toInputValue(def: FieldDef, raw: unknown): string | boolean | string[] {
  if (def.fieldType === "boolean") return raw === true || raw === "true";
  if (def.fieldType === "multiselect") {
    if (Array.isArray(raw)) return raw.map(String);
    return typeof raw === "string" && raw ? raw.split(",").map((s) => s.trim()) : [];
  }
  return raw === undefined || raw === null ? "" : String(raw);
}

export function CustomFieldsPanel({
  entityType,
  entityId,
}: {
  entityType: EntityType;
  entityId: number;
}) {
  const utils = trpc.useUtils();
  const { data: defs } = trpc.customFields.listDefs.useQuery({ entityType });
  const { data: values, isLoading } = trpc.customFields.getValues.useQuery(
    { entityType, entityId },
    { enabled: Number.isFinite(entityId) },
  );

  const fields = useMemo(
    () => ((defs ?? []) as FieldDef[]).slice().sort((a, b) => a.sortOrder - b.sortOrder),
    [defs],
  );

  const [draft, setDraft] = useState<Record<string, any>>({});
  const [dirty, setDirty] = useState(false);

  // Reset the draft whenever the record or its stored values change, so
  // switching records doesn't carry edits across.
  useEffect(() => {
    if (!values || fields.length === 0) return;
    const next: Record<string, any> = {};
    for (const f of fields) next[f.fieldKey] = toInputValue(f, (values as any)[f.fieldKey]);
    setDraft(next);
    setDirty(false);
  }, [values, fields, entityId]);

  const save = trpc.customFields.setValues.useMutation({
    onSuccess: () => {
      utils.customFields.getValues.invalidate({ entityType, entityId });
      setDirty(false);
      toast.success("Custom fields saved");
    },
    // The server validates required fields and returns a message naming the
    // one that's missing — surface it rather than a generic failure.
    onError: (e: any) => toast.error(e?.message ?? "Could not save custom fields"),
  });

  if (fields.length === 0) return null;

  const set = (key: string, v: any) => {
    setDraft((d) => ({ ...d, [key]: v }));
    setDirty(true);
  };

  return (
    <Card>
      <CardContent className="pt-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="font-medium text-sm flex items-center gap-2">
            <SlidersHorizontal className="size-4" /> Custom fields
          </div>
          <Button
            size="sm"
            disabled={!dirty || save.isPending}
            onClick={() => {
              // Send EVERY field, not just the edited ones: setValues
              // re-validates all required definitions on each call, so a
              // partial payload would fail on required fields the user hasn't
              // touched.
              const payload: Record<string, any> = {};
              for (const f of fields) {
                const v = draft[f.fieldKey];
                payload[f.fieldKey] =
                  f.fieldType === "number"
                    ? (v === "" || v === undefined ? null : Number(v))
                    : v ?? "";
              }
              save.mutate({ entityType, entityId, values: payload });
            }}
            className="gap-1.5"
          >
            {save.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null} Save
          </Button>
        </div>

        {isLoading ? (
          <div className="text-xs text-muted-foreground">Loading…</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {fields.map((f) => {
              const v = draft[f.fieldKey];
              return (
                <div key={f.id} className="space-y-1">
                  <Label className="text-xs text-muted-foreground">
                    {f.label}
                    {f.required && <span className="text-rose-600"> *</span>}
                  </Label>

                  {f.fieldType === "boolean" ? (
                    <label className="flex items-center gap-2 text-sm pt-1">
                      <Checkbox
                        checked={v === true}
                        onCheckedChange={(c) => set(f.fieldKey, c === true)}
                      />
                      Yes
                    </label>
                  ) : f.fieldType === "select" ? (
                    <select
                      value={String(v ?? "")}
                      onChange={(e) => set(f.fieldKey, e.target.value)}
                      className="h-9 w-full rounded-md border border-border bg-background px-2.5 text-[13px]"
                    >
                      <option value="">—</option>
                      {(f.options ?? []).map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  ) : f.fieldType === "multiselect" ? (
                    <div className="flex flex-wrap gap-2 pt-1">
                      {(f.options ?? []).map((o) => {
                        const arr: string[] = Array.isArray(v) ? v : [];
                        const on = arr.includes(o.value);
                        return (
                          <label key={o.value} className="flex items-center gap-1.5 text-xs">
                            <Checkbox
                              checked={on}
                              onCheckedChange={(c) =>
                                set(
                                  f.fieldKey,
                                  c === true ? [...arr, o.value] : arr.filter((x) => x !== o.value),
                                )
                              }
                            />
                            {o.label}
                          </label>
                        );
                      })}
                      {(f.options ?? []).length === 0 && (
                        <span className="text-xs text-muted-foreground">No options defined.</span>
                      )}
                    </div>
                  ) : (
                    <Input
                      type={
                        f.fieldType === "number" ? "number"
                        : f.fieldType === "date" ? "date"
                        : f.fieldType === "url" ? "url"
                        : "text"
                      }
                      value={String(v ?? "")}
                      onChange={(e) => set(f.fieldKey, e.target.value)}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default CustomFieldsPanel;
