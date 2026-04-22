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
import {
  AlignCenter, AlignLeft, AlignRight,
  ArrowDown, ArrowUp, Bold,
  ChevronLeft, Columns2, Copy, Eye,
  FileText, Footprints, GripVertical,
  Heading, Image, Link2, Minus,
  Monitor, Plus, Save, Smartphone,
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

  const [blocks, setBlocks] = useState<Block[]>([]);
  const [subject, setSubject] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"saved" | "unsaved" | "saving">("saved");
  const [previewMode, setPreviewMode] = useState<"desktop" | "mobile">("desktop");
  const [showPreview, setShowPreview] = useState(false);
  const [previewHtml, setPreviewHtml] = useState("");
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const dragSrcId = useRef<string | null>(null);
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load template data
  useEffect(() => {
    if (template) {
      setBlocks((template.designData as Block[]) ?? []);
      setSubject(template.subject ?? "");
      setTemplateName(template.name);
      setSaveState("saved");
    }
  }, [template]);

  // Autosave
  useEffect(() => {
    if (saveState === "unsaved") {
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
      autosaveTimer.current = setTimeout(() => handleSave(), 30_000);
    }
    return () => { if (autosaveTimer.current) clearTimeout(autosaveTimer.current); };
  }, [saveState, blocks, subject]);

  const markDirty = useCallback(() => setSaveState("unsaved"), []);

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
        <Input
          value={templateName}
          onChange={(e) => { setTemplateName(e.target.value); markDirty(); }}
          className="h-8 text-sm font-semibold max-w-[240px]"
          disabled={isReadOnly}
        />
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
        {/* Left: block palette */}
        <div className="w-44 shrink-0 border-r bg-muted/30 flex flex-col">
          <div className="px-3 py-2 border-b">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Blocks</p>
          </div>
          <ScrollArea className="flex-1">
            <div className="p-2 space-y-1">
              {BLOCK_DEFS.map((def) => {
                const Icon = def.icon;
                return (
                  <button
                    key={def.type}
                    onClick={() => !isReadOnly && addBlock(def.type)}
                    disabled={isReadOnly}
                    className="w-full flex items-center gap-2 px-2.5 py-2 rounded-md hover:bg-background hover:shadow-sm transition-all text-left disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Icon size={14} className="text-muted-foreground shrink-0" />
                    <span className="text-xs font-medium">{def.label}</span>
                  </button>
                );
              })}
            </div>
          </ScrollArea>
        </div>

        {/* Center: canvas */}
        <div className="flex-1 overflow-auto bg-muted/20 p-4">
          {isReadOnly && (
            <div className="mb-3 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700 flex items-center gap-2">
              <Zap size={12} /> This template is <strong>{template?.status}</strong>. Duplicate it to make edits.
            </div>
          )}
          <div className="max-w-[600px] mx-auto space-y-1.5">
            {blocks.length === 0 && (
              <div className="border-2 border-dashed border-border rounded-xl p-12 text-center">
                <LayoutTemplate size={32} className="mx-auto text-muted-foreground mb-3" />
                <p className="text-sm font-medium text-muted-foreground">Click a block type on the left to add it to your email</p>
              </div>
            )}
            {blocks.map((block) => (
              <div
                key={block.id}
                className={dragOverId === block.id ? "ring-2 ring-primary ring-offset-1 rounded-lg" : ""}
              >
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
              </div>
            ))}
          </div>
        </div>

        {/* Right: properties panel */}
        <div className="w-64 shrink-0 border-l bg-card flex flex-col">
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

// Needed for the import in App.tsx
const LayoutTemplate = ({ size, className }: { size?: number; className?: string }) => (
  <svg width={size ?? 16} height={size ?? 16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M3 9h18M9 21V9" />
  </svg>
);
