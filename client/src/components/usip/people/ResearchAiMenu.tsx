/**
 * ResearchAiMenu — the purple-accent "Research with AI" control.
 *
 * Dropdown options mirror Apollo: Run custom AI prompt · Generate AI formula ·
 * Use Velocity Assistant · Start with a template. The Assistant option routes
 * to the real /v2/ai-assistant surface; the other three open a clearly-labelled
 * placeholder modal (the AI research backend isn't wired yet) with the selected
 * action's title and a Cancel/Close. Reused (compact) inside the selection
 * toolbar via the `compact` prop.
 */
import { useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { Sparkles, ChevronDown, Sigma, Bot, LayoutTemplate } from "lucide-react";

const PURPLE =
  "border-violet-200 bg-violet-50 text-violet-700 hover:bg-violet-100 hover:text-violet-800 dark:border-violet-900 dark:bg-violet-950/40 dark:text-violet-300 dark:hover:bg-violet-900/40";

export function ResearchAiMenu({ compact = false }: { compact?: boolean }) {
  const [, setLocation] = useLocation();
  const [modal, setModal] = useState<string | null>(null);

  const items = [
    { id: "prompt", label: "Run custom AI prompt", icon: Sparkles },
    { id: "formula", label: "Generate AI formula", icon: Sigma },
    { id: "assistant", label: "Use Velocity Assistant", icon: Bot, route: "/v2/ai-assistant" },
    { id: "template", label: "Start with a template", icon: LayoutTemplate },
  ];

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className={cn("gap-1.5", PURPLE)}>
            <Sparkles className="size-4" /> Research with AI <ChevronDown className="size-3.5 opacity-70" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align={compact ? "start" : "end"} className="w-56">
          {items.slice(0, 2).map((it) => (
            <DropdownMenuItem key={it.id} onClick={() => setModal(it.label)}>
              <it.icon className="size-4 mr-2 text-violet-600 dark:text-violet-400" /> {it.label}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          {items.slice(2).map((it) => (
            <DropdownMenuItem
              key={it.id}
              onClick={() => (it.route ? setLocation(it.route) : setModal(it.label))}
            >
              <it.icon className="size-4 mr-2 text-violet-600 dark:text-violet-400" /> {it.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={!!modal} onOpenChange={(o) => !o && setModal(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="size-4 text-violet-600" /> {modal}
            </DialogTitle>
            <DialogDescription>
              AI research runs against the people in your current view. This action isn’t connected
              yet — it’ll let you {modal?.toLowerCase()} once AI research is enabled for your workspace.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setModal(null)}>Cancel</Button>
            <Button onClick={() => { setLocation("/v2/ai-assistant"); setModal(null); }}>
              Open AI Assistant
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
