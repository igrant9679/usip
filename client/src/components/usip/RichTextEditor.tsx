/**
 * RichTextEditor — shared Tiptap-based rich text editor component.
 *
 * Every email composition surface mounts THIS component, so a capability
 * added here (the "/" block menu, the AI assistant) appears everywhere at
 * once instead of screen by screen.
 *
 * Props:
 *   value        – HTML string (controlled)
 *   onChange     – called with new HTML string on every change
 *   placeholder  – placeholder text shown when empty
 *   minHeight    – minimum editor height (default "200px")
 *   maxHeight    – max height before scroll (default "600px")
 *   disabled     – read-only mode
 *   showCount    – show character count in footer (default false)
 *   compact      – smaller toolbar, no heading picker (for inline use)
 *   ai           – show the AI assistant (default true; needs tRPC context)
 *   aiContext    – optional subject/recipient info that sharpens AI output
 */

import { useCallback, useEffect, useState, useRef, forwardRef, useImperativeHandle } from "react";
import { useEditor, EditorContent, ReactRenderer, Extension } from "@tiptap/react";
import type { Editor, Range as TiptapRange } from "@tiptap/react";
import Suggestion from "@tiptap/suggestion";
import StarterKit from "@tiptap/starter-kit";
import { Underline } from "@tiptap/extension-underline";
import { Link } from "@tiptap/extension-link";
import { TextAlign } from "@tiptap/extension-text-align";
import { Color } from "@tiptap/extension-color";
import { TextStyle } from "@tiptap/extension-text-style";
import { Highlight } from "@tiptap/extension-highlight";
import { Table, TableRow, TableCell, TableHeader } from "@tiptap/extension-table";
import { Image } from "@tiptap/extension-image";
import { CharacterCount } from "@tiptap/extension-character-count";
import { Placeholder } from "@tiptap/extension-placeholder";
import {
  Bold, Italic, Underline as UnderlineIcon, Strikethrough,
  AlignLeft, AlignCenter, AlignRight, AlignJustify,
  List, ListOrdered, Quote, Code, Code2,
  Link as LinkIcon, Image as ImageIcon,
  Table as TableIcon, Undo, Redo,
  Highlighter, Heading1, Heading2, Heading3,
  Minus, ChevronDown, Sparkles, Loader2,
  Wand2, ArrowDownWideNarrow, ArrowUpWideNarrow, Smile, Briefcase, SpellCheck,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { trpc } from "@/lib/trpc";
import { isHtmlBody, plainTextToHtml } from "@shared/emailBody";
import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

interface RichTextEditorProps {
  value?: string;
  onChange?: (html: string) => void;
  placeholder?: string;
  minHeight?: string;
  maxHeight?: string;
  disabled?: boolean;
  showCount?: boolean;
  compact?: boolean;
  className?: string;
  /** Render the AI assistant button (default true). */
  ai?: boolean;
  /** Optional context passed to the assistant. */
  aiContext?: { subject?: string; recipientName?: string; recipientCompany?: string };
}

// ── Toolbar button ──────────────────────────────────────────────────────────
function ToolBtn({
  onClick, active, disabled, title, children,
}: {
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onMouseDown={(e) => { e.preventDefault(); onClick(); }}
      disabled={disabled}
      title={title}
      className={cn(
        "p-1.5 rounded text-sm transition-colors",
        active
          ? "bg-primary/15 text-primary"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
        disabled && "opacity-40 cursor-not-allowed",
      )}
    >
      {children}
    </button>
  );
}

// ── Divider ─────────────────────────────────────────────────────────────────
function Divider() {
  return <div className="w-px h-5 bg-border mx-0.5 self-center" />;
}

/* ── "/" block menu (Gutenberg-style) ────────────────────────────────────────
 * Typing "/" opens an inserter listing the block types the toolbar offers.
 * Built on @tiptap/suggestion with a ReactRenderer positioned at the caret —
 * no tippy dependency, one absolutely-positioned element on document.body. */

interface SlashItem {
  title: string;
  hint: string;
  icon: React.ReactNode;
  run: (editor: Editor, range: TiptapRange) => void;
}

const SLASH_ITEMS: SlashItem[] = [
  { title: "Heading 1", hint: "Large section heading", icon: <Heading1 className="size-4" />, run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 1 }).run() },
  { title: "Heading 2", hint: "Medium section heading", icon: <Heading2 className="size-4" />, run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 2 }).run() },
  { title: "Heading 3", hint: "Small section heading", icon: <Heading3 className="size-4" />, run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 3 }).run() },
  { title: "Bullet list", hint: "Plain list with bullets", icon: <List className="size-4" />, run: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run() },
  { title: "Numbered list", hint: "Ordered list", icon: <ListOrdered className="size-4" />, run: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run() },
  { title: "Quote", hint: "Pull quote block", icon: <Quote className="size-4" />, run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run() },
  { title: "Divider", hint: "Horizontal rule", icon: <Minus className="size-4" />, run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run() },
  { title: "Table", hint: "3×3 table", icon: <TableIcon className="size-4" />, run: (e, r) => e.chain().focus().deleteRange(r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  {
    title: "Image", hint: "Embed by URL", icon: <ImageIcon className="size-4" />,
    run: (e, r) => {
      const url = window.prompt("Image URL");
      e.chain().focus().deleteRange(r).run();
      if (url) e.chain().focus().setImage({ src: url }).run();
    },
  },
];

interface SlashListProps {
  items: SlashItem[];
  command: (item: SlashItem) => void;
}
interface SlashListHandle {
  onKeyDown: (event: KeyboardEvent) => boolean;
}

const SlashList = forwardRef<SlashListHandle, SlashListProps>(function SlashList({ items, command }, ref) {
  const [selected, setSelected] = useState(0);
  useEffect(() => setSelected(0), [items]);

  useImperativeHandle(ref, () => ({
    onKeyDown(event) {
      if (event.key === "ArrowDown") { setSelected((s) => (s + 1) % Math.max(items.length, 1)); return true; }
      if (event.key === "ArrowUp") { setSelected((s) => (s - 1 + Math.max(items.length, 1)) % Math.max(items.length, 1)); return true; }
      if (event.key === "Enter") { if (items[selected]) command(items[selected]); return true; }
      return false;
    },
  }), [items, selected, command]);

  if (items.length === 0) {
    return <div className="px-3 py-2 text-xs text-muted-foreground">No matching block</div>;
  }
  return (
    <div className="py-1 max-h-72 overflow-y-auto">
      {items.map((item, i) => (
        <button
          key={item.title}
          type="button"
          onMouseDown={(e) => { e.preventDefault(); command(item); }}
          onMouseEnter={() => setSelected(i)}
          className={cn(
            "w-full flex items-center gap-2.5 px-3 py-1.5 text-left",
            i === selected ? "bg-muted" : "",
          )}
        >
          <span className="text-muted-foreground">{item.icon}</span>
          <span className="min-w-0">
            <span className="block text-xs font-medium text-foreground">{item.title}</span>
            <span className="block text-[10px] text-muted-foreground truncate">{item.hint}</span>
          </span>
        </button>
      ))}
    </div>
  );
});

/** Position the floating menu at the caret; flips above when near the fold. */
function placeSlashMenu(el: HTMLElement, clientRect: (() => DOMRect | null) | null | undefined) {
  const rect = clientRect?.();
  if (!rect) return;
  el.style.position = "absolute";
  el.style.zIndex = "9999";
  const menuH = Math.min(el.offsetHeight || 288, 288);
  const below = rect.bottom + menuH < window.innerHeight;
  el.style.left = `${rect.left + window.scrollX}px`;
  el.style.top = below
    ? `${rect.bottom + window.scrollY + 4}px`
    : `${rect.top + window.scrollY - menuH - 4}px`;
}

const SlashCommand = Extension.create({
  name: "slashCommand",
  addProseMirrorPlugins() {
    return [
      Suggestion<SlashItem>({
        editor: this.editor,
        char: "/",
        pluginKey: undefined as never, // default key — one instance per editor
        command: ({ editor, range, props }) => props.run(editor, range),
        items: ({ query }) =>
          SLASH_ITEMS.filter((i) => i.title.toLowerCase().includes(query.toLowerCase())),
        render: () => {
          let component: ReactRenderer<SlashListHandle, SlashListProps> | null = null;
          return {
            onStart: (props) => {
              component = new ReactRenderer(SlashList, {
                props: { items: props.items, command: props.command },
                editor: props.editor,
              });
              const el = component.element as HTMLElement;
              el.className = "rounded-md border bg-popover text-popover-foreground shadow-md w-56";
              document.body.appendChild(el);
              placeSlashMenu(el, props.clientRect);
            },
            onUpdate: (props) => {
              component?.updateProps({ items: props.items, command: props.command });
              if (component) placeSlashMenu(component.element as HTMLElement, props.clientRect);
            },
            onKeyDown: (props) => {
              if (props.event.key === "Escape") return true; // suggestion closes itself
              return component?.ref?.onKeyDown(props.event) ?? false;
            },
            onExit: () => {
              (component?.element as HTMLElement | undefined)?.remove();
              component?.destroy();
              component = null;
            },
          };
        },
      }),
    ];
  },
});

/* ── AI assistant ────────────────────────────────────────────────────────────
 * One popover, two modes:
 *  - quick transforms applied to the SELECTION when one exists, else the
 *    whole body (selection ops run as plain text; whole-body ops as HTML);
 *  - a free instruction box that composes (empty body) or transforms.
 * The server side is emailAssist.assist — shared by every editor mount. */

const AI_QUICK_ACTIONS = [
  { action: "improve", label: "Improve", icon: <Wand2 className="size-3.5" /> },
  { action: "shorten", label: "Shorten", icon: <ArrowDownWideNarrow className="size-3.5" /> },
  { action: "expand", label: "Expand", icon: <ArrowUpWideNarrow className="size-3.5" /> },
  { action: "friendly", label: "Friendlier", icon: <Smile className="size-3.5" /> },
  { action: "formal", label: "More formal", icon: <Briefcase className="size-3.5" /> },
  { action: "proofread", label: "Proofread", icon: <SpellCheck className="size-3.5" /> },
] as const;

function AiAssistButton({
  editor,
  aiContext,
}: {
  editor: Editor;
  aiContext?: RichTextEditorProps["aiContext"];
}) {
  const [open, setOpen] = useState(false);
  const [instruction, setInstruction] = useState("");
  const assist = trpc.emailAssist.assist.useMutation({
    onError: (e) => toast.error(e.message || "The assistant failed — try again."),
  });

  const apply = (action: string, instr?: string) => {
    const { from, to, empty } = editor.state.selection;
    const hasSelection = !empty && to > from;
    const docEmpty = editor.getText().trim().length === 0;

    // Selection ops travel as plain text (a fragment's HTML context is
    // ambiguous); whole-body ops travel as the HTML the editor really holds.
    const payload = hasSelection
      ? { text: editor.state.doc.textBetween(from, to, "\n"), isHtml: false }
      : { text: docEmpty ? "" : editor.getHTML(), isHtml: true };

    const finalAction = action === "generate" ? (docEmpty ? "write" : "custom") : action;
    if ((finalAction === "write" || finalAction === "custom") && !instr?.trim()) {
      toast.error("Tell the assistant what to do first.");
      return;
    }

    assist.mutate(
      {
        action: finalAction as never,
        instruction: instr?.trim() || undefined,
        ...payload,
        ...aiContext,
      },
      {
        onSuccess: (res) => {
          if (res.error) { toast.error(res.error); return; }
          if (hasSelection) {
            editor.chain().focus().insertContentAt({ from, to }, res.text).run();
          } else {
            editor.chain().focus().setContent(res.text, { emitUpdate: true } as never).run();
          }
          setOpen(false);
          setInstruction("");
        },
      },
    );
  };

  const busy = assist.isPending;
  const hasSelection = !editor.state.selection.empty;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="AI assistant"
          className={cn(
            "flex items-center gap-1 px-1.5 py-1 rounded text-xs font-medium transition-colors",
            open ? "bg-primary/15 text-primary" : "text-primary/80 hover:bg-primary/10 hover:text-primary",
          )}
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
          AI
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-2 space-y-2">
        <div className="text-[11px] text-muted-foreground px-1">
          {hasSelection ? "Acting on your selection" : "Acting on the whole email"}
        </div>
        <div className="grid grid-cols-2 gap-1">
          {AI_QUICK_ACTIONS.map((a) => (
            <button
              key={a.action}
              type="button"
              disabled={busy}
              onClick={() => apply(a.action)}
              className="flex items-center gap-1.5 px-2 py-1.5 rounded-md border text-xs text-foreground hover:bg-muted disabled:opacity-50 text-left"
            >
              {a.icon}
              {a.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5 pt-1 border-t">
          <input
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !busy) apply("generate", instruction); }}
            placeholder="Write a follow-up about…"
            className="flex-1 h-8 px-2 rounded-md border bg-background text-xs outline-none focus:ring-1 focus:ring-primary/40"
            disabled={busy}
          />
          <button
            type="button"
            disabled={busy || !instruction.trim()}
            onClick={() => apply("generate", instruction)}
            className="h-8 px-2.5 rounded-md bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50"
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : "Go"}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ── Main component ───────────────────────────────────────────────────────────
export function RichTextEditor({
  value = "",
  onChange,
  placeholder = "Start typing…",
  minHeight = "200px",
  maxHeight = "600px",
  disabled = false,
  showCount = false,
  compact = false,
  className,
  ai = true,
  aiContext,
}: RichTextEditorProps) {
  // Legacy plain-text values (old textareas, AI generators) would have their
  // newlines collapsed by Tiptap's HTML parser — convert them once on the way
  // in. After the first edit the value is HTML and this is a no-op.
  const normalizedValue = value && !isHtmlBody(value) ? plainTextToHtml(value) : value;
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        codeBlock: { languageClassPrefix: "language-" },
      }),
      Underline,
      TextStyle,
      Color,
      Highlight.configure({ multicolor: true }),
      Link.configure({ openOnClick: false, autolink: true }),
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      Image,
      CharacterCount,
      Placeholder.configure({ placeholder }),
      SlashCommand,
    ],
    content: normalizedValue,
    editable: !disabled,
    onUpdate: ({ editor }) => {
      onChange?.(editor.getHTML());
    },
  });

  // Sync external value changes (e.g. AI-generated content)
  useEffect(() => {
    if (!editor) return;
    const current = editor.getHTML();
    if (normalizedValue !== current && value !== current) {
      // TipTap v3 changed setContent's 2nd arg from boolean to options object.
      editor.commands.setContent(normalizedValue ?? "", { emitUpdate: false });
    }
  }, [normalizedValue, value, editor]);

  const setLink = useCallback(() => {
    if (!editor) return;
    const prev = editor.getAttributes("link").href as string | undefined;
    const url = window.prompt("URL", prev ?? "https://");
    if (url === null) return;
    if (url === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
    } else {
      editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
    }
  }, [editor]);

  const insertImage = useCallback(() => {
    if (!editor) return;
    const url = window.prompt("Image URL");
    if (url) editor.chain().focus().setImage({ src: url }).run();
  }, [editor]);

  const insertTable = useCallback(() => {
    if (!editor) return;
    editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
  }, [editor]);

  if (!editor) return null;

  const charCount = editor.storage.characterCount?.characters?.() ?? 0;

  return (
    <div
      className={cn(
        "border rounded-md bg-background flex flex-col overflow-hidden",
        disabled && "opacity-60 pointer-events-none",
        className,
      )}
    >
      {/* ── Toolbar ── */}
      <div className="flex flex-wrap items-center gap-0.5 px-2 py-1.5 border-b bg-muted/30">
        {/* AI assistant — first, it's the headline capability */}
        {ai && !disabled && (
          <>
            <AiAssistButton editor={editor} aiContext={aiContext} />
            <Divider />
          </>
        )}
        {/* Undo / Redo */}
        <ToolBtn onClick={() => editor.chain().focus().undo().run()} title="Undo" disabled={!editor.can().undo()}>
          <Undo className="size-3.5" />
        </ToolBtn>
        <ToolBtn onClick={() => editor.chain().focus().redo().run()} title="Redo" disabled={!editor.can().redo()}>
          <Redo className="size-3.5" />
        </ToolBtn>

        <Divider />

        {/* Headings (hidden in compact mode) */}
        {!compact && (
          <>
            <ToolBtn onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} active={editor.isActive("heading", { level: 1 })} title="Heading 1">
              <Heading1 className="size-3.5" />
            </ToolBtn>
            <ToolBtn onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} active={editor.isActive("heading", { level: 2 })} title="Heading 2">
              <Heading2 className="size-3.5" />
            </ToolBtn>
            <ToolBtn onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} active={editor.isActive("heading", { level: 3 })} title="Heading 3">
              <Heading3 className="size-3.5" />
            </ToolBtn>
            <Divider />
          </>
        )}

        {/* Inline marks */}
        <ToolBtn onClick={() => editor.chain().focus().toggleBold().run()} active={editor.isActive("bold")} title="Bold">
          <Bold className="size-3.5" />
        </ToolBtn>
        <ToolBtn onClick={() => editor.chain().focus().toggleItalic().run()} active={editor.isActive("italic")} title="Italic">
          <Italic className="size-3.5" />
        </ToolBtn>
        <ToolBtn onClick={() => editor.chain().focus().toggleUnderline().run()} active={editor.isActive("underline")} title="Underline">
          <UnderlineIcon className="size-3.5" />
        </ToolBtn>
        <ToolBtn onClick={() => editor.chain().focus().toggleStrike().run()} active={editor.isActive("strike")} title="Strikethrough">
          <Strikethrough className="size-3.5" />
        </ToolBtn>
        <ToolBtn onClick={() => editor.chain().focus().toggleHighlight().run()} active={editor.isActive("highlight")} title="Highlight">
          <Highlighter className="size-3.5" />
        </ToolBtn>
        <ToolBtn onClick={() => editor.chain().focus().toggleCode().run()} active={editor.isActive("code")} title="Inline code">
          <Code className="size-3.5" />
        </ToolBtn>

        <Divider />

        {/* Alignment */}
        <ToolBtn onClick={() => editor.chain().focus().setTextAlign("left").run()} active={editor.isActive({ textAlign: "left" })} title="Align left">
          <AlignLeft className="size-3.5" />
        </ToolBtn>
        <ToolBtn onClick={() => editor.chain().focus().setTextAlign("center").run()} active={editor.isActive({ textAlign: "center" })} title="Align center">
          <AlignCenter className="size-3.5" />
        </ToolBtn>
        <ToolBtn onClick={() => editor.chain().focus().setTextAlign("right").run()} active={editor.isActive({ textAlign: "right" })} title="Align right">
          <AlignRight className="size-3.5" />
        </ToolBtn>
        <ToolBtn onClick={() => editor.chain().focus().setTextAlign("justify").run()} active={editor.isActive({ textAlign: "justify" })} title="Justify">
          <AlignJustify className="size-3.5" />
        </ToolBtn>

        <Divider />

        {/* Lists */}
        <ToolBtn onClick={() => editor.chain().focus().toggleBulletList().run()} active={editor.isActive("bulletList")} title="Bullet list">
          <List className="size-3.5" />
        </ToolBtn>
        <ToolBtn onClick={() => editor.chain().focus().toggleOrderedList().run()} active={editor.isActive("orderedList")} title="Numbered list">
          <ListOrdered className="size-3.5" />
        </ToolBtn>
        <ToolBtn onClick={() => editor.chain().focus().toggleBlockquote().run()} active={editor.isActive("blockquote")} title="Blockquote">
          <Quote className="size-3.5" />
        </ToolBtn>
        {!compact && (
          <ToolBtn onClick={() => editor.chain().focus().toggleCodeBlock().run()} active={editor.isActive("codeBlock")} title="Code block">
            <Code2 className="size-3.5" />
          </ToolBtn>
        )}

        <Divider />

        {/* Link / Image / Table */}
        <ToolBtn onClick={setLink} active={editor.isActive("link")} title="Insert / edit link">
          <LinkIcon className="size-3.5" />
        </ToolBtn>
        {!compact && (
          <>
            <ToolBtn onClick={insertImage} title="Insert image">
              <ImageIcon className="size-3.5" />
            </ToolBtn>
            <ToolBtn onClick={insertTable} title="Insert table">
              <TableIcon className="size-3.5" />
            </ToolBtn>
          </>
        )}

        <Divider />

        {/* Horizontal rule */}
        <ToolBtn onClick={() => editor.chain().focus().setHorizontalRule().run()} title="Horizontal rule">
          <Minus className="size-3.5" />
        </ToolBtn>
      </div>

      {/* ── Editor area ── */}
      <EditorContent
        editor={editor}
        className="flex-1 overflow-y-auto px-4 py-3 prose prose-sm dark:prose-invert max-w-none focus:outline-none [&_.ProseMirror]:outline-none [&_.ProseMirror]:min-h-full [&_.ProseMirror_p.is-editor-empty:first-child::before]:text-muted-foreground [&_.ProseMirror_p.is-editor-empty:first-child::before]:content-[attr(data-placeholder)] [&_.ProseMirror_p.is-editor-empty:first-child::before]:float-left [&_.ProseMirror_p.is-editor-empty:first-child::before]:pointer-events-none [&_.ProseMirror_p.is-editor-empty:first-child::before]:h-0"
        style={{ minHeight, maxHeight }}
      />

      {/* ── Footer ── */}
      {showCount && (
        <div className="px-3 py-1 border-t bg-muted/20 text-xs text-muted-foreground text-right">
          {charCount.toLocaleString()} characters
        </div>
      )}
    </div>
  );
}

export default RichTextEditor;
