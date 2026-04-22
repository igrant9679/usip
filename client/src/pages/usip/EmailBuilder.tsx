/**
 * Visual Email Builder — 3-panel layout
 * Left: block palette + template list
 * Center: canvas (vertical block stack, drag-to-reorder, click-to-select)
 * Right: block property editor + merge-tag picker
 */
import { useState, useRef, useCallback, useEffect } from "react";
import { useRoute, useLocation } from "wouter";
import { Shell, PageHeader } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  AlignCenter, AlignLeft, AlignRight,
  ArrowDown, ArrowUp, Bold,
  Bookmark, BookmarkCheck, CheckSquare,
  ChevronLeft, Columns2, Copy, Eye,
  FileText, Footprints, GripVertical,
  Heading, Image, Info, LayoutTemplate, Link2, Minus,
  Monitor, Pencil, Plus, Save, Smartphone,
  Space, Square, Tag, Trash2, Type,
  Wand2, X, Zap,
} from "lucide-react";

/* ─── Types ─────────────────────────────────────────────────────────────── */
type BlockType = "header" | "text" | "image" | "button" | "divider" | "spacer" | "two_column" | "footer";

interface Block {
  id: string;
  type: BlockType;
  props: Record<string, any>;
  sortOrder: number;
}

const BLOCK_DEFS: { type: BlockType; label: string; icon: any; defaultProps: Record<string, any> }[] = [
  {
    type: "header",
    label: "Header",
    icon: Heading,
    defaultProps: { headline: "Your Headline Here", subheadline: "", bgColor: "#14B89A", textColor: "#ffffff", logoUrl: "" },
  },
  {
    type: "text",
    label: "Text",
    icon: Type,
    defaultProps: { content: "<p>Start writing your email content here. Use {{firstName}} to personalize.</p>", fontSize: 14, color: "#1a1a1a" },
  },
  {
    type: "image",
    label: "Image",
    icon: Image,
    defaultProps: { src: "", alt: "Image", caption: "", align: "center", borderRadius: 4 },
  },
  {
    type: "button",
    label: "Button",
    icon: Square,
    defaultProps: { label: "Click Here", url: "https://", bgColor: "#14B89A", textColor: "#ffffff", align: "center", borderRadius: 4 },
  },
  {
    type: "divider",
    label: "Divider",
    icon: Minus,
    defaultProps: { color: "#e5e7eb", thickness: 1, style: "solid" },
  },
  {
    type: "spacer",
    label: "Spacer",
    icon: Space,
    defaultProps: { height: 24 },
  },
  {
    type: "two_column",
    label: "Two Column",
    icon: Columns2,
    defaultProps: { leftContent: "<p>Left column content</p>", rightContent: "<p>Right column content</p>", split: 50 },
  },
  {
    type: "footer",
    label: "Footer",
    icon: Footprints,
    defaultProps: { content: "© 2025 Your Company. All rights reserved.<br>123 Main St, City, State 12345", bgColor: "#f9fafb", textColor: "#6b7280", unsubscribeUrl: "" },
  },
];

const MERGE_TAGS = [
  { tag: "{{firstName}}", label: "First Name" },
  { tag: "{{lastName}}", label: "Last Name" },
  { tag: "{{company}}", label: "Company" },
  { tag: "{{title}}", label: "Job Title" },
  { tag: "{{senderName}}", label: "Sender Name" },
  { tag: "{{senderTitle}}", label: "Sender Title" },
  { tag: "{{senderCompany}}", label: "Sender Company" },
];

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

/* ─── Block property editors ─────────────────────────────────────────────── */
function PropField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

