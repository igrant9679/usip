/**
 * MindmapCanvas — Interactive Mindmap Editor
 *
 * Built on @xyflow/react (already installed for SequenceCanvas).
 *
 * Node types:
 *   root     — central topic (one per map, large, bold)
 *   topic    — first-level branch
 *   subtopic — second-level branch
 *   task     — linked to a CRM Task record
 *   note     — linked to a CRM Activity/Note record
 *   idea     — free-form idea node
 *
 * Features:
 *   - Drag nodes freely
 *   - Double-click canvas to add a new topic node
 *   - Click a node to select it and open the side panel
 *   - Side panel: edit label, notes, color, and trigger CRM actions
 *   - "Create Task" button: opens a dialog, creates a real CRM task linked to the node
 *   - "Create Note" button: opens a dialog, creates a real CRM note linked to the node
 *   - Auto-save every 15 s + manual Save button
 *   - Toolbar: add node types, fit view, zoom controls
 */
import "@xyflow/react/dist/style.css";
import {
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  type EdgeChange,
  Handle,
  type Node,
  type NodeChange,
  type NodeProps,
  Panel,
  Position,
  ReactFlow,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  MiniMap,
} from "@xyflow/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { SaveTracker, confirmLeaveWhile } from "@/lib/saveTracker";
import {
  ArrowLeft,
  CheckSquare,
  FileText,
  GitFork,
  Lightbulb,
  Plus,
  Save,
  Tag,
  X,
  Loader2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "wouter";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { ResponsiveRail } from "@/components/usip/ResponsiveRail";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type NodeType = "root" | "topic" | "subtopic" | "task" | "note" | "idea";

interface MindmapNodeData extends Record<string, unknown> {
  label: string;
  notes?: string;
  color?: string;
  nodeType: NodeType;
  linkedEntityType?: string;
  linkedEntityId?: number;
  parentId?: string;
}

// ---------------------------------------------------------------------------
// Color palette per node type
// ---------------------------------------------------------------------------
const TYPE_COLORS: Record<NodeType, { bg: string; border: string; text: string }> = {
  root:     { bg: "#4F46E5", border: "#3730A3", text: "#FFFFFF" },
  topic:    { bg: "#7C3AED", border: "#5B21B6", text: "#FFFFFF" },
  subtopic: { bg: "#0F766E", border: "#0D6B63", text: "#FFFFFF" },
  task:     { bg: "#B45309", border: "#92400E", text: "#FFFFFF" },
  note:     { bg: "#1D4ED8", border: "#1E40AF", text: "#FFFFFF" },
  idea:     { bg: "#DB2777", border: "#BE185D", text: "#FFFFFF" },
};

const NODE_TYPE_LABELS: Record<NodeType, string> = {
  root: "Central Topic",
  topic: "Topic",
  subtopic: "Subtopic",
  task: "Task Node",
  note: "Note Node",
  idea: "Idea",
};

// ---------------------------------------------------------------------------
// Custom node renderer
// ---------------------------------------------------------------------------
function MindmapNode({ data, selected }: NodeProps) {
  const d = data as MindmapNodeData;
  const palette = TYPE_COLORS[d.nodeType] ?? TYPE_COLORS.topic;
  const isRoot = d.nodeType === "root";

  return (
    <div
      className={cn(
        "relative rounded-xl px-4 py-2 shadow-md cursor-pointer transition-all select-none",
        selected && "ring-2 ring-white ring-offset-2 ring-offset-transparent"
      )}
      style={{
        background: d.color ?? palette.bg,
        border: `2px solid ${palette.border}`,
        color: palette.text,
        minWidth: isRoot ? 160 : 120,
        maxWidth: 220,
        fontSize: isRoot ? 15 : 13,
        fontWeight: isRoot ? 700 : 500,
      }}
    >
      <Handle type="target" position={Position.Left} className="!bg-card/60 !border-white/40 !size-2" />
      <div className="flex items-center gap-1.5">
        {d.nodeType === "task" && <CheckSquare className="size-3 shrink-0" />}
        {d.nodeType === "note" && <FileText className="size-3 shrink-0" />}
        {d.nodeType === "idea" && <Lightbulb className="size-3 shrink-0" />}
        <span className="truncate">{d.label}</span>
      </div>
      {d.linkedEntityId && (
        <div className="mt-0.5 text-[10px] opacity-70 flex items-center gap-1">
          <Tag className="size-2.5" />
          {d.linkedEntityType === "task" ? "Task linked" : "Note linked"}
        </div>
      )}
      <Handle type="source" position={Position.Right} className="!bg-card/60 !border-white/40 !size-2" />
    </div>
  );
}

const nodeTypes = { mindmapNode: MindmapNode };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function uid() {
  return `n_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}
function edgeId(s: string, t: string) {
  return `e_${s}_${t}`;
}

function dbNodesToFlow(dbNodes: any[]): Node<MindmapNodeData>[] {
  return dbNodes.map((n) => ({
    id: n.id,
    type: "mindmapNode",
    position: { x: n.posX, y: n.posY },
    data: {
      label: n.label,
      notes: n.notes ?? "",
      color: n.color ?? undefined,
      nodeType: n.type as NodeType,
      linkedEntityType: n.linkedEntityType ?? undefined,
      linkedEntityId: n.linkedEntityId ?? undefined,
      parentId: n.parentId ?? undefined,
    },
  }));
}

function dbEdgesToFlow(dbEdges: any[]): Edge[] {
  return dbEdges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    label: e.label ?? undefined,
    type: "smoothstep",
    animated: false,
    style: { stroke: "#94A3B8", strokeWidth: 2 },
  }));
}

function canvasPayload(nodes: Node<MindmapNodeData>[], edges: Edge[]) {
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.data.nodeType,
      label: n.data.label,
      notes: n.data.notes,
      posX: Math.round(n.position.x),
      posY: Math.round(n.position.y),
      color: n.data.color,
      parentId: n.data.parentId,
      linkedEntityType: n.data.linkedEntityType,
      linkedEntityId: n.data.linkedEntityId,
    })),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      label: typeof e.label === "string" ? e.label : undefined,
    })),
  };
}

// ---------------------------------------------------------------------------
// Main canvas component
// ---------------------------------------------------------------------------
export default function MindmapCanvas() {
  const params = useParams<{ id: string }>();
  const mapId = Number(params.id);

  // Always re-read on open: a copy cached from before the last save would
  // otherwise load, and the next save would put it back over the newer one (G22).
  const canvasQuery = trpc.mindmaps.getCanvas.useQuery({ id: mapId }, { refetchOnMount: "always" });
  const { data: canvasData, isLoading } = canvasQuery;
  const utils = trpc.useUtils();
  const saveCanvasMut = trpc.mindmaps.saveCanvas.useMutation();
  const createTaskMut = trpc.mindmaps.createLinkedTask.useMutation();
  const createNoteMut = trpc.mindmaps.createLinkedNote.useMutation();

  const [nodes, setNodes] = useState<Node<MindmapNodeData>[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  // Edits are counted, not flagged, so one made during a save stays unsaved
  // (G60). `dirty` mirrors the tracker for rendering.
  const tracker = useRef(new SaveTracker()).current;
  const [dirty, setDirtyState] = useState(false);
  const markEdited = useCallback(() => { tracker.edit(); setDirtyState(true); }, [tracker]);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  /** The version the canvas on screen was built from; sent with each save (G22). */
  const versionRef = useRef<number | undefined>(undefined);
  /** Set when a save was refused because the map was saved elsewhere since. */
  const [conflict, setConflict] = useState(false);
  const latest = useRef({ nodes: [] as Node<MindmapNodeData>[], edges: [] as Edge[] });
  const [selectedNode, setSelectedNode] = useState<Node<MindmapNodeData> | null>(null);

  // Side panel edit state
  const [editLabel, setEditLabel] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editColor, setEditColor] = useState("");

  // Task creation dialog
  const [showTaskDialog, setShowTaskDialog] = useState(false);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDesc, setTaskDesc] = useState("");
  const [taskDue, setTaskDue] = useState("");
  const [taskPriority, setTaskPriority] = useState<"low" | "normal" | "high" | "urgent">("normal");

  // Note creation dialog
  const [showNoteDialog, setShowNoteDialog] = useState(false);
  const [noteBody, setNoteBody] = useState("");

  const autoSaveRef = useRef<ReturnType<typeof setInterval> | null>(null);

  latest.current = { nodes, edges };

  // Load canvas data. A refetch that lands while there are unsaved edits is not
  // applied over them; the next save carries the version they were built on.
  const applyCanvas = useCallback((data: NonNullable<typeof canvasData>) => {
    setNodes(dbNodesToFlow(data.nodes));
    setEdges(dbEdgesToFlow(data.edges));
    versionRef.current = data.version;
    tracker.reset();
    setDirtyState(false);
  }, [tracker]);
  useEffect(() => {
    if (!canvasData || tracker.dirty) return;
    applyCanvas(canvasData);
  }, [canvasData, applyCanvas, tracker]);

  // Auto-save every 15 s when dirty (not while a save is refused for a conflict)
  useEffect(() => {
    if (autoSaveRef.current) clearInterval(autoSaveRef.current);
    autoSaveRef.current = setInterval(() => {
      if (dirty && !conflict) doSave();
    }, 15_000);
    return () => { if (autoSaveRef.current) clearInterval(autoSaveRef.current); };
  }, [dirty, conflict, nodes, edges]);

  // Leaving with unsaved work: the browser asks on close/reload, and leaving the
  // page inside the app saves what is there (G60: nothing guarded either).
  useEffect(() => {
    const onBeforeUnload = confirmLeaveWhile(() => tracker.dirty);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [tracker]);
  useEffect(() => () => {
    if (!tracker.dirty) return;
    utils.client.mindmaps.saveCanvas
      .mutate({ id: mapId, baseVersion: versionRef.current, ...canvasPayload(latest.current.nodes, latest.current.edges) })
      .then(() => utils.mindmaps.getCanvas.invalidate({ id: mapId }))
      .catch((e: any) => toast.error(`Your last mind map changes were not saved: ${e?.message ?? "save failed"}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapId]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((nds) => applyNodeChanges(changes, nds) as Node<MindmapNodeData>[]);
    // Selecting a node or React Flow measuring one is not an edit.
    if (changes.some((c) => c.type !== "select" && c.type !== "dimensions")) markEdited();
  }, [markEdited]);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((eds) => applyEdgeChanges(changes, eds));
    if (changes.some((c) => c.type !== "select")) markEdited();
  }, [markEdited]);

  const onConnect = useCallback((params: any) => {
    setEdges((eds) =>
      addEdge({ ...params, id: edgeId(params.source, params.target), type: "smoothstep", style: { stroke: "#94A3B8", strokeWidth: 2 } }, eds)
    );
    markEdited();
  }, []);

  // Double-click on canvas background to add a topic node
  const onPaneDoubleClick = useCallback((event: React.MouseEvent) => {
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const x = event.clientX - bounds.left - 60;
    const y = event.clientY - bounds.top - 20;
    const id = uid();
    const newNode: Node<MindmapNodeData> = {
      id,
      type: "mindmapNode",
      position: { x, y },
      data: { label: "New Topic", nodeType: "topic" },
    };
    setNodes((nds) => [...nds, newNode]);
    markEdited();
  }, []);

  function addNode(type: NodeType) {
    const id = uid();
    const offset = nodes.length * 20;
    const newNode: Node<MindmapNodeData> = {
      id,
      type: "mindmapNode",
      position: { x: 300 + offset, y: 200 + offset },
      data: { label: NODE_TYPE_LABELS[type], nodeType: type },
    };
    setNodes((nds) => [...nds, newNode]);
    markEdited();
  }

  function onNodeClick(_: React.MouseEvent, node: Node<MindmapNodeData>) {
    setSelectedNode(node);
    setEditLabel(node.data.label);
    setEditNotes(node.data.notes ?? "");
    setEditColor(node.data.color ?? "");
  }

  function applyNodeEdits() {
    if (!selectedNode) return;
    setNodes((nds) =>
      nds.map((n) =>
        n.id === selectedNode.id
          ? { ...n, data: { ...n.data, label: editLabel, notes: editNotes, color: editColor || undefined } }
          : n
      )
    );
    setSelectedNode((prev) => prev ? { ...prev, data: { ...prev.data, label: editLabel, notes: editNotes, color: editColor || undefined } } : null);
    markEdited();
  }

  /** opts.overwrite: save over a newer copy saved elsewhere (the conflict banner's choice). */
  async function doSave(opts: { overwrite?: boolean } = {}) {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    const upTo = tracker.begin();
    try {
      const res = await saveCanvasMut.mutateAsync({
        id: mapId,
        baseVersion: opts.overwrite ? undefined : versionRef.current,
        ...canvasPayload(nodes, edges),
      });
      versionRef.current = res?.version;
      tracker.saved(upTo);
      setDirtyState(tracker.dirty);
      setConflict(false);
      // The cached copy is now older than the map; refresh it (G22).
      void utils.mindmaps.getCanvas.invalidate({ id: mapId });
      toast.success("Saved");
    } catch (e: any) {
      if (e?.data?.code === "CONFLICT") {
        setConflict(true);
        toast.error("This map was saved somewhere else after you opened it. Choose which version to keep.");
      } else {
        toast.error(`Save failed: ${e?.message ?? "unknown error"}`);
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  async function loadSavedVersion() {
    tracker.reset();
    setDirtyState(false);
    setConflict(false);
    const r = await canvasQuery.refetch();
    if (r.data) applyCanvas(r.data);
  }

  function handleCreateTask() {
    if (!selectedNode || !taskTitle.trim()) return;
    createTaskMut.mutate(
      {
        mindmapId: mapId,
        nodeId: selectedNode.id,
        title: taskTitle.trim(),
        description: taskDesc || undefined,
        dueAt: taskDue || undefined,
        priority: taskPriority,
      },
      {
        onSuccess: ({ taskId }) => {
          toast.success("Task created and linked to node");
          // Update node data locally
          setNodes((nds) =>
            nds.map((n) =>
              n.id === selectedNode.id
                ? { ...n, data: { ...n.data, linkedEntityType: "task", linkedEntityId: taskId, nodeType: "task" as NodeType } }
                : n
            )
          );
          setSelectedNode((prev) =>
            prev ? { ...prev, data: { ...prev.data, linkedEntityType: "task", linkedEntityId: taskId, nodeType: "task" as NodeType } } : null
          );
          setShowTaskDialog(false);
          setTaskTitle(""); setTaskDesc(""); setTaskDue(""); setTaskPriority("normal");
          markEdited();
        },
        onError: () => toast.error("Failed to create task"),
      }
    );
  }

  function handleCreateNote() {
    if (!selectedNode || !noteBody.trim()) return;
    createNoteMut.mutate(
      { mindmapId: mapId, nodeId: selectedNode.id, body: noteBody.trim() },
      {
        onSuccess: ({ activityId }) => {
          toast.success("Note created and linked to node");
          setNodes((nds) =>
            nds.map((n) =>
              n.id === selectedNode.id
                ? { ...n, data: { ...n.data, linkedEntityType: "note", linkedEntityId: activityId, nodeType: "note" as NodeType } }
                : n
            )
          );
          setSelectedNode((prev) =>
            prev ? { ...prev, data: { ...prev.data, linkedEntityType: "note", linkedEntityId: activityId, nodeType: "note" as NodeType } } : null
          );
          setShowNoteDialog(false);
          setNoteBody("");
          markEdited();
        },
        onError: () => toast.error("Failed to create note"),
      }
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="size-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const mapName = canvasData?.map?.name ?? "Mindmap";

  return (
    <div className="flex flex-col h-full">
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-2 border-b bg-background shrink-0 gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Link href="/mindmaps">
            <Button aria-label="Back" variant="ghost" size="icon" className="size-8">
              <ArrowLeft className="size-4" />
            </Button>
          </Link>
          <GitFork className="size-4 text-violet-500 shrink-0" />
          <span className="font-semibold text-sm truncate">{mapName}</span>
          {dirty && <span className="text-xs text-muted-foreground">(unsaved)</span>}
        </div>

        {/* Add node toolbar */}
        <div className="flex items-center gap-1 flex-wrap">
          {(["topic", "subtopic", "idea", "task", "note"] as NodeType[]).map((t) => (
            <Button
              key={t}
              variant="outline"
              size="sm"
              className="h-7 text-xs px-2"
              onClick={() => addNode(t)}
            >
              <Plus className="size-3 mr-1" />
              {NODE_TYPE_LABELS[t]}
            </Button>
          ))}
        </div>

        <Button size="sm" onClick={() => doSave()} disabled={saving || !dirty} className="shrink-0">
          {saving ? <Loader2 className="size-4 animate-spin mr-1" /> : <Save className="size-4 mr-1" />}
          Save
        </Button>
      </div>

      {conflict && (
        <div role="alert" className="flex flex-wrap items-center gap-2 px-4 py-2 border-b bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-100 text-sm">
          <span className="flex-1 min-w-0">This map was saved somewhere else after you opened it. Your changes here are not saved.</span>
          <Button size="sm" variant="outline" className="h-7" onClick={() => void loadSavedVersion()}>Load the saved version</Button>
          <Button size="sm" className="h-7" onClick={() => doSave({ overwrite: true })} disabled={saving}>Keep mine</Button>
        </div>
      )}

      {/* Canvas + side panel */}
      <div className="flex flex-1 overflow-hidden">
        {/* React Flow canvas */}
        <div className="flex-1 relative">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={onNodeClick}
            onPaneClick={() => setSelectedNode(null)}
            onDoubleClick={onPaneDoubleClick}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            deleteKeyCode="Delete"
            className="bg-muted/20"
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#CBD5E1" />
            <Controls />
            <MiniMap
              nodeColor={(n) => {
                const d = n.data as MindmapNodeData;
                return d.color ?? TYPE_COLORS[d.nodeType]?.bg ?? "#7C3AED";
              }}
              className="!bg-background !border !border-border"
            />
            <Panel position="bottom-center" className="text-xs text-muted-foreground pb-2">
              Double-click canvas to add a topic · Drag nodes to reposition · Connect nodes by dragging from a handle
            </Panel>
          </ReactFlow>
        </div>

        {/* Side panel */}
        {selectedNode && (
          <ResponsiveRail
            title="Node properties"
            side="right"
            open
            onOpenChange={(o) => { if (!o) setSelectedNode(null); }}
            ownHeader
            className="w-72 shrink-0 border-l bg-background flex-col overflow-y-auto"
            sheetClassName="overflow-y-auto"
          >
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <span className="font-semibold text-sm">Node Properties</span>
              <Button aria-label="Close" variant="ghost" size="icon" className="size-7" onClick={() => setSelectedNode(null)}>
                <X className="size-4" />
              </Button>
            </div>

            <div className="p-4 flex flex-col gap-4">
              {/* Type badge */}
              <div
                className="text-xs font-medium px-2 py-0.5 rounded-full w-fit text-white"
                style={{ background: TYPE_COLORS[selectedNode.data.nodeType]?.bg }}
              >
                {NODE_TYPE_LABELS[selectedNode.data.nodeType]}
              </div>

              {/* Label */}
              <div className="space-y-1">
                <Label className="text-xs">Label</Label>
                <Input aria-label="Label"
                  value={editLabel}
                  onChange={(e) => setEditLabel(e.target.value)}
                  onBlur={applyNodeEdits}
                  className="h-8 text-sm"
                />
              </div>

              {/* Notes */}
              <div className="space-y-1">
                <Label className="text-xs">Notes</Label>
                <Textarea aria-label="Notes"
                  value={editNotes}
                  onChange={(e) => setEditNotes(e.target.value)}
                  onBlur={applyNodeEdits}
                  rows={3}
                  className="text-sm resize-none"
                  placeholder="Add notes…"
                />
              </div>

              {/* Color override */}
              <div className="space-y-1">
                <Label className="text-xs">Custom Color</Label>
                <div className="flex items-center gap-2">
                  <input aria-label="Custom Color"
                    type="color"
                    value={editColor || TYPE_COLORS[selectedNode.data.nodeType]?.bg}
                    onChange={(e) => { setEditColor(e.target.value); }}
                    onBlur={applyNodeEdits}
                    className="w-8 h-8 rounded cursor-pointer border"
                  />
                  {editColor && (
                    <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => { setEditColor(""); applyNodeEdits(); }}>
                      Reset
                    </Button>
                  )}
                </div>
              </div>

              {/* CRM link status */}
              {selectedNode.data.linkedEntityId && (
                <div className="rounded-lg border bg-muted/40 p-3 text-xs">
                  <p className="font-medium mb-0.5">Linked CRM Record</p>
                  <p className="text-muted-foreground capitalize">
                    {selectedNode.data.linkedEntityType} #{selectedNode.data.linkedEntityId}
                  </p>
                </div>
              )}

              {/* CRM Action buttons */}
              <div className="border-t pt-4 space-y-2">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">CRM Actions</p>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full justify-start text-xs"
                  onClick={() => { setTaskTitle(selectedNode.data.label); setShowTaskDialog(true); }}
                >
                  <CheckSquare className="size-3.5 mr-2 text-amber-600" />
                  Create Task from Node
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full justify-start text-xs"
                  onClick={() => { setNoteBody(selectedNode.data.notes ?? ""); setShowNoteDialog(true); }}
                >
                  <FileText className="size-3.5 mr-2 text-blue-600" />
                  Create Note from Node
                </Button>
              </div>
            </div>
          </ResponsiveRail>
        )}
      </div>

      {/* Create Task Dialog */}
      <Dialog open={showTaskDialog} onOpenChange={setShowTaskDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckSquare className="size-4 text-amber-600" /> Create Task
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs">Title *</Label>
              <Input aria-label="Title" value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} placeholder="Task title…" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Description</Label>
              <Textarea aria-label="Description" value={taskDesc} onChange={(e) => setTaskDesc(e.target.value)} rows={2} placeholder="Optional description…" className="resize-none" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Due Date</Label>
                <Input aria-label="Due Date" type="date" value={taskDue} onChange={(e) => setTaskDue(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Priority</Label>
                <Select value={taskPriority} onValueChange={(v) => setTaskPriority(v as any)}>
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="normal">Normal</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                    <SelectItem value="urgent">Urgent</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowTaskDialog(false)}>Cancel</Button>
            <Button onClick={handleCreateTask} disabled={!taskTitle.trim() || createTaskMut.isPending}>
              {createTaskMut.isPending ? "Creating…" : "Create Task"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create Note Dialog */}
      <Dialog open={showNoteDialog} onOpenChange={setShowNoteDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileText className="size-4 text-blue-600" /> Create Note
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-1">
            <Label className="text-xs">Note Content *</Label>
            <Textarea aria-label="Note Content"
              value={noteBody}
              onChange={(e) => setNoteBody(e.target.value)}
              rows={5}
              placeholder="Write your note…"
              className="resize-none"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowNoteDialog(false)}>Cancel</Button>
            <Button onClick={handleCreateNote} disabled={!noteBody.trim() || createNoteMut.isPending}>
              {createNoteMut.isPending ? "Creating…" : "Create Note"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
