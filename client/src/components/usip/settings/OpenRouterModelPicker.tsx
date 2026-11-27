/**
 * OpenRouterModelPicker — pick a model from OpenRouter's own list (owner
 * decisions 2026-11-27).
 *
 * The list is read live from OpenRouter on the server (aiCredentials.
 * openrouterModels, cached there for a few hours) and holds only the models
 * that can give a structured answer: in Velocity every tier and the default
 * model carry structured work (scores, classifications, targeting), so a
 * model that cannot is never offered. Each row shows the price per million
 * tokens. The default, the newest Claude Sonnet that takes tools, comes from
 * the same live list; nothing here names a model.
 */
import { useState } from "react";
import { Check, ChevronsUpDown, Loader2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export function OpenRouterModelPicker({
  value,
  onChange,
  allowDefault = false,
  disabled = false,
  label = "OpenRouter model",
  className = "",
}: {
  /** The chosen model id; "" = the default model (only with allowDefault). */
  value: string;
  onChange: (id: string) => void;
  /** Offer "the default model" as a choice that saves as no model of its own. */
  allowDefault?: boolean;
  disabled?: boolean;
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const q = trpc.aiCredentials.openrouterModels.useQuery(undefined, { staleTime: 60 * 60 * 1000 });
  const models = q.data?.models ?? [];
  const byId = new Map(models.map((m) => [m.id, m]));
  const defaultModel = q.data ? byId.get(q.data.defaultModelId) : undefined;
  const selected = value ? byId.get(value) : undefined;
  const triggerText = value
    ? selected?.name ?? value
    : allowDefault
      ? `Default: ${defaultModel?.name ?? q.data?.defaultModelId ?? "newest Claude Sonnet"}`
      : "Pick from OpenRouter's list";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={label}
          disabled={disabled}
          className={`h-8 justify-between gap-1.5 text-xs font-normal ${className}`}
        >
          <span className="truncate">{triggerText}</span>
          <ChevronsUpDown className="size-3.5 opacity-50 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(28rem,calc(100vw-2rem))] p-0" align="start">
        {q.isLoading ? (
          <div className="flex justify-center p-4"><Loader2 className="size-4 animate-spin text-muted-foreground" /></div>
        ) : (
          <Command filter={(val, search) => (val.toLowerCase().includes(search.toLowerCase()) ? 1 : 0)}>
            <CommandInput placeholder="Search models…" />
            {q.data?.error && (
              <div className="px-3 py-2 text-[11px] text-amber-700 dark:text-amber-400">
                {models.length > 0 ? "Showing the list read earlier: " : "OpenRouter's list could not be read: "}
                {q.data.error}
              </div>
            )}
            <CommandList className="max-h-80">
              <CommandEmpty>No model found.</CommandEmpty>
              <CommandGroup>
                {allowDefault && (
                  <CommandItem value="default newest claude sonnet" onSelect={() => { onChange(""); setOpen(false); }}>
                    <Check className={value === "" ? "mr-2 size-4 opacity-100" : "mr-2 size-4 opacity-0"} />
                    <div className="min-w-0">
                      <div className="truncate">Default: {defaultModel?.name ?? q.data?.defaultModelId}</div>
                      <div className="text-[11px] text-muted-foreground">The newest Claude Sonnet on OpenRouter, kept up to date</div>
                    </div>
                  </CommandItem>
                )}
                {models.map((m) => (
                  <CommandItem key={m.id} value={`${m.name} ${m.id}`} onSelect={() => { onChange(m.id); setOpen(false); }}>
                    <Check className={value === m.id ? "mr-2 size-4 opacity-100" : "mr-2 size-4 opacity-0"} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate">{m.name}</div>
                      <div className="text-[11px] text-muted-foreground truncate">
                        <span className="font-mono">{m.id}</span> · {m.price}
                        {m.contextLength ? ` · ${Math.round(m.contextLength / 1000).toLocaleString()}k context` : ""}
                      </div>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
            {q.data && q.data.notOffered > 0 && (
              <div className="border-t px-3 py-2 text-[11px] text-muted-foreground">
                {q.data.notOffered} more models on OpenRouter are not listed: they cannot give the structured answers Velocity's AI features need.
              </div>
            )}
          </Command>
        )}
      </PopoverContent>
    </Popover>
  );
}

export default OpenRouterModelPicker;