function BlockPropsEditor({
  block,
  onChange,
  onInsertMergeTag,
}: {
  block: Block;
  onChange: (props: Record<string, any>) => void;
  onInsertMergeTag: (tag: string) => void;
}) {
  const p = block.props;
  const set = (key: string, val: any) => onChange({ ...p, [key]: val });

  const MergeTagPicker = () => (
    <div className="mt-3">
      <p className="text-xs text-muted-foreground mb-1.5 flex items-center gap-1"><Tag size={11} /> Merge Tags</p>
      <div className="flex flex-wrap gap-1">
        {MERGE_TAGS.map((m) => (
          <button
            key={m.tag}
            onClick={() => onInsertMergeTag(m.tag)}
            className="text-[10px] bg-muted hover:bg-primary/10 hover:text-primary rounded px-1.5 py-0.5 font-mono transition-colors"
            title={`Insert ${m.label}`}
          >
            {m.tag}
          </button>
        ))}
      </div>
    </div>
  );

  switch (block.type) {
    case "header":
      return (
        <div className="space-y-3">
          <PropField label="Headline">
            <Input value={p.headline} onChange={(e) => set("headline", e.target.value)} className="h-8 text-sm" />
          </PropField>
          <PropField label="Subheadline">
            <Input value={p.subheadline} onChange={(e) => set("subheadline", e.target.value)} className="h-8 text-sm" />
          </PropField>
          <PropField label="Logo URL">
            <Input value={p.logoUrl} onChange={(e) => set("logoUrl", e.target.value)} className="h-8 text-sm" placeholder="https://..." />
          </PropField>
          <div className="grid grid-cols-2 gap-2">
            <PropField label="Background">
              <div className="flex gap-1.5 items-center">
                <input type="color" value={p.bgColor} onChange={(e) => set("bgColor", e.target.value)} className="w-8 h-8 rounded cursor-pointer border" />
                <Input value={p.bgColor} onChange={(e) => set("bgColor", e.target.value)} className="h-8 text-xs font-mono" />
              </div>
            </PropField>
            <PropField label="Text Color">
              <div className="flex gap-1.5 items-center">
                <input type="color" value={p.textColor} onChange={(e) => set("textColor", e.target.value)} className="w-8 h-8 rounded cursor-pointer border" />
                <Input value={p.textColor} onChange={(e) => set("textColor", e.target.value)} className="h-8 text-xs font-mono" />
              </div>
            </PropField>
          </div>
          <MergeTagPicker />
        </div>
      );

    case "text":
      return (
        <div className="space-y-3">
          <PropField label="Content (HTML)">
            <Textarea
              value={p.content}
              onChange={(e) => set("content", e.target.value)}
              className="text-sm font-mono min-h-[120px] resize-y"
            />
          </PropField>
          <div className="grid grid-cols-2 gap-2">
            <PropField label="Font Size (px)">
              <Input type="number" value={p.fontSize} onChange={(e) => set("fontSize", Number(e.target.value))} className="h-8 text-sm" min={10} max={32} />
            </PropField>
            <PropField label="Color">
              <div className="flex gap-1.5 items-center">
                <input type="color" value={p.color} onChange={(e) => set("color", e.target.value)} className="w-8 h-8 rounded cursor-pointer border" />
                <Input value={p.color} onChange={(e) => set("color", e.target.value)} className="h-8 text-xs font-mono" />
              </div>
            </PropField>
          </div>
          <MergeTagPicker />
        </div>
      );

    case "image":
      return (
        <div className="space-y-3">
          <PropField label="Image URL">
            <Input value={p.src} onChange={(e) => set("src", e.target.value)} className="h-8 text-sm" placeholder="https://..." />
          </PropField>
          <PropField label="Alt Text">
            <Input value={p.alt} onChange={(e) => set("alt", e.target.value)} className="h-8 text-sm" />
          </PropField>
          <PropField label="Caption">
            <Input value={p.caption} onChange={(e) => set("caption", e.target.value)} className="h-8 text-sm" />
          </PropField>
          <div className="grid grid-cols-2 gap-2">
            <PropField label="Alignment">
              <Select value={p.align} onValueChange={(v) => set("align", v)}>
                <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="left">Left</SelectItem>
                  <SelectItem value="center">Center</SelectItem>
                  <SelectItem value="right">Right</SelectItem>
                </SelectContent>
              </Select>
            </PropField>
            <PropField label="Border Radius">
              <Input type="number" value={p.borderRadius} onChange={(e) => set("borderRadius", Number(e.target.value))} className="h-8 text-sm" min={0} max={32} />
            </PropField>
          </div>
        </div>
      );

    case "button":
      return (
        <div className="space-y-3">
          <PropField label="Button Label">
            <Input value={p.label} onChange={(e) => set("label", e.target.value)} className="h-8 text-sm" />
          </PropField>
          <PropField label="URL">
            <Input value={p.url} onChange={(e) => set("url", e.target.value)} className="h-8 text-sm" placeholder="https://..." />
          </PropField>
          <div className="grid grid-cols-2 gap-2">
            <PropField label="Background">
              <div className="flex gap-1.5 items-center">
                <input type="color" value={p.bgColor} onChange={(e) => set("bgColor", e.target.value)} className="w-8 h-8 rounded cursor-pointer border" />
                <Input value={p.bgColor} onChange={(e) => set("bgColor", e.target.value)} className="h-8 text-xs font-mono" />
              </div>
            </PropField>
            <PropField label="Text Color">
              <div className="flex gap-1.5 items-center">
                <input type="color" value={p.textColor} onChange={(e) => set("textColor", e.target.value)} className="w-8 h-8 rounded cursor-pointer border" />
                <Input value={p.textColor} onChange={(e) => set("textColor", e.target.value)} className="h-8 text-xs font-mono" />
              </div>
            </PropField>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <PropField label="Alignment">
              <Select value={p.align} onValueChange={(v) => set("align", v)}>
                <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="left">Left</SelectItem>
                  <SelectItem value="center">Center</SelectItem>
                  <SelectItem value="right">Right</SelectItem>
                </SelectContent>
              </Select>
            </PropField>
            <PropField label="Border Radius">
              <Input type="number" value={p.borderRadius} onChange={(e) => set("borderRadius", Number(e.target.value))} className="h-8 text-sm" min={0} max={32} />
            </PropField>
          </div>
          <MergeTagPicker />
        </div>
      );

    case "divider":
      return (
        <div className="space-y-3">
          <PropField label="Color">
            <div className="flex gap-1.5 items-center">
              <input type="color" value={p.color} onChange={(e) => set("color", e.target.value)} className="w-8 h-8 rounded cursor-pointer border" />
              <Input value={p.color} onChange={(e) => set("color", e.target.value)} className="h-8 text-xs font-mono" />
            </div>
          </PropField>
          <div className="grid grid-cols-2 gap-2">
            <PropField label="Thickness (px)">
              <Input type="number" value={p.thickness} onChange={(e) => set("thickness", Number(e.target.value))} className="h-8 text-sm" min={1} max={8} />
            </PropField>
            <PropField label="Style">
              <Select value={p.style} onValueChange={(v) => set("style", v)}>
                <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="solid">Solid</SelectItem>
                  <SelectItem value="dashed">Dashed</SelectItem>
                  <SelectItem value="dotted">Dotted</SelectItem>
                </SelectContent>
              </Select>
            </PropField>
          </div>
        </div>
      );

    case "spacer":
      return (
        <div className="space-y-3">
          <PropField label="Height (px)">
            <Input type="number" value={p.height} onChange={(e) => set("height", Number(e.target.value))} className="h-8 text-sm" min={4} max={120} />
          </PropField>
        </div>
      );

    case "two_column":
      return (
        <div className="space-y-3">
          <PropField label="Left Column (HTML)">
            <Textarea value={p.leftContent} onChange={(e) => set("leftContent", e.target.value)} className="text-sm font-mono min-h-[80px] resize-y" />
          </PropField>
          <PropField label="Right Column (HTML)">
            <Textarea value={p.rightContent} onChange={(e) => set("rightContent", e.target.value)} className="text-sm font-mono min-h-[80px] resize-y" />
          </PropField>
          <PropField label="Left Width %">
            <Input type="number" value={p.split} onChange={(e) => set("split", Number(e.target.value))} className="h-8 text-sm" min={20} max={80} />
          </PropField>
          <MergeTagPicker />
        </div>
      );

    case "footer":
      return (
        <div className="space-y-3">
          <PropField label="Content (HTML)">
            <Textarea value={p.content} onChange={(e) => set("content", e.target.value)} className="text-sm font-mono min-h-[80px] resize-y" />
          </PropField>
          <PropField label="Unsubscribe URL">
            <Input value={p.unsubscribeUrl} onChange={(e) => set("unsubscribeUrl", e.target.value)} className="h-8 text-sm" placeholder="https://..." />
          </PropField>
          <div className="grid grid-cols-2 gap-2">
            <PropField label="Background">
              <div className="flex gap-1.5 items-center">
                <input type="color" value={p.bgColor} onChange={(e) => set("bgColor", e.target.value)} className="w-8 h-8 rounded cursor-pointer border" />
                <Input value={p.bgColor} onChange={(e) => set("bgColor", e.target.value)} className="h-8 text-xs font-mono" />
              </div>
            </PropField>
            <PropField label="Text Color">
              <div className="flex gap-1.5 items-center">
                <input type="color" value={p.textColor} onChange={(e) => set("textColor", e.target.value)} className="w-8 h-8 rounded cursor-pointer border" />
                <Input value={p.textColor} onChange={(e) => set("textColor", e.target.value)} className="h-8 text-xs font-mono" />
              </div>
            </PropField>
          </div>
        </div>
      );

    default:
      return <p className="text-sm text-muted-foreground">No properties for this block type.</p>;
  }
}

