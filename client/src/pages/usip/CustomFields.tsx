import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Shell, PageHeader } from "@/components/usip/Shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Pencil, Plus, Trash2, SlidersHorizontal, X } from "lucide-react";
import { toast } from "sonner";

const ENTITY_TYPES = ["lead", "contact", "account", "opportunity"] as const;
type EntityType = (typeof ENTITY_TYPES)[number];

const FIELD_TYPES = ["text", "number", "date", "boolean", "select", "multiselect", "url"] as const;

const ENTITY_COLORS: Record<EntityType, string> = {
  lead: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  contact: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  account: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
  opportunity: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
};

const emptyForm = {
  entityType: "lead" as EntityType,
  fieldKey: "",
  label: "",
  fieldType: "text" as (typeof FIELD_TYPES)[number],
  required: false,
  showInList: false,
  sortOrder: 0,
  optionInput: "",
  options: [] as { value: string; label: string }[],
};

export default function CustomFields() {
  const [activeEntity, setActiveEntity] = useState<EntityType>("lead");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editDef, setEditDef] = useState<any>(null);
  const [form, setForm] = useState({ ...emptyForm });

  const { data: defs = [], refetch } = trpc.customFields.listDefs.useQuery({ entityType: activeEntity });

  const createDef = trpc.customFields.createDef.useMutation({
    onSuccess: () => { refetch(); setDialogOpen(false); toast.success("Field created"); },
    onError: (e) => toast.error(e.message),
  });
  const updateDef = trpc.customFields.updateDef.useMutation({
    onSuccess: () => { refetch(); setDialogOpen(false); toast.success("Field updated"); },
    onError: (e) => toast.error(e.message),
  });
  const deleteDef = trpc.customFields.deleteDef.useMutation({
    onSuccess: () => { refetch(); toast.success("Field deleted"); },
    onError: (e) => toast.error(e.message),
  });

  function openAdd() {
    setEditDef(null);
    setForm({ ...emptyForm, entityType: activeEntity });
    setDialogOpen(true);
  }
  function openEdit(def: any) {
    setEditDef(def);
    setForm({
      entityType: def.entityType,
      fieldKey: def.fieldKey,
      label: def.label,
      fieldType: def.fieldType,
      required: def.required,
      showInList: def.showInList,
      sortOrder: def.sortOrder,
      optionInput: "",
      options: def.options ?? [],
    });
    setDialogOpen(true);
  }
  function addOption() {
    if (!form.optionInput.trim()) return;
    const val = form.optionInput.trim().toLowerCase().replace(/\s+/g, "_");
    setForm((f) => ({
      ...f,
      options: [...f.options, { value: val, label: f.optionInput.trim() }],
      optionInput: "",
    }));
  }
  function removeOption(idx: number) {
    setForm((f) => ({ ...f, options: f.options.filter((_, i) => i !== idx) }));
  }
  function handleSave() {
    const payload = {
      entityType: form.entityType,
      fieldKey: form.fieldKey,
      label: form.label,
      fieldType: form.fieldType,
      required: form.required,
      showInList: form.showInList,
      sortOrder: form.sortOrder,
      options: ["select", "multiselect"].includes(form.fieldType) ? form.options : undefined,
    };
    if (editDef) {
      updateDef.mutate({ id: editDef.id, patch: { label: payload.label, fieldType: payload.fieldType, required: payload.required, showInList: payload.showInList, sortOrder: payload.sortOrder, options: payload.options } });
    } else {
      createDef.mutate(payload);
    }
  }

  return (
    <Shell title="Custom Fields">
      <PageHeader title="Custom Fields" description="Extend CRM entities with custom fields tailored to your sales process." pageKey="custom-fields"
        icon={<SlidersHorizontal className="size-5" />}
      >
        <Button onClick={openAdd} size="sm">
          <Plus className="h-4 w-4 mr-1" /> Add Field
        </Button>
      </PageHeader>
      <div className="p-6 max-w-4xl mx-auto space-y-6">

        {/* Entity tabs */}
        <div className="flex gap-2 flex-wrap">
          {ENTITY_TYPES.map((et) => (
            <button
              key={et}
              onClick={() => setActiveEntity(et)}
              className={`px-4 py-1.5 rounded-full text-sm font-medium capitalize transition-colors ${activeEntity === et ? ENTITY_COLORS[et] : "bg-muted text-muted-foreground hover:bg-muted/80"}`}
            >
              {et}
            </button>
          ))}
        </div>

        {/* Field list */}
        {defs.length === 0 && (
          <Card className="flex items-center justify-center h-40">
            <div className="text-center text-muted-foreground">
              <SlidersHorizontal className="h-8 w-8 mx-auto mb-2 opacity-30" />
              <p className="text-sm">No custom fields for {activeEntity}s yet</p>
              <Button variant="outline" size="sm" className="mt-3" onClick={openAdd}>Add first field</Button>
            </div>
          </Card>
        )}

        <div className="space-y-2">
          {defs.map((def: any) => (
            <Card key={def.id} className="hover:shadow-sm transition-shadow">
              <CardContent className="py-3 px-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-sm">{def.label}</span>
                        <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono text-muted-foreground">{def.fieldKey}</code>
                        <Badge variant="outline" className="text-xs capitalize">{def.fieldType}</Badge>
                        {def.required && <Badge className="text-xs bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300 border-0">Required</Badge>}
                        {def.showInList && <Badge variant="secondary" className="text-xs">In list</Badge>}
                      </div>
                      {def.options && def.options.length > 0 && (
                        <div className="flex gap-1 mt-1 flex-wrap">
                          {def.options.map((o: any) => (
                            <span key={o.value} className="text-xs bg-muted px-1.5 py-0.5 rounded">{o.label}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEdit(def)}><Pencil className="h-3.5 w-3.5" /></Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-red-500 hover:text-red-600" onClick={() => deleteDef.mutate({ id: def.id })}><Trash2 className="h-3.5 w-3.5" /></Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Add/Edit dialog */}
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>{editDef ? "Edit Custom Field" : "Add Custom Field"}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-2">
              {!editDef && (
                <div className="space-y-1.5">
                  <Label>Entity Type</Label>
                  <Select value={form.entityType} onValueChange={(v) => setForm((f) => ({ ...f, entityType: v as EntityType }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {ENTITY_TYPES.map((et) => <SelectItem key={et} value={et} className="capitalize">{et}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Label</Label>
                  <Input value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} placeholder="e.g. Contract Value" />
                </div>
                <div className="space-y-1.5">
                  <Label>Field Key <span className="text-muted-foreground text-xs">(snake_case)</span></Label>
                  <Input
                    value={form.fieldKey}
                    onChange={(e) => setForm((f) => ({ ...f, fieldKey: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") }))}
                    placeholder="e.g. contract_value"
                    disabled={!!editDef}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Field Type</Label>
                <Select value={form.fieldType} onValueChange={(v) => setForm((f) => ({ ...f, fieldType: v as any }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {FIELD_TYPES.map((ft) => <SelectItem key={ft} value={ft} className="capitalize">{ft}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              {["select", "multiselect"].includes(form.fieldType) && (
                <div className="space-y-1.5">
                  <Label>Options</Label>
                  <div className="flex gap-2">
                    <Input
                      value={form.optionInput}
                      onChange={(e) => setForm((f) => ({ ...f, optionInput: e.target.value }))}
                      placeholder="Option label"
                      onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addOption())}
                    />
                    <Button type="button" variant="outline" size="sm" onClick={addOption}>Add</Button>
                  </div>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {form.options.map((o, i) => (
                      <span key={i} className="flex items-center gap-1 text-xs bg-muted px-2 py-1 rounded-full">
                        {o.label}
                        <button onClick={() => removeOption(i)} className="text-muted-foreground hover:text-foreground"><X className="h-3 w-3" /></button>
                      </span>
                    ))}
                  </div>
                </div>
              )}
              <div className="flex gap-6">
                <div className="flex items-center gap-2">
                  <Switch checked={form.required} onCheckedChange={(v) => setForm((f) => ({ ...f, required: v }))} id="req" />
                  <Label htmlFor="req" className="cursor-pointer">Required</Label>
                </div>
                <div className="flex items-center gap-2">
                  <Switch checked={form.showInList} onCheckedChange={(v) => setForm((f) => ({ ...f, showInList: v }))} id="sil" />
                  <Label htmlFor="sil" className="cursor-pointer">Show in list view</Label>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Sort Order</Label>
                <Input type="number" value={form.sortOrder} onChange={(e) => setForm((f) => ({ ...f, sortOrder: Number(e.target.value) }))} className="w-24" />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button onClick={handleSave} disabled={createDef.isPending || updateDef.isPending || !form.label || !form.fieldKey}>Save</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </Shell>
  );
}
