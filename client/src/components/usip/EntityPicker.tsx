/**
 * EntityPicker — reusable multi/single-select picker for CRM entities.
 * Supports: contacts | segments | sequences | campaigns | sendingAccounts | senderPools
 *
 * Usage:
 *   <EntityPicker
 *     type="contacts"
 *     mode="multi"
 *     value={selectedIds}
 *     onChange={setSelectedIds}
 *   />
 */
import { useState, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Users, Tag, GitBranch, Megaphone, Mail, Layers,
  ChevronDown, Search, X, Check,
} from "lucide-react";

export type EntityPickerType =
  | "contacts"
  | "segments"
  | "sequences"
  | "campaigns"
  | "sendingAccounts"
  | "senderPools";

interface EntityPickerProps {
  type: EntityPickerType;
  mode?: "single" | "multi";
  value: number[];
  onChange: (ids: number[]) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

interface EntityItem {
  id: number;
  label: string;
  meta?: string;
  status?: string;
}

const TYPE_CONFIG: Record<EntityPickerType, { icon: any; label: string; color: string }> = {
  contacts:       { icon: Users,     label: "Contacts",        color: "text-blue-500" },
  segments:       { icon: Tag,       label: "Segments",        color: "text-purple-500" },
  sequences:      { icon: GitBranch, label: "Sequences",       color: "text-teal-500" },
  campaigns:      { icon: Megaphone, label: "Campaigns",       color: "text-orange-500" },
  sendingAccounts:{ icon: Mail,      label: "Sending Accounts",color: "text-green-500" },
  senderPools:    { icon: Layers,    label: "Sender Pools",    color: "text-indigo-500" },
};

function useEntityItems(type: EntityPickerType): { items: EntityItem[]; loading: boolean } {
  const contacts = trpc.contacts.list.useQuery(
    { page: 1, pageSize: 200 } as any,
    { enabled: type === "contacts" }
  );
  const segments = trpc.segments.list.useQuery(
    undefined,
    { enabled: type === "segments" }
  );
  const sequences = trpc.sequences.list.useQuery(
    undefined,
    { enabled: type === "sequences" }
  );
  const campaigns = trpc.campaigns.list.useQuery(
    undefined,
    { enabled: type === "campaigns" }
  );
  const sendingAccounts = trpc.sendingAccounts.list.useQuery(
    undefined,
    { enabled: type === "sendingAccounts" }
  );
  const senderPools = trpc.senderPools.list.useQuery(
    undefined,
    { enabled: type === "senderPools" }
  );

  return useMemo(() => {
    switch (type) {
      case "contacts": {
        const rows: any[] = (contacts.data as any)?.contacts ?? contacts.data ?? [];
        return {
          items: rows.map((c: any) => ({
            id: c.id,
            label: `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() || c.email,
            meta: c.email,
            status: c.status,
          })),
          loading: contacts.isLoading,
        };
      }
      case "segments": {
        const rows: any[] = segments.data ?? [];
        return {
          items: rows.map((s: any) => ({
            id: s.id,
            label: s.name,
            meta: `${s.contactCount ?? 0} contacts`,
            status: s.status,
          })),
          loading: segments.isLoading,
        };
      }
      case "sequences": {
        const rows: any[] = sequences.data ?? [];
        return {
          items: rows.map((s: any) => ({
            id: s.id,
            label: s.name,
            meta: `${s.enrolledCount ?? 0} enrolled`,
            status: s.status,
          })),
          loading: sequences.isLoading,
        };
      }
      case "campaigns": {
        const rows: any[] = campaigns.data ?? [];
        return {
          items: rows.map((c: any) => ({
            id: c.id,
            label: c.name,
            meta: c.objective ?? c.status,
            status: c.status,
          })),
          loading: campaigns.isLoading,
        };
      }
      case "sendingAccounts": {
        const rows: any[] = sendingAccounts.data ?? [];
        return {
          items: rows.map((a: any) => ({
            id: a.id,
            label: a.fromEmail,
            meta: `${a.provider} · ${a.connectionStatus}`,
            status: a.connectionStatus,
          })),
          loading: sendingAccounts.isLoading,
        };
      }
      case "senderPools": {
        const rows: any[] = senderPools.data ?? [];
        return {
          items: rows.map((p: any) => ({
            id: p.id,
            label: p.name,
            meta: p.rotationStrategy,
            status: undefined,
          })),
          loading: senderPools.isLoading,
        };
      }
    }
  }, [type, contacts.data, segments.data, sequences.data, campaigns.data, sendingAccounts.data, senderPools.data,
      contacts.isLoading, segments.isLoading, sequences.isLoading, campaigns.isLoading, sendingAccounts.isLoading, senderPools.isLoading]);
}

export function EntityPicker({
  type,
  mode = "single",
  value,
  onChange,
  placeholder,
  disabled = false,
  className = "",
}: EntityPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const { items, loading } = useEntityItems(type);
  const config = TYPE_CONFIG[type];
  const Icon = config.icon;

  const filtered = useMemo(() => {
    if (!search.trim()) return items;
    const q = search.toLowerCase();
    return items.filter(
      (i) =>
        i.label.toLowerCase().includes(q) ||
        (i.meta ?? "").toLowerCase().includes(q)
    );
  }, [items, search]);

  const selectedItems = items.filter((i) => value.includes(i.id));

  function toggle(id: number) {
    if (mode === "single") {
      onChange(value.includes(id) ? [] : [id]);
      setOpen(false);
    } else {
      onChange(
        value.includes(id) ? value.filter((v) => v !== id) : [...value, id]
      );
    }
  }

  function remove(id: number) {
    onChange(value.filter((v) => v !== id));
  }

  const triggerLabel =
    selectedItems.length === 0
      ? placeholder ?? `Select ${config.label.toLowerCase()}…`
      : mode === "single"
      ? selectedItems[0]?.label
      : `${selectedItems.length} ${config.label.toLowerCase()} selected`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={`w-full justify-between font-normal ${className}`}
        >
          <span className="flex items-center gap-2 min-w-0">
            <Icon className={`h-4 w-4 shrink-0 ${config.color}`} />
            <span className="truncate text-sm">{triggerLabel}</span>
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        {/* Search */}
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <Search className="h-4 w-4 text-muted-foreground shrink-0" />
          <Input
            placeholder={`Search ${config.label.toLowerCase()}…`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-7 border-0 p-0 text-sm focus-visible:ring-0 shadow-none"
          />
        </div>

        {/* Selected chips (multi mode) */}
        {mode === "multi" && selectedItems.length > 0 && (
          <div className="flex flex-wrap gap-1 border-b px-3 py-2">
            {selectedItems.map((item) => (
              <Badge key={item.id} variant="secondary" className="gap-1 pr-1 text-xs">
                {item.label}
                <button
                  onClick={(e) => { e.stopPropagation(); remove(item.id); }}
                  className="ml-0.5 rounded-full hover:bg-muted"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
          </div>
        )}

        {/* List */}
        <ScrollArea className="max-h-60">
          {loading ? (
            <div className="py-6 text-center text-sm text-muted-foreground">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">No results</div>
          ) : (
            <div className="py-1">
              {filtered.map((item) => {
                const selected = value.includes(item.id);
                return (
                  <button
                    key={item.id}
                    onClick={() => toggle(item.id)}
                    className={`w-full flex items-center gap-3 px-3 py-2 text-left text-sm hover:bg-accent transition-colors ${
                      selected ? "bg-accent/60" : ""
                    }`}
                  >
                    {mode === "multi" ? (
                      <Checkbox checked={selected} className="shrink-0" />
                    ) : (
                      <span className="w-4 shrink-0">
                        {selected && <Check className="h-4 w-4 text-primary" />}
                      </span>
                    )}
                    <span className="flex-1 min-w-0">
                      <span className="block truncate font-medium">{item.label}</span>
                      {item.meta && (
                        <span className="block truncate text-xs text-muted-foreground">{item.meta}</span>
                      )}
                    </span>
                    {item.status && (
                      <Badge variant="outline" className="shrink-0 text-xs capitalize">
                        {item.status}
                      </Badge>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </ScrollArea>

        {/* Footer actions */}
        {mode === "multi" && (
          <div className="flex items-center justify-between border-t px-3 py-2">
            <span className="text-xs text-muted-foreground">
              {value.length} selected
            </span>
            {value.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-xs"
                onClick={() => onChange([])}
              >
                Clear all
              </Button>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