/* ─── Block canvas item ──────────────────────────────────────────────────── */
function CanvasBlock({
  block,
  isSelected,
  isReadOnly,
  onSelect,
  onMoveUp,
  onMoveDown,
  onDuplicate,
  onDelete,
  onDragStart,
  onDragOver,
  onDrop,
}: {
  block: Block;
  isSelected: boolean;
  isReadOnly: boolean;
  onSelect: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  const def = BLOCK_DEFS.find((d) => d.type === block.type);
  const Icon = def?.icon ?? FileText;
  const p = block.props;

  const renderPreview = () => {
    switch (block.type) {
      case "header":
        return (
          <div style={{ background: p.bgColor, padding: "16px 20px", borderRadius: 4 }}>
            <p style={{ color: p.textColor, fontWeight: 700, fontSize: 18, margin: 0 }}>{p.headline || "Header"}</p>
            {p.subheadline && <p style={{ color: p.textColor, opacity: 0.8, fontSize: 13, margin: "4px 0 0" }}>{p.subheadline}</p>}
          </div>
        );
      case "text":
        return (
          <div
            style={{ fontSize: p.fontSize, color: p.color, padding: "8px 0" }}
            dangerouslySetInnerHTML={{ __html: p.content || "<p>Text block</p>" }}
          />
        );
      case "image":
        return (
          <div style={{ textAlign: p.align }}>
            {p.src ? (
              <img src={p.src} alt={p.alt} style={{ maxWidth: "100%", borderRadius: p.borderRadius }} />
            ) : (
              <div className="flex items-center justify-center h-20 bg-muted rounded text-muted-foreground text-sm gap-2">
                <Image size={16} /> Image placeholder
              </div>
            )}
          </div>
        );
      case "button":
        return (
          <div style={{ textAlign: p.align }}>
            <span
              style={{
                display: "inline-block",
                background: p.bgColor,
                color: p.textColor,
                padding: "8px 20px",
                borderRadius: p.borderRadius,
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              {p.label || "Button"}
            </span>
          </div>
        );
      case "divider":
        return <hr style={{ border: "none", borderTop: `${p.thickness}px ${p.style} ${p.color}`, margin: "4px 0" }} />;
      case "spacer":
        return <div style={{ height: Math.min(p.height, 60) }} className="bg-muted/30 rounded flex items-center justify-center">
          <span className="text-[10px] text-muted-foreground">{p.height}px spacer</span>
        </div>;
      case "two_column":
        return (
          <div className="flex gap-2">
            <div
              style={{ flex: p.split, fontSize: 12, color: "#555" }}
              dangerouslySetInnerHTML={{ __html: p.leftContent || "" }}
            />
            <div
              style={{ flex: 100 - p.split, fontSize: 12, color: "#555" }}
              dangerouslySetInnerHTML={{ __html: p.rightContent || "" }}
            />
          </div>
        );
      case "footer":
        return (
          <div style={{ background: p.bgColor, padding: "10px 16px", borderRadius: 4 }}>
            <div
              style={{ color: p.textColor, fontSize: 11 }}
              dangerouslySetInnerHTML={{ __html: p.content || "" }}
            />
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div
      draggable={!isReadOnly}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onClick={onSelect}
      className={`group relative border-2 rounded-lg p-3 cursor-pointer transition-all ${
        isSelected
          ? "border-primary bg-primary/5 shadow-md"
          : "border-transparent hover:border-border bg-card"
      }`}
    >
      {/* Block type label */}
      <div className="flex items-center gap-1.5 mb-2 text-xs text-muted-foreground">
        {!isReadOnly && (
          <GripVertical size={12} className="cursor-grab opacity-40 group-hover:opacity-100" />
        )}
        <Icon size={12} />
        <span className="capitalize">{block.type.replace("_", " ")}</span>
      </div>

      {/* Preview */}
      <div className="pointer-events-none select-none overflow-hidden max-h-40">
        {renderPreview()}
      </div>

      {/* Action toolbar (visible on hover/select) */}
      {!isReadOnly && (
        <div className={`absolute top-1 right-1 flex gap-0.5 ${isSelected ? "opacity-100" : "opacity-0 group-hover:opacity-100"} transition-opacity`}>
          <button onClick={(e) => { e.stopPropagation(); onMoveUp(); }} className="p-1 rounded hover:bg-muted" title="Move up"><ArrowUp size={11} /></button>
          <button onClick={(e) => { e.stopPropagation(); onMoveDown(); }} className="p-1 rounded hover:bg-muted" title="Move down"><ArrowDown size={11} /></button>
          <button onClick={(e) => { e.stopPropagation(); onDuplicate(); }} className="p-1 rounded hover:bg-muted" title="Duplicate"><Copy size={11} /></button>
          <button onClick={(e) => { e.stopPropagation(); onDelete(); }} className="p-1 rounded hover:bg-destructive/10 hover:text-destructive" title="Delete"><Trash2 size={11} /></button>
        </div>
      )}
    </div>
  );
}

/* ─── Template list (left panel) ─────────────────────────────────────────── */
function TemplateList({ onOpen }: { onOpen: (id: number) => void }) {
  const { data: templates } = trpc.emailTemplates.list.useQuery({ status: "all" });
  const createMutation = trpc.emailTemplates.create.useMutation({
    onSuccess: (data) => onOpen(data.id),
  });
  const utils = trpc.useUtils();

  return (
    <div className="flex flex-col h-full">
      <div className="p-3 border-b flex items-center justify-between">
        <span className="text-sm font-semibold">Templates</span>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs"
          onClick={() => createMutation.mutate({ name: "Untitled Template", designData: [] })}
          disabled={createMutation.isPending}
        >
          <Plus size={12} className="mr-1" /> New
        </Button>
      </div>
      <ScrollArea className="flex-1">
        <div className="p-2 space-y-1">
          {!templates?.length && (
            <p className="text-xs text-muted-foreground text-center py-6">No templates yet. Create one to get started.</p>
          )}
          {templates?.map((t) => (
            <button
              key={t.id}
              onClick={() => onOpen(t.id)}
              className="w-full text-left rounded-md px-2.5 py-2 hover:bg-muted transition-colors"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm truncate font-medium">{t.name}</span>
                <Badge variant={t.status === "active" ? "default" : "secondary"} className="text-[10px] shrink-0">
                  {t.status}
                </Badge>
              </div>
              <p className="text-[10px] text-muted-foreground mt-0.5 truncate">{t.category}</p>
            </button>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

/* ─── Main builder ───────────────────────────────────────────────────────── */
/* ─── Saved Sections palette tab ────────────────────────────────────────── */
const SECTION_CATEGORIES = [
  { value: "all", label: "All" },
  { value: "layout", label: "Layout" },
  { value: "header", label: "Header" },
  { value: "footer", label: "Footer" },
  { value: "cta", label: "CTA" },
  { value: "testimonial", label: "Testimonial" },
  { value: "pricing", label: "Pricing" },
  { value: "custom", label: "Custom" },
] as const;

type SectionCategory = typeof SECTION_CATEGORIES[number]["value"];

function SavedSectionsPanel({
  onInsert,
  isReadOnly,
}: {
  onInsert: (blocks: Block[]) => void;
  isReadOnly: boolean;
}) {
  const [category, setCategory] = useState<SectionCategory>("all");
  const [search, setSearch] = useState("");
  const { data: sections, refetch } = trpc.savedSections.list.useQuery(
    { category, search },
  );
  const deleteMutation = trpc.savedSections.delete.useMutation({
    onSuccess: () => { toast.success("Section deleted"); refetch(); },
    onError: () => toast.error("Delete failed"),
  });

  return (
    <div className="flex flex-col h-full">
      <div className="p-2 border-b space-y-1.5">
        <Input
          placeholder="Search sections…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-7 text-xs"
        />
        <Select value={category} onValueChange={(v) => setCategory(v as SectionCategory)}>
          <SelectTrigger className="h-7 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SECTION_CATEGORIES.map((c) => (
              <SelectItem key={c.value} value={c.value} className="text-xs">{c.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <ScrollArea className="flex-1">
        <div className="p-2 space-y-2">
          {!sections?.length && (
            <p className="text-[10px] text-muted-foreground text-center py-6 px-2">
              No saved sections yet. Select blocks on the canvas and click "Save as Section".
            </p>
          )}
          {sections?.map((section) => (
            <div key={section.id} className="border rounded-lg overflow-hidden bg-card">
              {/* Mini preview */}
              {section.previewHtml ? (
                <div className="h-16 overflow-hidden bg-white pointer-events-none">
                  <div
                    className="scale-[0.25] origin-top-left"
                    style={{ width: "400%", height: "400%" }}
                    dangerouslySetInnerHTML={{ __html: section.previewHtml }}
                  />
                </div>
              ) : (
                <div className="h-10 bg-muted/40 flex items-center justify-center">
                  <Bookmark size={12} className="text-muted-foreground" />
                </div>
              )}
              <div className="p-1.5">
                <div className="flex items-start justify-between gap-1">
                  <div className="min-w-0">
                    <p className="text-[11px] font-medium truncate">{section.name}</p>
                    <Badge variant="outline" className="text-[9px] px-1 py-0 mt-0.5">{section.category}</Badge>
                  </div>
                  <div className="flex gap-0.5 shrink-0">
                    <button
                      onClick={() => !isReadOnly && onInsert((section.blocks as Block[]).map((b, i) => ({ ...b, id: uid(), sortOrder: i })))}
                      disabled={isReadOnly}
                      className="p-1 rounded hover:bg-primary/10 hover:text-primary transition-colors disabled:opacity-40"
                      title="Insert into canvas"
                    >
                      <Plus size={11} />
                    </button>
                    <button
                      onClick={() => {
                        if (confirm(`Delete "${section.name}"?`)) deleteMutation.mutate({ id: section.id });
                      }}
                      className="p-1 rounded hover:bg-destructive/10 hover:text-destructive transition-colors"
                      title="Delete section"
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

/* ─── Save as Section dialog ─────────────────────────────────────────────── */
function SaveSectionDialog({
  open,
  selectedBlocks,
  onClose,
  onSaved,
}: {
  open: boolean;
  selectedBlocks: Block[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<string>("custom");
  const createMutation = trpc.savedSections.create.useMutation({
    onSuccess: () => {
      toast.success("Section saved!");
      setName("");
      setDescription("");
      setCategory("custom");
      onSaved();
      onClose();
    },
    onError: (e) => toast.error(e.message ?? "Save failed"),
  });

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BookmarkCheck size={16} /> Save as Reusable Section
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-1">
          <div className="space-y-1">
            <Label className="text-xs">Section Name <span className="text-destructive">*</span></Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Product intro with CTA"
              className="h-8 text-sm"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Description (optional)</Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Short note about when to use this section"
              className="h-8 text-sm"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Category</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger className="h-8 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SECTION_CATEGORIES.filter((c) => c.value !== "all").map((c) => (
                  <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {selectedBlocks.length} block{selectedBlocks.length !== 1 ? "s" : ""} will be saved.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button
            size="sm"
            disabled={!name.trim() || createMutation.isPending}
            onClick={() =>
              createMutation.mutate({
                name: name.trim(),
                description: description.trim() || undefined,
                category: category as any,
                blocks: selectedBlocks.map((b, i) => ({ ...b, sortOrder: i })),
              })
            }
          >
            {createMutation.isPending ? "Saving…" : "Save Section"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ─── Starter templates ─────────────────────────────────────────────────── */
const STARTER_TEMPLATES: { id: string; label: string; description: string; blocks: Omit<Block, "id">[] }[] = [
  {
    id: "blank",
    label: "Blank",
    description: "Start from scratch with an empty canvas",
    blocks: [],
  },
  {
    id: "simple_intro",
    label: "Simple Intro",
    description: "Header + short intro text + CTA button",
    blocks: [
      { type: "header", props: { headline: "Hi {{firstName}},", subheadline: "A quick note from {{senderName}}", bgColor: "#14B89A", textColor: "#ffffff", logoUrl: "" }, sortOrder: 0 },
      { type: "text", props: { content: "<p>I wanted to reach out because I think {{company}} could benefit from what we do. Would you be open to a 15-minute call this week?</p>", fontSize: 14, color: "#1a1a1a" }, sortOrder: 1 },
      { type: "button", props: { label: "Schedule a Call", url: "https://", bgColor: "#14B89A", textColor: "#ffffff", align: "center", borderRadius: 4 }, sortOrder: 2 },
      { type: "footer", props: { content: "© 2025 {{senderCompany}}. All rights reserved.", bgColor: "#f9fafb", textColor: "#6b7280", unsubscribeUrl: "" }, sortOrder: 3 },
    ],
  },
  {
    id: "product_spotlight",
    label: "Product Spotlight",
    description: "Header + image + two-column features + CTA",
    blocks: [
      { type: "header", props: { headline: "Introducing Something New", subheadline: "Built for teams like {{company}}", bgColor: "#1e293b", textColor: "#ffffff", logoUrl: "" }, sortOrder: 0 },
      { type: "image", props: { src: "", alt: "Product screenshot", caption: "", align: "center", borderRadius: 8 }, sortOrder: 1 },
      { type: "two_column", props: { leftContent: "<p><strong>Feature One</strong><br>Describe your first key benefit here.</p>", rightContent: "<p><strong>Feature Two</strong><br>Describe your second key benefit here.</p>", split: 50 }, sortOrder: 2 },
      { type: "button", props: { label: "See It in Action", url: "https://", bgColor: "#14B89A", textColor: "#ffffff", align: "center", borderRadius: 4 }, sortOrder: 3 },
      { type: "footer", props: { content: "© 2025 {{senderCompany}}. All rights reserved.", bgColor: "#f9fafb", textColor: "#6b7280", unsubscribeUrl: "" }, sortOrder: 4 },
    ],
  },
  {
    id: "newsletter",
    label: "Newsletter",
    description: "Branded header + 3 content sections + footer",
    blocks: [
      { type: "header", props: { headline: "Monthly Update", subheadline: "What's new at {{senderCompany}}", bgColor: "#0f172a", textColor: "#ffffff", logoUrl: "" }, sortOrder: 0 },
      { type: "text", props: { content: "<p><strong>This Month's Highlights</strong><br>Share your top update or announcement here.</p>", fontSize: 14, color: "#1a1a1a" }, sortOrder: 1 },
      { type: "divider", props: { color: "#e5e7eb", thickness: 1, style: "solid" }, sortOrder: 2 },
      { type: "text", props: { content: "<p><strong>Industry Insight</strong><br>Share a relevant tip or insight for your audience.</p>", fontSize: 14, color: "#1a1a1a" }, sortOrder: 3 },
      { type: "divider", props: { color: "#e5e7eb", thickness: 1, style: "solid" }, sortOrder: 4 },
      { type: "text", props: { content: "<p><strong>Coming Up</strong><br>Let readers know what to expect next month.</p>", fontSize: 14, color: "#1a1a1a" }, sortOrder: 5 },
      { type: "footer", props: { content: "© 2025 {{senderCompany}}. You're receiving this because you opted in.<br><a href='{{unsubscribeUrl}}'>Unsubscribe</a>", bgColor: "#f9fafb", textColor: "#6b7280", unsubscribeUrl: "" }, sortOrder: 6 },
    ],
  },
  {
    id: "follow_up",
    label: "Follow-Up",
    description: "Short, personal follow-up with a single CTA",
    blocks: [
      { type: "text", props: { content: "<p>Hi {{firstName}},</p><p>Just following up on my previous note. I know your time is valuable, so I'll keep this brief.</p><p>I'd love to show you how we've helped companies like {{company}} achieve [specific result]. Would 15 minutes this week work?</p><p>Best,<br>{{senderName}}</p>", fontSize: 14, color: "#1a1a1a" }, sortOrder: 0 },
      { type: "button", props: { label: "Pick a Time", url: "https://", bgColor: "#14B89A", textColor: "#ffffff", align: "left", borderRadius: 4 }, sortOrder: 1 },
      { type: "footer", props: { content: "{{senderName}} · {{senderTitle}} · {{senderCompany}}", bgColor: "#f9fafb", textColor: "#6b7280", unsubscribeUrl: "" }, sortOrder: 2 },
    ],
  },
];

const BLOCK_TOOLTIPS: Record<string, string> = {
  header: "A branded banner with headline, subheadline, and optional logo",
  text: "A rich-text paragraph block — supports HTML and merge tags like {{firstName}}",
  image: "An image with optional caption and alignment",
  button: "A call-to-action button with customizable color and URL",
  divider: "A horizontal rule to separate sections",
  spacer: "Empty vertical space to control layout breathing room",
  two_column: "A side-by-side two-column layout for features or comparisons",
  footer: "Branded footer with company info and unsubscribe link",
};

/* ─── Main Builder ───────────────────────────────────────────────────────── */
function Builder({ templateId }: { templateId: number }) {
  const [, navigate] = useLocation();
  const { data: template, isLoading } = trpc.emailTemplates.get.useQuery({ id: templateId });
  const saveMutation = trpc.emailTemplates.save.useMutation();
  const archiveMutation = trpc.emailTemplates.archive.useMutation({
    onSuccess: () => { toast.success("Template archived"); navigate("/email-builder"); },
  });
  const duplicateMutation = trpc.emailTemplates.duplicate.useMutation({
    onSuccess: (data) => { toast.success("Duplicated"); navigate(`/email-builder/${data.id}`); },
  });
  const rewriteMutation = trpc.emailTemplates.rewriteBlock.useMutation();
  const previewQuery = trpc.emailTemplates.renderPreview.useQuery(
    { id: templateId },
    { enabled: false }
  );
  const savedSectionsUtils = trpc.useUtils();

  const [blocks, setBlocks] = useState<Block[]>([]);
  const [subject, setSubject] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [showTipBanner, setShowTipBanner] = useState(() => {
    try { return localStorage.getItem("usip_builder_tip_dismissed") !== "1"; } catch { return true; }
  });
  const [showStarterPicker, setShowStarterPicker] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Multi-select for Save as Section
  const [multiSelectMode, setMultiSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showSaveSectionDialog, setShowSaveSectionDialog] = useState(false);
  const [saveState, setSaveState] = useState<"saved" | "unsaved" | "saving">("saved");
  const [previewMode, setPreviewMode] = useState<"desktop" | "mobile">("desktop");
  const [showPreview, setShowPreview] = useState(false);
  const [previewHtml, setPreviewHtml] = useState("");
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [palettTab, setPaletteTab] = useState<"blocks" | "sections">("blocks");
  const dragSrcId = useRef<string | null>(null);
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load template data — show starter picker for new empty templates
  useEffect(() => {
    if (template) {
      const loadedBlocks = (template.designData as Block[]) ?? [];
      setBlocks(loadedBlocks);
      setSubject(template.subject ?? "");
      setTemplateName(template.name);
      setSaveState("saved");
      // Show starter picker if this is a freshly-created template with no blocks
      if (loadedBlocks.length === 0 && template.name === "Untitled Template") {
        setShowStarterPicker(true);
      }
    }
  }, [template]);

  // Toggle a block in/out of multi-select
  const toggleBlockSelection = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  // Autosave
  useEffect(() => {
    if (saveState === "unsaved") {
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
      autosaveTimer.current = setTimeout(() => handleSave(), 30_000);
    }
    return () => { if (autosaveTimer.current) clearTimeout(autosaveTimer.current); };
  }, [saveState, blocks, subject]);

  const markDirty = useCallback(() => setSaveState("unsaved"), []);

  // Insert blocks from a saved section at the end of the canvas
  const insertSectionBlocks = useCallback((newBlocks: Block[]) => {
    setBlocks((prev) => {
      const offset = prev.length;
      const appended = newBlocks.map((b, i) => ({ ...b, sortOrder: offset + i }));
      return [...prev, ...appended];
    });
    setSaveState("unsaved");
    toast.success(`${newBlocks.length} block${newBlocks.length !== 1 ? "s" : ""} inserted`);
  }, []);

  const handleSave = useCallback(async () => {
    setSaveState("saving");
    try {
      await saveMutation.mutateAsync({
        id: templateId,
        name: templateName,
        subject,
        designData: blocks,
      });
      setSaveState("saved");
    } catch {
      setSaveState("unsaved");
      toast.error("Save failed");
    }
  }, [templateId, templateName, subject, blocks, saveMutation]);

  const addBlock = (type: BlockType) => {
    const def = BLOCK_DEFS.find((d) => d.type === type)!;
    const newBlock: Block = {
      id: uid(),
      type,
      props: { ...def.defaultProps },
      sortOrder: blocks.length,
    };
    setBlocks((prev) => [...prev, newBlock]);
    setSelectedId(newBlock.id);
    markDirty();
  };

  const updateBlock = (id: string, props: Record<string, any>) => {
    setBlocks((prev) => prev.map((b) => (b.id === id ? { ...b, props } : b)));
    markDirty();
  };

  const moveBlock = (id: string, dir: "up" | "down") => {
    setBlocks((prev) => {
      const idx = prev.findIndex((b) => b.id === id);
      if (idx < 0) return prev;
      const next = [...prev];
      const swap = dir === "up" ? idx - 1 : idx + 1;
      if (swap < 0 || swap >= next.length) return prev;
      [next[idx], next[swap]] = [next[swap]!, next[idx]!];
      return next.map((b, i) => ({ ...b, sortOrder: i }));
    });
    markDirty();
  };

  const duplicateBlock = (id: string) => {
    setBlocks((prev) => {
      const idx = prev.findIndex((b) => b.id === id);
      if (idx < 0) return prev;
      const src = prev[idx]!;
      const copy: Block = { ...src, id: uid(), sortOrder: idx + 1 };
      const next = [...prev.slice(0, idx + 1), copy, ...prev.slice(idx + 1)];
      return next.map((b, i) => ({ ...b, sortOrder: i }));
    });
    markDirty();
  };

  const deleteBlock = (id: string) => {
    setBlocks((prev) => prev.filter((b) => b.id !== id).map((b, i) => ({ ...b, sortOrder: i })));
    if (selectedId === id) setSelectedId(null);
    markDirty();
  };

  const insertMergeTag = (tag: string) => {
    if (!selectedId) return;
    const block = blocks.find((b) => b.id === selectedId);
    if (!block) return;
    // Insert into the most relevant text field
    const textFields = ["content", "headline", "subheadline", "label", "leftContent", "rightContent"];
    for (const field of textFields) {
      if (field in block.props) {
        updateBlock(selectedId, { ...block.props, [field]: String(block.props[field] ?? "") + tag });
        break;
      }
    }
  };

  const handleDragStart = (e: React.DragEvent, id: string) => {
    dragSrcId.current = id;
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragOver = (e: React.DragEvent, id: string) => {
    e.preventDefault();
    setDragOverId(id);
  };

  const handleDrop = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    setDragOverId(null);
    const srcId = dragSrcId.current;
    if (!srcId || srcId === targetId) return;
    setBlocks((prev) => {
      const srcIdx = prev.findIndex((b) => b.id === srcId);
      const tgtIdx = prev.findIndex((b) => b.id === targetId);
      if (srcIdx < 0 || tgtIdx < 0) return prev;
      const next = [...prev];
      const [moved] = next.splice(srcIdx, 1);
      next.splice(tgtIdx, 0, moved!);
      return next.map((b, i) => ({ ...b, sortOrder: i }));
    });
    markDirty();
  };

  const handlePreview = async () => {
    const result = await previewQuery.refetch();
    if (result.data) {
      setPreviewHtml(result.data.html);
      setShowPreview(true);
    }
  };

  const isReadOnly = template?.status === "active" || template?.status === "archived";
  const selectedBlock = blocks.find((b) => b.id === selectedId) ?? null;

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Top bar */}
      <div className="flex items-center gap-3 px-4 py-2 border-b bg-card shrink-0">
        {/* Template name — click-to-edit with pencil affordance */}
        {editingName && !isReadOnly ? (
          <Input
            autoFocus
            value={templateName}
            onChange={(e) => { setTemplateName(e.target.value); markDirty(); }}
            onBlur={() => setEditingName(false)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") setEditingName(false); }}
            className="h-8 text-sm font-semibold max-w-[240px]"
          />
        ) : (
          <button
            onClick={() => !isReadOnly && setEditingName(true)}
            className={`flex items-center gap-1.5 px-2 h-8 rounded-md text-sm font-semibold max-w-[240px] truncate hover:bg-muted transition-colors group ${isReadOnly ? "cursor-default" : "cursor-text"}`}
            title={isReadOnly ? undefined : "Click to rename template"}
          >
            <span className="truncate">{templateName || "Untitled Template"}</span>
            {!isReadOnly && <Pencil size={11} className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />}
          </button>
        )}
        <div className="flex-1 flex items-center gap-2">
          <Label className="text-xs text-muted-foreground shrink-0">Subject:</Label>
          <Input
            value={subject}
            onChange={(e) => { setSubject(e.target.value); markDirty(); }}
            className="h-8 text-sm"
            placeholder="Email subject line with {{firstName}} support"
            disabled={isReadOnly}
          />
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {/* Multi-select mode controls */}
          {!isReadOnly && (
            multiSelectMode ? (
              <>
                <span className="text-xs text-primary font-medium">{selectedIds.size} selected</span>
                <Button
                  size="sm"
                  variant="default"
                  className="h-7 px-2 text-xs"
                  disabled={selectedIds.size === 0}
                  onClick={() => setShowSaveSectionDialog(true)}
                >
                  <BookmarkCheck size={12} className="mr-1" /> Save as Section
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-xs"
                  onClick={() => { setMultiSelectMode(false); setSelectedIds(new Set()); }}
                >
                  <X size={12} className="mr-1" /> Cancel
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs"
                onClick={() => { setMultiSelectMode(true); setSelectedIds(new Set()); }}
                title="Select multiple blocks to save as a reusable section"
              >
                <CheckSquare size={12} className="mr-1" /> Select
              </Button>
            )
          )}
          <span className={`text-xs ${saveState === "saved" ? "text-green-600" : saveState === "saving" ? "text-amber-500" : "text-muted-foreground"}`}>
            {saveState === "saved" ? "Saved" : saveState === "saving" ? "Saving…" : "Unsaved"}
          </span>
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={handlePreview}>
            <Eye size={12} className="mr-1" /> Preview
          </Button>
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => duplicateMutation.mutate({ id: templateId })}>
            <Copy size={12} className="mr-1" /> Duplicate
          </Button>
          {!isReadOnly && (
            <>
              <Button size="sm" variant="outline" className="h-7 px-2 text-xs text-destructive hover:text-destructive" onClick={() => archiveMutation.mutate({ id: templateId })}>
                Archive
              </Button>
              <Button size="sm" className="h-7 px-3 text-xs" onClick={handleSave} disabled={saveState === "saving"}>
                <Save size={12} className="mr-1" /> Save
              </Button>
            </>
          )}
          {isReadOnly && (
            <Badge variant="secondary" className="text-xs">{template?.status}</Badge>
          )}
        </div>
      </div>

      {/* 3-panel body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: block palette + saved sections */}
        <div className="w-48 shrink-0 border-r bg-muted/30 flex flex-col">
          <Tabs value={palettTab} onValueChange={(v) => setPaletteTab(v as "blocks" | "sections")} className="flex flex-col h-full">
            <TabsList className="w-full rounded-none border-b h-8 shrink-0 bg-transparent px-1 gap-1">
              <TabsTrigger value="blocks" className="flex-1 text-[11px] h-6 data-[state=active]:bg-background data-[state=active]:shadow-sm">
                Blocks
              </TabsTrigger>
              <TabsTrigger value="sections" className="flex-1 text-[11px] h-6 data-[state=active]:bg-background data-[state=active]:shadow-sm">
                <Bookmark size={10} className="mr-1" /> Saved
              </TabsTrigger>
            </TabsList>
            <TabsContent value="blocks" className="flex-1 overflow-hidden mt-0">
              <ScrollArea className="h-full">
                <div className="p-2 space-y-1">
                  <TooltipProvider delayDuration={400}>
                    {BLOCK_DEFS.map((def) => {
                      const Icon = def.icon;
                      return (
                        <Tooltip key={def.type}>
                          <TooltipTrigger asChild>
                            <button
                              onClick={() => !isReadOnly && addBlock(def.type)}
                              disabled={isReadOnly}
                              className="w-full flex items-center gap-2 px-2.5 py-2 rounded-md hover:bg-background hover:shadow-sm transition-all text-left disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              <Icon size={14} className="text-muted-foreground shrink-0" />
                              <span className="text-xs font-medium">{def.label}</span>
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="right" className="max-w-[180px] text-xs">
                            {BLOCK_TOOLTIPS[def.type]}
                          </TooltipContent>
                        </Tooltip>
                      );
                    })}
                  </TooltipProvider>
                </div>
              </ScrollArea>
            </TabsContent>
            <TabsContent value="sections" className="flex-1 overflow-hidden mt-0">
              <SavedSectionsPanel onInsert={insertSectionBlocks} isReadOnly={isReadOnly} />
            </TabsContent>
          </Tabs>
        </div>

        {/* Center: canvas */}
        <div className="flex-1 overflow-auto bg-muted/20 p-4">
          {/* Tip banner — dismissible, shown once */}
          {showTipBanner && !isReadOnly && (
            <div className="mb-3 px-3 py-2 bg-primary/5 border border-primary/20 rounded-lg text-xs text-primary flex items-center gap-2">
              <Info size={12} className="shrink-0" />
              <span className="flex-1"><strong>Tip:</strong> Click <strong>Select</strong> in the toolbar to choose multiple blocks and save them as a reusable section — perfect for headers, footers, and CTAs you use often.</span>
              <button
                onClick={() => { setShowTipBanner(false); try { localStorage.setItem("usip_builder_tip_dismissed", "1"); } catch {} }}
                className="shrink-0 text-primary/60 hover:text-primary"
              >
                <X size={12} />
              </button>
            </div>
          )}
          {isReadOnly && (
            <div className="mb-3 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700 flex items-center gap-2">
              <Zap size={12} /> This template is <strong>{template?.status}</strong>. Duplicate it to make edits.
            </div>
          )}
          <div className="max-w-[600px] mx-auto space-y-1.5">
            {blocks.length === 0 && (
              <div className="border-2 border-dashed border-border rounded-xl p-6 text-center space-y-4">
                <LayoutTemplate size={32} className="mx-auto text-muted-foreground" />
                <div>
                  <p className="text-sm font-semibold text-foreground mb-1">Start building your email</p>
                  <p className="text-xs text-muted-foreground">Pick a starter layout or add blocks one by one from the left panel</p>
                </div>
                {/* Quick-add row */}
                <div className="flex justify-center gap-2 flex-wrap">
                  {(["header", "text", "button", "footer"] as BlockType[]).map((t) => {
                    const def = BLOCK_DEFS.find((d) => d.type === t)!;
                    const Icon = def.icon;
                    return (
                      <button
                        key={t}
                        onClick={() => addBlock(t)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-border bg-background hover:bg-muted hover:border-primary/40 text-xs font-medium transition-all"
                      >
                        <Icon size={11} className="text-muted-foreground" />
                        {def.label}
                      </button>
                    );
                  })}
                </div>
                <button
                  onClick={() => setShowStarterPicker(true)}
                  className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline font-medium"
                >
                  <LayoutTemplate size={11} /> Browse starter layouts
                </button>
              </div>
            )}
            {blocks.map((block) => (
              <div
                key={block.id}
                className={dragOverId === block.id ? "ring-2 ring-primary ring-offset-1 rounded-lg" : ""}
              >
                {multiSelectMode ? (
                  // Multi-select overlay: click to toggle, show checkbox
                  <div
                    onClick={() => toggleBlockSelection(block.id)}
                    className={`relative border-2 rounded-lg p-3 cursor-pointer transition-all ${
                      selectedIds.has(block.id)
                        ? "border-primary bg-primary/10 shadow-md"
                        : "border-dashed border-border hover:border-primary/50"
                    }`}
                  >
                    <div className="absolute top-2 left-2 z-10">
                      <div className={`w-4 h-4 rounded border-2 flex items-center justify-center ${
                        selectedIds.has(block.id) ? "bg-primary border-primary" : "bg-background border-muted-foreground"
                      }`}>
                        {selectedIds.has(block.id) && (
                          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                            <path d="M2 5l2.5 2.5L8 3" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        )}
                      </div>
                    </div>
                    <div className="pointer-events-none select-none overflow-hidden max-h-24 pl-6">
                      <div className="flex items-center gap-1 mb-1 text-xs text-muted-foreground">
                        <span className="capitalize">{block.type.replace("_", " ")}</span>
                      </div>
                    </div>
                  </div>
                ) : (
                  <CanvasBlock
                    block={block}
                    isSelected={selectedId === block.id}
                    isReadOnly={isReadOnly}
                    onSelect={() => setSelectedId(block.id)}
                    onMoveUp={() => moveBlock(block.id, "up")}
                    onMoveDown={() => moveBlock(block.id, "down")}
                    onDuplicate={() => duplicateBlock(block.id)}
                    onDelete={() => deleteBlock(block.id)}
                    onDragStart={(e) => handleDragStart(e, block.id)}
                    onDragOver={(e) => handleDragOver(e, block.id)}
                    onDrop={(e) => handleDrop(e, block.id)}
                  />
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Right: properties panel */}
        <div className="w-64 shrink-0 border-l bg-card flex flex-col">
          {/* Getting-started hint when nothing is selected */}
          {!selectedBlock && blocks.length === 0 && (
            <div className="p-4 space-y-3">
              <p className="text-xs font-semibold text-foreground">Getting Started</p>
              <ol className="space-y-2.5">
                {[
                  { step: "1", text: "Click a block type on the left (or use a starter layout) to add it to your canvas" },
                  { step: "2", text: "Click any block on the canvas to edit its content and style here" },
                  { step: "3", text: "Use the Preview button to see how your email looks on desktop and mobile" },
                ].map(({ step, text }) => (
                  <li key={step} className="flex gap-2.5 text-xs text-muted-foreground">
                    <span className="shrink-0 w-4 h-4 rounded-full bg-primary/10 text-primary text-[10px] font-bold flex items-center justify-center">{step}</span>
                    <span>{text}</span>
                  </li>
                ))}
              </ol>
              <div className="pt-1 border-t">
                <p className="text-[10px] text-muted-foreground">Use <strong>{"{{firstName}}"}</strong>, <strong>{"{{company}}"}</strong> and other merge tags to personalize each send automatically.</p>
              </div>
            </div>
          )}
          {!selectedBlock && blocks.length > 0 && (
            <div className="flex-1 flex flex-col items-center justify-center p-4 gap-2">
              <p className="text-xs text-muted-foreground text-center">Click a block to edit its properties</p>
              <p className="text-[10px] text-muted-foreground/60 text-center">Or use <strong>Select</strong> mode to save groups of blocks as reusable sections</p>
            </div>
          )}
          {selectedBlock ? (
            <>
              <div className="px-3 py-2 border-b flex items-center justify-between">
                <p className="text-xs font-semibold capitalize">{selectedBlock.type.replace("_", " ")} Properties</p>
                <button onClick={() => setSelectedId(null)} className="text-muted-foreground hover:text-foreground">
                  <X size={13} />
                </button>
              </div>
              <ScrollArea className="flex-1">
                <div className="p-3">
                  <BlockPropsEditor
                    block={selectedBlock}
                    onChange={(props) => updateBlock(selectedBlock.id, props)}
                    onInsertMergeTag={insertMergeTag}
                  />
                  {/* AI rewrite for text blocks */}
                  {(selectedBlock.type === "text" || selectedBlock.type === "header") && !isReadOnly && (
                    <>
                      <Separator className="my-3" />
                      <p className="text-xs font-semibold mb-2 flex items-center gap-1"><Wand2 size={11} /> AI Rewrite</p>
                      <div className="flex flex-wrap gap-1">
                        {(["rewrite", "shorten", "lengthen", "make_formal", "make_casual"] as const).map((instr) => (
                          <button
                            key={instr}
                            disabled={rewriteMutation.isPending}
                            onClick={async () => {
                              const content = selectedBlock.type === "text"
                                ? String(selectedBlock.props.content ?? "")
                                : String(selectedBlock.props.headline ?? "");
                              const result = await rewriteMutation.mutateAsync({ content, instruction: instr });
                              if (selectedBlock.type === "text") {
                                updateBlock(selectedBlock.id, { ...selectedBlock.props, content: result.content });
                              } else {
                                updateBlock(selectedBlock.id, { ...selectedBlock.props, headline: result.content });
                              }
                            }}
                            className="text-[10px] bg-muted hover:bg-primary/10 hover:text-primary rounded px-2 py-1 transition-colors disabled:opacity-50 capitalize"
                          >
                            {instr.replace("_", " ")}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </ScrollArea>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center p-4">
              <p className="text-xs text-muted-foreground text-center">Click a block to edit its properties</p>
            </div>
          )}
        </div>
      </div>

      {/* Starter template picker dialog */}
      <Dialog open={showStarterPicker} onOpenChange={setShowStarterPicker}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Choose a Starter Layout</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 py-2">
            {STARTER_TEMPLATES.map((tmpl) => (
              <button
                key={tmpl.id}
                onClick={() => {
                  if (tmpl.blocks.length > 0) {
                    const withIds = tmpl.blocks.map((b) => ({ ...b, id: uid() }));
                    setBlocks(withIds);
                    markDirty();
                  }
                  setShowStarterPicker(false);
                }}
                className="flex flex-col items-start gap-1.5 p-3 rounded-lg border border-border hover:border-primary hover:bg-primary/5 text-left transition-all group"
              >
                <div className="w-full h-20 rounded bg-muted flex items-center justify-center mb-1 group-hover:bg-primary/10 transition-colors">
                  <LayoutTemplate size={24} className="text-muted-foreground group-hover:text-primary transition-colors" />
                </div>
                <p className="text-xs font-semibold">{tmpl.label}</p>
                <p className="text-[10px] text-muted-foreground leading-snug">{tmpl.description}</p>
                {tmpl.blocks.length > 0 && (
                  <span className="text-[10px] text-primary/70">{tmpl.blocks.length} block{tmpl.blocks.length !== 1 ? "s" : ""}</span>
                )}
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {/* Save as Section dialog */}
      <SaveSectionDialog
        open={showSaveSectionDialog}
        selectedBlocks={blocks.filter((b) => selectedIds.has(b.id))}
        onClose={() => setShowSaveSectionDialog(false)}
        onSaved={() => {
          setMultiSelectMode(false);
          setSelectedIds(new Set());
          savedSectionsUtils.savedSections.list.invalidate();
        }}
      />

      {/* Preview dialog */}
      <Dialog open={showPreview} onOpenChange={setShowPreview}>
        <DialogContent className="max-w-3xl max-h-[90vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-3">
              Preview
              <div className="flex gap-1 ml-2">
                <Button size="sm" variant={previewMode === "desktop" ? "default" : "outline"} className="h-7 px-2 text-xs" onClick={() => setPreviewMode("desktop")}>
                  <Monitor size={12} className="mr-1" /> Desktop
                </Button>
                <Button size="sm" variant={previewMode === "mobile" ? "default" : "outline"} className="h-7 px-2 text-xs" onClick={() => setPreviewMode("mobile")}>
                  <Smartphone size={12} className="mr-1" /> Mobile
                </Button>
              </div>
            </DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-auto bg-muted/30 rounded-lg p-4">
            <div
              className="mx-auto bg-white shadow-md transition-all duration-300"
              style={{ maxWidth: previewMode === "mobile" ? 375 : 600 }}
            >
              <iframe
                srcDoc={previewHtml}
                className="w-full border-0"
                style={{ minHeight: 500 }}
                title="Email preview"
              />
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ─── Page entry point ───────────────────────────────────────────────────── */
export default function EmailBuilderPage() {
  const [matchId, params] = useRoute("/email-builder/:id");
  const [, navigate] = useLocation();
  const templateId = matchId && params?.id ? Number(params.id) : null;

  if (templateId) {
    return (
      <Shell title="Email Builder">
        <div className="flex h-[calc(100vh-56px)] -mt-6 -mx-4 md:-mx-6 overflow-hidden">
          <Builder templateId={templateId} />
        </div>
      </Shell>
    );
  }

  // Template list view
  return (
    <Shell title="Email Builder">
      <PageHeader
        title="Email Builder"
        description="Design reusable email templates with drag-and-drop blocks"
      />
      <div className="flex h-[calc(100vh-180px)] border rounded-xl overflow-hidden bg-card">
        <TemplateList onOpen={(id) => navigate(`/email-builder/${id}`)} />
      </div>
    </Shell>
  );
}

// Re-export for lazy import
export { EmailBuilderPage };


