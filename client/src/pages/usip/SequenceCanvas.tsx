/**
 * Visual Canvas Sequence Builder
 * Uses React Flow (@xyflow/react) to provide a drag-and-drop canvas for
 * building multi-step, branching email sequences.
 *
 * Node types: start | email | wait | condition | action | goal
 * Features:
 *   - Click any node to open NodeEditPanel (inline edit all fields)
 *   - Email nodes: three-tab mode selector (Typed / Template / AI-dynamic)
 *   - Settings button opens SequenceSettingsPanel (name, exit conditions, send window)
 *   - Palette sidebar, undo/redo (50 steps), 30-s autosave, lifecycle guard
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
} from "@xyflow/react";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Clock,
  GitBranch,
  Mail,
  Play,
  Save,
  Settings2,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "wouter";
import { toast } from "sonner";
import { NodeEditPanel, type NodeData } from "@/components/usip/canvas/NodeEditPanel";
import {
  SequenceSettingsPanel,
  type ExitCondition,
  type SequenceSettings,
} from "@/components/usip/canvas/SequenceSettingsPanel";

/* ─── Node type colours ─────────────────────────────────────────────────── */
const NODE_COLORS: Record<string, string> = {
  start: "#14B89A",
  email: "#3B82F6",
  wait: "#F59E0B",
  condition: "#8B5CF6",
  action: "#EC4899",
  goal: "#10B981",
};

const NODE_ICONS: Record<string, React.FC<any>> = {
  start: Play,
  email: Mail,
  wait: Clock,
  condition: GitBranch,
  action: Zap,
  goal: CheckCircle2,
};

/* ─── Custom node component ─────────────────────────────────────────────── */
function CanvasNode({ data, type, selected }: NodeProps) {
  const color = NODE_COLORS[type ?? "email"] ?? "#6B7280";
  const Icon = NODE_ICONS[type ?? "email"] ?? Mail;
  const isCondition = type === "condition";
  const isStart = type === "start";

  // Show email mode badge on email nodes
  const emailMode = (data as NodeData).emailMode;
  const emailModeBadge: Record<string, { label: string; color: string }> = {
    dynamic: { label: "AI", color: "#3B82F6" },
    template: { label: "TPL", color: "#8B5CF6" },
    typed: { label: "TXT", color: "#6B7280" },
  };
  const modeBadge = type === "email" && emailMode ? emailModeBadge[emailMode] : null;

  return (
    <div
      className="rounded-lg border-2 bg-card shadow-md min-w-[160px] max-w-[220px] cursor-pointer transition-shadow"
      style={{
        borderColor: selected ? color : color + "88",
        boxShadow: selected ? `0 0 0 2px ${color}44` : undefined,
      }}
    >
      {/* Top handle (all except start) */}
      {!isStart && (
        <Handle type="target" position={Position.Top} className="!bg-muted-foreground" />
      )}

      <div className="flex items-center gap-2 px-3 py-2 rounded-t-md" style={{ backgroundColor: color + "22" }}>
        <Icon className="size-4 shrink-0" style={{ color }} />
        <span className="text-xs font-semibold uppercase tracking-wide" style={{ color }}>
          {type}
        </span>
        {modeBadge && (
          <span
            className="ml-auto text-[9px] font-bold px-1.5 py-0.5 rounded"
            style={{ backgroundColor: modeBadge.color + "22", color: modeBadge.color }}
          >
            {modeBadge.label}
          </span>
        )}
      </div>

      <div className="px-3 py-2 text-xs text-foreground">
        {data.label ? (
          <span className="font-medium">{String(data.label)}</span>
        ) : (
          <span className="text-muted-foreground italic">Click to configure…</span>
        )}
        {Boolean(data.description) && (
          <div className="text-muted-foreground mt-0.5 truncate">{String(data.description as string)}</div>
        )}
      </div>

      {/* Bottom handle (all except condition + goal) */}
      {!isCondition && type !== "goal" && (
        <Handle type="source" position={Position.Bottom} className="!bg-muted-foreground" />
      )}

      {/* Condition: TRUE / FALSE handles */}
      {isCondition && (
        <>
          <Handle
            type="source"
            position={Position.Bottom}
            id="true"
            style={{ left: "30%", backgroundColor: "#10B981" }}
          />
          <Handle
            type="source"
            position={Position.Bottom}
            id="false"
            style={{ left: "70%", backgroundColor: "#EF4444" }}
          />
          <div className="flex justify-between px-3 pb-2 text-[10px] text-muted-foreground">
            <span style={{ color: "#10B981" }}>TRUE</span>
            <span style={{ color: "#EF4444" }}>FALSE</span>
          </div>
        </>
      )}
    </div>
  );
}

