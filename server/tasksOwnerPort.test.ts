/**
 * Task ownership on /v2/tasks (ported 2026-10-29, Phase 5 consolidation).
 *
 * `tasks.ownerUserId` has always been a real column with real server
 * behaviour — `tasks.create` validates it with `assertOwnerInWorkspace`,
 * defaults it to the caller, and notifies the assignee when it is someone
 * else; `tasks.list` takes an `ownerOnly` filter. But the only UI that could
 * read or set it was the legacy `/tasks` page, which the nav does not point
 * at, while `/v2/tasks` — the one it does point at — had no owner UI at all.
 * So the column was writable by the API and the autopilot and editable by no
 * human. The consolidation evidence pass found this before any retirement was
 * attempted, which is why the port came first.
 *
 * Three things came across, and each is pinned here:
 *   1. the assignee picker on create,
 *   2. the owner on each queue row,
 *   3. the assignee filter.
 *
 * Plus the thing that must NOT have happened: `/tasks` is still routed and
 * `RelatedTasks` is still exported from it. Retiring that page is the owner's
 * decision and was explicitly not authorised with this port — a later reader
 * should not mistake "the port is done" for "the page can go".
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");

const v2 = read("client/src/pages/usip/TasksV2.tsx");
const v1 = read("client/src/pages/usip/Tasks.tsx");
const app = read("client/src/App.tsx");

describe("the assignee picker on create (/v2/tasks)", () => {
  it("reads the team and hands it to the dialog", () => {
    expect(v2).toContain("trpc.team.list.useQuery()");
    expect(v2).toContain("members={memberOpts}");
    expect(v2).toMatch(/function NewTaskDialog\(\{\n\s*open, onOpenChange, onCreate, pending, members,/);
  });

  it("sends ownerUserId only when one was chosen, never a guessed id", () => {
    // "" leaves it to the server, which defaults the owner to the caller.
    // Sending 0, or NaN from an empty string, would fail the server's
    // positive-int check or assign the task to nobody.
    expect(v2).toContain("ownerUserId: ownerUserId ? Number(ownerUserId) : undefined,");
    expect(v2).not.toContain("ownerUserId: Number(ownerUserId),");
    // The empty option is the server default, labelled as such.
    expect(v2).toContain('<option value="">Me</option>');
    expect(v2).toContain('<Label htmlFor="task-owner">Assignee</Label>');
    // Picking an assignee then reopening the dialog must not keep the last one.
    expect(v2).toContain('setOwnerUserId("");');
  });
});

describe("the owner on each queue row", () => {
  it("is on the row's type and is rendered when the task has one", () => {
    expect(v2).toContain("ownerUserId?: number | null;");
    // Guarded on != null, so a task with no owner shows nothing rather than a
    // blank chip, and ownerUserId 0 would still render (it cannot occur — the
    // server takes a positive int — but the guard must not be falsy-based).
    expect(v2).toContain("{t.ownerUserId != null && (");
    expect(v2).toMatch(/<User className="size-3" \/>\{memberName\(t\.ownerUserId\)\}/);
  });

  it("names a departed member by id rather than claiming nobody owns it", () => {
    // team.list returns current members only; a task owned by someone since
    // removed must not read as unowned.
    expect(v2).toMatch(/memberOpts\.find\(\(m\) => m\.userId === userId\)\?\.name \?\? `User \$\{userId\}`/);
  });
});

describe("the assignee filter", () => {
  it("scopes the queue and compares the same way the legacy page did", () => {
    expect(v2).toContain('const [assigneeFilter, setAssigneeFilter] = useState<string>("");');
    expect(v2).toContain('String(t.ownerUserId ?? "") === assigneeFilter');
    expect(v2).toContain('<option value="">Anyone</option>');
    expect(v2).toContain('<label htmlFor="queue-assignee"');
  });

  it("keeps the unfiltered list, so the header can say how much it is hiding", () => {
    // queueAll -> queue, not one list filtered in place: without the former
    // there is no honest denominator.
    expect(v2).toContain("const queueAll = useMemo(");
    expect(v2).toMatch(/const queue = useMemo\(\n\s*\(\) => \(assigneeFilter \? queueAll\.filter/);
    expect(v2).toMatch(/\{queue\.length\} of \{queueAll\.length\} in queue/);
  });

  it("does not let a filtered-empty queue claim the queue is clear", () => {
    // tasks.stats is computed on the server and counts the whole workspace, so
    // the filter must never be able to make the page say "clear" while rows
    // exist for someone else.
    const emptyForAssignee = v2.indexOf("queue.length === 0 && assigneeFilter");
    const clear = v2.indexOf("Your queue is clear");
    expect(emptyForAssignee, "the filtered-empty branch").toBeGreaterThan(-1);
    expect(clear, '"Your queue is clear"').toBeGreaterThan(-1);
    // The filtered branch has to be tested FIRST or it is unreachable.
    expect(emptyForAssignee).toBeLessThan(clear);
    expect(v2).toContain("Nothing assigned to ");
    expect(v2).toContain('<Button size="sm" variant="outline" onClick={() => setAssigneeFilter("")}>Show anyone</Button>');
  });
});

describe("/tasks is NOT retired by this port (owner's decision, not taken)", () => {
  it("the legacy page is still routed and still owns the embeddable block", () => {
    expect(app).toContain('<Route path="/tasks"><AuthGate><Tasks /></AuthGate></Route>');
    // RelatedTasks is embedded elsewhere (record drawers), so the file is not
    // only a page — another reason retiring the route is not a deletion.
    expect(v1).toContain("export function RelatedTasks(");
    const retired = read("client/src/lib/retiredRoutes.ts");
    const mapStart = retired.indexOf("export const RETIRED_ROUTES");
    const mapEnd = retired.indexOf("} as const;", mapStart);
    const keys = [...retired.slice(mapStart, mapEnd).matchAll(/"([^"]+)":/g)].map((m) => m[1]);
    expect(keys.length, "retired paths").toBeGreaterThan(2);
    expect(keys).not.toContain("/tasks");
  });

  it("still sets the owner on create, so the port did not move the capability", () => {
    // Both of the legacy page's create forms keep their picker: the page's and
    // RelatedTasks'. This is a port, not a migration.
    const pickers = v1.match(/<SelectField name="ownerUserId" label="Assignee"/g) ?? [];
    expect(pickers.length, "legacy assignee pickers").toBe(2);
  });
});