const nodeTypes = {
  start: CanvasNode,
  email: CanvasNode,
  wait: CanvasNode,
  condition: CanvasNode,
  action: CanvasNode,
  goal: CanvasNode,
};

/* ─── Palette entry ─────────────────────────────────────────────────────── */
const PALETTE_ITEMS = [
  { type: "email", label: "Email step", description: "Send an email to the prospect" },
  { type: "wait", label: "Wait", description: "Delay before next step" },
  { type: "condition", label: "Condition", description: "Branch on engagement signal" },
  { type: "action", label: "Action", description: "Update status, assign, tag, task" },
  { type: "goal", label: "Goal", description: "Exit condition / conversion event" },
] as const;

/* ─── Undo/redo stack ───────────────────────────────────────────────────── */
type HistoryEntry = { nodes: Node[]; edges: Edge[] };

function useHistory(initial: HistoryEntry) {
  const [stack, setStack] = useState<HistoryEntry[]>([initial]);
  const [cursor, setCursor] = useState(0);

  const push = useCallback((entry: HistoryEntry) => {
    setStack((s) => {
      const next = s.slice(0, cursor + 1);
      next.push(entry);
      if (next.length > 50) next.shift();
      return next;
    });
    setCursor((c) => Math.min(c + 1, 49));
  }, [cursor]);

  const undo = useCallback(() => {
    setCursor((c) => Math.max(c - 1, 0));
    return stack[Math.max(cursor - 1, 0)];
  }, [stack, cursor]);

  const redo = useCallback(() => {
    setCursor((c) => Math.min(c + 1, stack.length - 1));
    return stack[Math.min(cursor + 1, stack.length - 1)];
  }, [stack, cursor]);

  return { push, undo, redo, canUndo: cursor > 0, canRedo: cursor < stack.length - 1, current: stack[cursor] };
}

/* ─── Main canvas component ─────────────────────────────────────────────── */
function CanvasInner({
  sequenceId,
  seqStatus,
  seqName,
  seqDescription,
  seqExitConditions,
  seqSettings,
}: {
  sequenceId: number;
  seqStatus: string;
  seqName: string;
  seqDescription?: string | null;
  seqExitConditions: ExitCondition[];
  seqSettings: SequenceSettings;
}) {
  const readOnly = seqStatus === "active" || seqStatus === "paused";
  const { fitView } = useReactFlow();

  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [saveState, setSaveState] = useState<"saved" | "unsaved" | "saving">("saved");
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const history = useHistory({ nodes: [], edges: [] });

  // Panel state
  const [selectedNode, setSelectedNode] = useState<Node<NodeData> | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const utils = trpc.useUtils();
  const canvasQ = trpc.sequences.getCanvas.useQuery({ id: sequenceId });
  const saveCanvas = trpc.sequences.saveCanvas.useMutation({
    onSuccess: () => setSaveState("saved"),
    onError: (e) => { setSaveState("unsaved"); toast.error(e.message); },
  });
  const updateSequence = trpc.sequences.update.useMutation({
    onSuccess: () => {
      utils.sequences.get.invalidate({ id: sequenceId });
      toast.success("Sequence settings saved");
    },
    onError: (e) => toast.error(e.message),
  });

  // Hydrate from server
  useEffect(() => {
    if (!canvasQ.data) return;
    const rfNodes: Node[] = canvasQ.data.nodes.map((n: any) => ({
      id: n.id,
      type: n.type,
      position: { x: n.positionX, y: n.positionY },
      data: (n.data as Record<string, unknown> | null) ?? {},
    }));
    const rfEdges: Edge[] = canvasQ.data.edges.map((e: any) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle ?? undefined,
      label: e.label ?? undefined,
    }));

    // Seed a Start node if canvas is empty
    if (rfNodes.length === 0) {
      rfNodes.push({
        id: "start-1",
        type: "start",
        position: { x: 250, y: 50 },
        data: { label: "Sequence start" },
      });
    }
    setNodes(rfNodes);
    setEdges(rfEdges);
    setTimeout(() => fitView({ padding: 0.2 }), 100);
  }, [canvasQ.data]);

  const triggerAutosave = useCallback((n: Node[], e: Edge[]) => {
    if (readOnly) return;
    setSaveState("unsaved");
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => {
      setSaveState("saving");
      saveCanvas.mutate({
        id: sequenceId,
        nodes: n.map((nd) => ({
          id: nd.id,
          type: nd.type as any,
          positionX: Math.round(nd.position.x),
          positionY: Math.round(nd.position.y),
          data: nd.data as Record<string, any>,
        })),
        edges: e.map((ed) => ({
          id: ed.id,
          source: ed.source,
          target: ed.target,
          sourceHandle: ed.sourceHandle ?? null,
          label: typeof ed.label === "string" ? ed.label : null,
        })),
      });
    }, 30_000);
  }, [readOnly, sequenceId, saveCanvas]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((nds) => {
      const next = applyNodeChanges(changes, nds);
      triggerAutosave(next, edges);
      return next;
    });
  }, [edges, triggerAutosave]);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((eds) => {
      const next = applyEdgeChanges(changes, eds);
      triggerAutosave(nodes, next);
      return next;
    });
  }, [nodes, triggerAutosave]);

  const onConnect = useCallback((params: any) => {
    if (readOnly) return;
    setEdges((eds) => {
      const next = addEdge({ ...params, animated: true }, eds);
      triggerAutosave(nodes, next);
      return next;
    });
  }, [readOnly, nodes, triggerAutosave]);

  // Node click → open edit panel
  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSettingsOpen(false);
    setSelectedNode(node as Node<NodeData>);
  }, []);

  // Close panel when clicking canvas background
  const onPaneClick = useCallback(() => {
    setSelectedNode(null);
  }, []);

  // Apply node data changes from the edit panel
  const handleNodeSave = useCallback((nodeId: string, data: NodeData) => {
    setNodes((nds) => {
      const next = nds.map((n) => n.id === nodeId ? { ...n, data } : n);
      triggerAutosave(next, edges);
      return next;
    });
    toast.success("Step updated");
  }, [edges, triggerAutosave]);

  const handleSaveNow = () => {
    if (readOnly) return;
    setSaveState("saving");
    saveCanvas.mutate({
      id: sequenceId,
      nodes: nodes.map((nd) => ({
        id: nd.id,
        type: nd.type as any,
        positionX: Math.round(nd.position.x),
        positionY: Math.round(nd.position.y),
        data: nd.data as Record<string, any>,
      })),
      edges: edges.map((ed) => ({
        id: ed.id,
        source: ed.source,
        target: ed.target,
        sourceHandle: ed.sourceHandle ?? null,
        label: typeof ed.label === "string" ? ed.label : null,
      })),
    });
  };

  const addNodeFromPalette = (type: string, label: string, description: string) => {
    if (readOnly) return;
    const id = `${type}-${Date.now()}`;
    const defaultData: NodeData = {
      label,
      description,
      ...(type === "email" ? { emailMode: "typed" } : {}),
      ...(type === "wait" ? { delayDays: 1, delayHours: 0 } : {}),
      ...(type === "condition" ? { branchOn: "email_opened", branchTrueLabel: "Yes", branchFalseLabel: "No" } : {}),
    };
    const newNode: Node = {
      id,
      type,
      position: { x: 200 + Math.random() * 100, y: 200 + Math.random() * 100 },
      data: defaultData,
    };
    setNodes((nds) => {
      const next = [...nds, newNode];
      triggerAutosave(next, edges);
      return next;
    });
    // Immediately open the edit panel for the new node
    setSelectedNode(newNode as Node<NodeData>);
    setSettingsOpen(false);
  };

  const handleSettingsSave = (patch: {
    name: string;
    description: string;
    exitConditions: ExitCondition[];
    settings: SequenceSettings;
  }) => {
    updateSequence.mutate({
      id: sequenceId,
      patch: {
        name: patch.name,
        description: patch.description,
        exitConditions: patch.exitConditions,
        settings: patch.settings,
      },
    });
  };

  const anyPanelOpen = selectedNode !== null || settingsOpen;

  return (
    <div className="flex h-full">
      {/* Palette sidebar */}
      <div className="w-52 shrink-0 border-r bg-card flex flex-col gap-1 p-3 overflow-y-auto">
        <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Node palette</div>
        {PALETTE_ITEMS.map((item) => {
          const color = NODE_COLORS[item.type];
          const Icon = NODE_ICONS[item.type];
          return (
            <button
              key={item.type}
              disabled={readOnly}
              onClick={() => addNodeFromPalette(item.type, item.label, item.description)}
              className="flex items-start gap-2 rounded-md border p-2 text-left text-sm hover:bg-secondary transition disabled:opacity-40"
              style={{ borderColor: color + "66" }}
            >
              <Icon className="size-4 mt-0.5 shrink-0" style={{ color }} />
              <div>
                <div className="font-medium text-xs">{item.label}</div>
                <div className="text-[10px] text-muted-foreground">{item.description}</div>
              </div>
            </button>
          );
        })}

        {readOnly && (
          <div className="mt-4 rounded-md bg-amber-50 border border-amber-200 p-2 text-xs text-amber-800 flex items-start gap-1.5">
            <AlertTriangle className="size-3.5 shrink-0 mt-0.5" />
            Canvas is read-only while sequence is {seqStatus}.
          </div>
        )}

        <div className="mt-auto pt-4">
          <Button
            size="sm"
            variant="outline"
            className="w-full gap-1.5 text-xs"
            onClick={() => { setSettingsOpen(true); setSelectedNode(null); }}
          >
            <Settings2 className="size-3.5" /> Sequence settings
          </Button>
        </div>
      </div>

      {/* Canvas area — shrinks when a panel is open */}
      <div className={`flex-1 relative overflow-hidden transition-all ${anyPanelOpen ? "mr-80" : ""}`}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={readOnly ? undefined : onNodesChange}
          onEdgesChange={readOnly ? undefined : onEdgesChange}
          onConnect={readOnly ? undefined : onConnect}
          onNodeClick={onNodeClick}
          onPaneClick={onPaneClick}
          nodeTypes={nodeTypes}
          fitView
          minZoom={0.25}
          maxZoom={2}
          deleteKeyCode={readOnly ? null : "Backspace"}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
          <Controls />
          <Panel position="top-right" className="flex items-center gap-2">
            <span className={`text-xs px-2 py-1 rounded-full ${saveState === "saved" ? "bg-green-100 text-green-700" : saveState === "saving" ? "bg-yellow-100 text-yellow-700" : "bg-muted text-muted-foreground"}`}>
              {saveState === "saved" ? "Saved" : saveState === "saving" ? "Saving…" : "Unsaved changes"}
            </span>
            {!readOnly && (
              <Button size="sm" onClick={handleSaveNow} disabled={saveCanvas.isPending}>
                <Save className="size-4" /> Save now
              </Button>
            )}
          </Panel>
        </ReactFlow>

        {/* Node edit panel — overlaid on right edge of canvas */}
        <NodeEditPanel
          node={selectedNode}
          readOnly={readOnly}
          onClose={() => setSelectedNode(null)}
          onSave={handleNodeSave}
        />

        {/* Sequence settings panel — overlaid on right edge of canvas */}
        <SequenceSettingsPanel
          open={settingsOpen}
          readOnly={readOnly}
          name={seqName}
          description={seqDescription}
          exitConditions={seqExitConditions}
          settings={seqSettings}
          onClose={() => setSettingsOpen(false)}
          onSave={handleSettingsSave}
        />
      </div>
    </div>
  );
}

/* ─── Page wrapper ──────────────────────────────────────────────────────── */
import { ReactFlowProvider } from "@xyflow/react";

export default function SequenceCanvas() {
  const params = useParams<{ id: string }>();
  const sequenceId = Number(params.id);

  const seqQ = trpc.sequences.get.useQuery({ id: sequenceId });
  const utils = trpc.useUtils();
  const setStatus = trpc.sequences.setStatus.useMutation({
    onSuccess: () => utils.sequences.get.invalidate(),
    onError: (e) => toast.error(e.message),
  });

  const seq = seqQ.data;

  const statusColor: Record<string, string> = {
    draft: "bg-muted text-muted-foreground",
    active: "bg-green-100 text-green-700",
    paused: "bg-yellow-100 text-yellow-700",
    archived: "bg-red-100 text-red-700",
  };

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2 border-b bg-card shrink-0">
        <Link href="/sequences" className="text-muted-foreground hover:text-foreground transition">
          <ArrowLeft className="size-4" />
        </Link>
        <div className="font-semibold text-sm truncate max-w-xs">{seq?.name ?? "Loading…"}</div>
        {seq && (
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusColor[seq.status] ?? ""}`}>
            {seq.status}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {seq?.status === "draft" && (
            <Button size="sm" variant="outline" onClick={() => setStatus.mutate({ id: sequenceId, status: "active" })}>
              <Play className="size-3.5" /> Activate
            </Button>
          )}
          {seq?.status === "active" && (
            <Button size="sm" variant="outline" onClick={() => setStatus.mutate({ id: sequenceId, status: "paused" })}>
              Pause
            </Button>
          )}
          {seq?.status === "paused" && (
            <Button size="sm" variant="outline" onClick={() => setStatus.mutate({ id: sequenceId, status: "active" })}>
              <Play className="size-3.5" /> Resume
            </Button>
          )}
          {(seq?.status === "draft" || seq?.status === "paused") && (
            <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setStatus.mutate({ id: sequenceId, status: "archived" })}>
              Archive
            </Button>
          )}
        </div>
      </div>

      {/* Canvas */}
      <div className="flex-1 overflow-hidden">
        {seqQ.isLoading ? (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">Loading canvas…</div>
        ) : !seq ? (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">Sequence not found.</div>
        ) : (
          <ReactFlowProvider>
            <CanvasInner
              sequenceId={sequenceId}
              seqStatus={seq.status}
              seqName={seq.name}
              seqDescription={seq.description}
              seqExitConditions={(seq.exitConditions as ExitCondition[] | null) ?? []}
              seqSettings={(seq.settings as SequenceSettings | null) ?? {}}
            />
          </ReactFlowProvider>
        )}
      </div>
    </div>
  );
}
