/**
 * Proposal Word (.docx) export.
 *
 * Ported from the LSI proposal-system v5 prototype (exportWord). Uses the
 * `docx` library to build a fully-formatted Word document client-side, then
 * triggers download as a Blob.
 *
 * The library is loaded from a CDN at runtime (not bundled) — matches the
 * source prototype's `<script src="https://unpkg.com/docx@8.5.0/build/index.js">`
 * approach. Trade-offs:
 *   - PRO: no `docx` package in package.json, no pnpm-lock churn, no bundler
 *     hit; ships only when user clicks Word
 *   - CON: requires internet access at export time (fine for a SaaS app);
 *     the library isn't type-checked at compile time (we use a hand-typed
 *     shim for the few APIs we touch)
 *
 * Loaded once per page-load and cached on `window.docx`.
 */

import type {
  ProposalSectionMap,
  ProposalMilestone,
  PricingTable,
  CaseStudy,
  PrintableProposal,
} from "./buildPrintHTML";

const DOCX_CDN_URL = "https://unpkg.com/docx@8.5.0/build/index.js";

// Minimal type for the parts of `docx` we use. Not exhaustive — just enough
// to keep TypeScript happy inside this module.
type DocxLib = {
  Document: new (opts: unknown) => unknown;
  Packer: { toBlob: (doc: unknown) => Promise<Blob> };
  Paragraph: new (opts: unknown) => unknown;
  TextRun: new (opts: unknown) => unknown;
  Table: new (opts: unknown) => unknown;
  TableRow: new (opts: unknown) => unknown;
  TableCell: new (opts: unknown) => unknown;
  Header: new (opts: unknown) => unknown;
  Footer: new (opts: unknown) => unknown;
  AlignmentType: Record<string, unknown>;
  BorderStyle: Record<string, unknown>;
  WidthType: Record<string, unknown>;
  ShadingType: Record<string, unknown>;
  LevelFormat: Record<string, unknown>;
};

declare global {
  interface Window {
    docx?: DocxLib;
  }
}

/**
 * Inject the docx UMD bundle as a <script> tag and resolve once it has
 * registered itself on `window.docx`. Subsequent calls return immediately.
 */
function loadDocxFromCdn(): Promise<DocxLib> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("docx export requires a browser"));
  }
  if (window.docx) return Promise.resolve(window.docx);

  // If a script tag is already in flight from a prior click, reuse it
  const existing = document.querySelector<HTMLScriptElement>(
    `script[data-docx-cdn="true"]`,
  );
  if (existing) {
    return new Promise((resolve, reject) => {
      existing.addEventListener("load", () => {
        if (window.docx) resolve(window.docx);
        else reject(new Error("docx loaded but window.docx is undefined"));
      });
      existing.addEventListener("error", () =>
        reject(new Error("Failed to load docx from CDN")),
      );
    });
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = DOCX_CDN_URL;
    script.async = true;
    script.crossOrigin = "anonymous";
    script.dataset.docxCdn = "true";
    script.addEventListener("load", () => {
      if (window.docx) resolve(window.docx);
      else reject(new Error("docx loaded but window.docx is undefined"));
    });
    script.addEventListener("error", () => {
      script.remove();
      reject(new Error("Failed to load docx from CDN — check internet connection"));
    });
    document.head.appendChild(script);
  });
}

function fmtDate(d: string | Date | null | undefined): string {
  if (!d) return "";
  try {
    const date = typeof d === "string" ? new Date(d) : d;
    if (isNaN(date.getTime())) return "";
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return "";
  }
}

function fmtMoney(n: number | undefined): string {
  return "$" + (Number(n) || 0).toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function computePricing(pt: PricingTable | null | undefined) {
  const items = pt?.items ?? [];
  const subtotal = items.reduce((s, i) => s + (Number(i.fee) || 0), 0);
  const totalHours = items.reduce((s, i) => s + (Number(i.hours) || 0), 0);
  return { subtotal, totalHours };
}

const OWNER_LABEL: Record<string, string> = {
  lsi_media: "Our Team", // legacy DB enum value = "the proposing company"
  client: "Client",
  both: "Both",
};

// Tenant-neutral defaults: the caller passes the workspace's own company
// details (senderOrg = workspace name); anything not provided is simply
// omitted. Never hardcode a tenant here.
const DEFAULTS = {
  senderOrg: "",
  senderName: "",
  senderTitle: "",
  senderAddress: [] as string[],
  senderPhone: "",
  senderWebsite: "",
};

/**
 * Build and download a .docx for the given proposal data.
 * Returns the filename used so callers can show a success toast.
 */
export async function downloadProposalDocx(opts: {
  proposal: PrintableProposal;
  sections?: ProposalSectionMap;
  milestones?: ProposalMilestone[];
  pricingTable?: PricingTable;
  caseStudies?: CaseStudy[];
}): Promise<string> {
  // CDN-loaded library — typed as `any` here because we don't bundle the
  // real `docx` package, so its types aren't available. The shim in
  // loadDocxFromCdn() validates the runtime shape on the first call.
  //
  // The local type aliases below let `Paragraph`, `Table`, etc. work in
  // type-positions (e.g. `Paragraph[]`) alongside the destructured value
  // bindings — TS keeps types and values in separate namespaces.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Paragraph = any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Table = any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type TextRun = any;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const D = (await loadDocxFromCdn()) as any;
  const {
    Document,
    Packer,
    Paragraph,
    TextRun,
    Table,
    TableRow,
    TableCell,
    Header,
    Footer,
    AlignmentType,
    BorderStyle,
    WidthType,
    ShadingType,
    LevelFormat,
  } = D;

  const { proposal, sections, milestones, pricingTable, caseStudies } = opts;
  const sender = {
    org: proposal.senderOrg ?? DEFAULTS.senderOrg,
    name: proposal.senderName ?? DEFAULTS.senderName,
    title: proposal.senderTitle ?? DEFAULTS.senderTitle,
    address: proposal.senderAddress ?? DEFAULTS.senderAddress,
    phone: proposal.senderPhone ?? DEFAULTS.senderPhone,
    website: proposal.senderWebsite ?? DEFAULTS.senderWebsite,
  };

  // Brand palette (hex without leading #, the docx library wants raw hex)
  const NAVY = "0e1e3d";
  const BLUE = "1e55d0";
  const TEAL = "00b4a0";
  const GRAY = "64748b";
  const LGRAY = "f4f6fb";
  const LLBLUE = "f0f5ff";
  const BLBLUE = "e8eeff";

  // US Letter content width (8.5in - 2*margins) in DXA: 12240 - 2*1260 = 9720,
  // but we use 9360 to match the source prototype (slightly narrower margins
  // on inner tables for readability)
  const W = 9360;
  const M = { top: 80, bottom: 80, left: 120, right: 120 };

  // ── Text helpers ────────────────────────────────────────────────────────
  const T = (text: string, opts: Record<string, unknown> = {}) =>
    new TextRun({ text: String(text ?? ""), font: "Calibri", size: 21, ...opts });
  const TBold = (text: string, opts: Record<string, unknown> = {}) => T(text, { bold: true, ...opts });
  const TSect = (text: string, opts: Record<string, unknown> = {}) => T(text, { size: 17, color: GRAY, ...opts });

  const P0 = (children: TextRun[], opts: Record<string, unknown> = {}) =>
    new Paragraph({ children, spacing: { after: 80 }, ...opts });
  const Blank = () => new Paragraph({ children: [T("")], spacing: { after: 60 } });

  const SecHead = (num: string, title: string) =>
    new Paragraph({
      children: [TBold(`${num}.  ${title}`, { size: 25, color: BLUE })],
      spacing: { before: 340, after: 120 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: BLUE } },
    });

  const SubHead = (text: string) =>
    new Paragraph({
      children: [TBold(text, { size: 20, color: NAVY })],
      spacing: { before: 160, after: 60 },
    });

  // Parse plain-text section into docx paragraphs (bullets, subheads, plain)
  const parseSec = (text: string | null | undefined): Paragraph[] => {
    if (!text) return [Blank()];
    const out: Paragraph[] = [];
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      if (!line) {
        out.push(Blank());
        continue;
      }
      if (line.startsWith("•")) {
        out.push(
          new Paragraph({
            numbering: { reference: "bullets", level: 0 },
            children: [T(line.replace(/^•\s*/, ""))],
            spacing: { after: 60 },
          }),
        );
        continue;
      }
      const isSub =
        line.length >= 5 &&
        line === line.toUpperCase() &&
        /[A-Z]{3}/.test(line) &&
        !line.startsWith("$") &&
        !/^\d/.test(line) &&
        !line.startsWith("[");
      out.push(isSub ? SubHead(line) : P0([T(line)]));
    }
    return out;
  };

  // ── Cell helpers ────────────────────────────────────────────────────────
  const HdrCell = (text: string, w: number) =>
    new TableCell({
      children: [new Paragraph({ children: [TBold(text, { color: "ffffff", size: 19 })], spacing: { after: 0 } })],
      width: { size: w, type: WidthType.DXA },
      margins: M,
      shading: { fill: BLUE, type: ShadingType.CLEAR },
    });

  const DkCell = (text: string, w: number, bold = false) =>
    new TableCell({
      children: [
        new Paragraph({
          children: [bold ? TBold(text, { color: "ffffff", size: 19 }) : TSect(text, { size: 19, color: "ffffff" })],
          spacing: { after: 0 },
        }),
      ],
      width: { size: w, type: WidthType.DXA },
      margins: M,
      shading: { fill: NAVY, type: ShadingType.CLEAR },
    });

  const DataCell = (
    children: (TextRun | Paragraph)[],
    w: number,
    even = false,
    opts: Record<string, unknown> = {},
  ) =>
    new TableCell({
      children:
        Array.isArray(children) && children[0] instanceof Paragraph
          ? (children as Paragraph[])
          : [new Paragraph({ children: children as TextRun[], spacing: { after: 0 } })],
      width: { size: w, type: WidthType.DXA },
      margins: M,
      shading: { fill: even ? LGRAY : "ffffff", type: ShadingType.CLEAR },
      ...opts,
    });

  // ── Cover banner (4 blue paragraphs) ────────────────────────────────────
  const coverBanner = [
    new Paragraph({
      children: [TBold(`PROPOSAL FOR ${proposal.title.toUpperCase()}`, { size: 28, color: "ffffff" })],
      shading: { fill: BLUE, type: ShadingType.CLEAR },
      spacing: { before: 80, after: 0 },
      indent: { left: 160, right: 160 },
    }),
    new Paragraph({
      children: [TBold(proposal.clientName, { size: 24, color: "ffffff" })],
      shading: { fill: BLUE, type: ShadingType.CLEAR },
      spacing: { before: 0, after: 0 },
      indent: { left: 160, right: 160 },
    }),
    new Paragraph({
      children: [T(`${proposal.clientWebsite || ""}`, { size: 20, color: "b8d0ff" })],
      shading: { fill: BLUE, type: ShadingType.CLEAR },
      spacing: { before: 0, after: 0 },
      indent: { left: 160, right: 160 },
    }),
    new Paragraph({
      children: [
        T(
          `Submitted ${new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}  |  Deadline: ${fmtDate(proposal.rfpDeadline)}  |  Completion: ${fmtDate(proposal.completionDate)}`,
          { size: 17, color: "b8d0ff" },
        ),
      ],
      shading: { fill: BLUE, type: ShadingType.CLEAR },
      spacing: { before: 0, after: 140 },
      indent: { left: 160, right: 160 },
    }),
  ];

  // ── Cover table ─────────────────────────────────────────────────────────
  const coverTable = new Table({
    width: { size: W, type: WidthType.DXA },
    columnWidths: [W / 2, W / 2],
    rows: [
      new TableRow({
        children: [
          new TableCell({
            width: { size: W / 2, type: WidthType.DXA },
            margins: { top: 140, bottom: 140, left: 160, right: 160 },
            shading: { fill: LGRAY, type: ShadingType.CLEAR },
            children: [
              new Paragraph({ children: [TBold("SUBMITTED BY", { size: 17, color: BLUE })], spacing: { after: 80 } }),
              // Only render the letterhead lines that exist — blank sender
              // fields must not leave empty paragraphs.
              ...(sender.name ? [new Paragraph({ children: [TBold(sender.name)], spacing: { after: 40 } })] : []),
              ...(sender.title ? [new Paragraph({ children: [T(sender.title, { italics: true, size: 19 })], spacing: { after: 80 } })] : []),
              ...(sender.org ? [new Paragraph({ children: [TBold(sender.org)], spacing: { after: 40 } })] : []),
              ...sender.address.map(
                (line) => new Paragraph({ children: [T(line, { size: 19 })], spacing: { after: 40 } }),
              ),
              ...(sender.phone ? [new Paragraph({ children: [T(sender.phone, { size: 19 })], spacing: { after: 40 } })] : []),
              ...(sender.website ? [new Paragraph({ children: [T(sender.website, { size: 19 })], spacing: { after: 0 } })] : []),
            ],
          }),
          new TableCell({
            width: { size: W / 2, type: WidthType.DXA },
            margins: { top: 140, bottom: 140, left: 160, right: 160 },
            shading: { fill: LGRAY, type: ShadingType.CLEAR },
            children: [
              new Paragraph({ children: [TBold("SUBMITTED TO", { size: 17, color: BLUE })], spacing: { after: 80 } }),
              new Paragraph({ children: [TBold(proposal.clientName)], spacing: { after: 40 } }),
              ...(proposal.clientEmail
                ? [new Paragraph({ children: [T(proposal.clientEmail, { size: 19 })], spacing: { after: 40 } })]
                : []),
              ...(proposal.clientWebsite
                ? [new Paragraph({ children: [T(proposal.clientWebsite, { size: 19 })], spacing: { after: 80 } })]
                : [new Paragraph({ children: [T("")], spacing: { after: 80 } })]),
              new Paragraph({
                children: [T(`RFP: ${proposal.projectType || ""}`, { size: 19 })],
                spacing: { after: 40 },
              }),
              new Paragraph({
                children: [T(`Project Deadline: ${fmtDate(proposal.completionDate)}`, { size: 19 })],
                spacing: { after: 80 },
              }),
            ],
          }),
        ],
      }),
    ],
  });

  // ── Pricing table from structured data ─────────────────────────────────
  const pricingTableChildren = (pt: PricingTable | null | undefined): (Paragraph | Table)[] => {
    if (!pt?.items?.length) return [Blank()];
    const showHours = pt.showHours !== false;
    const { subtotal, totalHours } = computePricing(pt);
    const colWidths = showHours ? [2000, 4800, 1400, 1160] : [2200, 5800, 1360];
    const hRow = new TableRow({
      children: showHours
        ? [HdrCell("Phase", 2000), HdrCell("Description", 4800), HdrCell("Est. Hours", 1400), HdrCell("Fixed Fee", 1160)]
        : [HdrCell("Phase", 2200), HdrCell("Description", 5800), HdrCell("Fixed Fee", 1360)],
    });
    const dRows = pt.items.map((it, i) => {
      const even = i % 2 === 0;
      return new TableRow({
        children: showHours
          ? [
              DataCell([TBold(it.phase || "", { size: 19 })], 2000, even),
              DataCell([T(it.description || "", { size: 19 })], 4800, even),
              DataCell([T(`~${it.hours || 0} hrs`, { size: 19 })], 1400, even),
              DataCell([TBold(fmtMoney(it.fee), { size: 19 })], 1160, even),
            ]
          : [
              DataCell([TBold(it.phase || "", { size: 19 })], 2200, even),
              DataCell([T(it.description || "", { size: 19 })], 5800, even),
              DataCell([TBold(fmtMoney(it.fee), { size: 19 })], 1360, even),
            ],
      });
    });
    const totalRow = new TableRow({
      children: showHours
        ? [
            new TableCell({
              children: [new Paragraph({ children: [TBold("TOTAL FIXED FEE", { size: 19 })], spacing: { after: 0 } })],
              width: { size: 6800, type: WidthType.DXA },
              margins: M,
              columnSpan: 2,
              shading: { fill: BLBLUE, type: ShadingType.CLEAR },
              borders: { top: { style: BorderStyle.SINGLE, size: 8, color: BLUE } },
            }),
            new TableCell({
              children: [new Paragraph({ children: [TBold(`~${totalHours} hrs`, { size: 19 })], spacing: { after: 0 } })],
              width: { size: 1400, type: WidthType.DXA },
              margins: M,
              shading: { fill: BLBLUE, type: ShadingType.CLEAR },
              borders: { top: { style: BorderStyle.SINGLE, size: 8, color: BLUE } },
            }),
            new TableCell({
              children: [new Paragraph({ children: [TBold(fmtMoney(subtotal), { size: 19 })], spacing: { after: 0 } })],
              width: { size: 1160, type: WidthType.DXA },
              margins: M,
              shading: { fill: BLBLUE, type: ShadingType.CLEAR },
              borders: { top: { style: BorderStyle.SINGLE, size: 8, color: BLUE } },
            }),
          ]
        : [
            new TableCell({
              children: [new Paragraph({ children: [TBold("TOTAL FIXED FEE", { size: 19 })], spacing: { after: 0 } })],
              width: { size: 8000, type: WidthType.DXA },
              margins: M,
              columnSpan: 2,
              shading: { fill: BLBLUE, type: ShadingType.CLEAR },
              borders: { top: { style: BorderStyle.SINGLE, size: 8, color: BLUE } },
            }),
            new TableCell({
              children: [new Paragraph({ children: [TBold(fmtMoney(subtotal), { size: 19 })], spacing: { after: 0 } })],
              width: { size: 1360, type: WidthType.DXA },
              margins: M,
              shading: { fill: BLBLUE, type: ShadingType.CLEAR },
              borders: { top: { style: BorderStyle.SINGLE, size: 8, color: BLUE } },
            }),
          ],
    });
    const table = new Table({ width: { size: W, type: WidthType.DXA }, columnWidths: colWidths, rows: [hRow, ...dRows, totalRow] });
    return [
      table,
      Blank(),
      ...(pt.paymentTerms ? parseSec(pt.paymentTerms) : []),
      ...(pt.optionalAddons ? parseSec(pt.optionalAddons) : []),
    ];
  };

  // ── Milestone table ─────────────────────────────────────────────────────
  const milestoneTable = (ms: ProposalMilestone[] | null | undefined): (Paragraph | Table)[] => {
    if (!ms?.length) return [Blank()];
    const hRow = new TableRow({
      children: [
        DkCell("#", 400, true),
        DkCell("Milestone", 2200, true),
        DkCell("Target Date", 1500, true),
        DkCell("Description", 3760, true),
        DkCell("Owner", 1500, true),
      ],
    });
    const dRows = ms.map((m, i) => {
      const even = i % 2 === 0;
      return new TableRow({
        children: [
          DataCell([TBold(`${i + 1}`, { size: 18 })], 400, even),
          DataCell([TBold(m.name, { size: 19 })], 2200, even),
          DataCell([T(fmtDate(m.milestoneDate), { size: 19 })], 1500, even),
          DataCell([T(m.description || "", { size: 18, color: "475569" })], 3760, even),
          DataCell([T(OWNER_LABEL[String(m.owner)] ?? String(m.owner ?? ""), { size: 19 })], 1500, even),
        ],
      });
    });
    return [
      new Table({
        width: { size: W, type: WidthType.DXA },
        columnWidths: [400, 2200, 1500, 3760, 1500],
        rows: [hRow, ...dRows],
      }),
      Blank(),
    ];
  };

  // ── Case studies as a stack of teal-border boxes ────────────────────────
  const caseStudyChildren = (cs: CaseStudy[] | null | undefined): Paragraph[] => {
    if (!cs?.length) return [Blank()];
    const out: Paragraph[] = [];
    cs.forEach((c, i) => {
      out.push(
        new Paragraph({
          children: [
            TBold(c.title || "", { size: 21, color: NAVY }),
            T(`    ${c.client || ""}${c.year ? " · " + c.year : ""}`, { size: 18, color: GRAY, italics: true }),
          ],
          shading: { fill: "f0f9f7", type: ShadingType.CLEAR },
          border: { left: { style: BorderStyle.SINGLE, size: 18, color: TEAL } },
          indent: { left: 140 },
          spacing: { before: i === 0 ? 80 : 160, after: 60 },
        }),
      );
      if (c.summary)
        out.push(
          new Paragraph({
            children: [T(c.summary, { size: 19 })],
            shading: { fill: "f0f9f7", type: ShadingType.CLEAR },
            border: { left: { style: BorderStyle.SINGLE, size: 18, color: TEAL } },
            indent: { left: 140 },
            spacing: { after: 60 },
          }),
        );
      if (c.results)
        out.push(
          new Paragraph({
            children: [TBold("Results: ", { size: 19 }), T(c.results, { size: 19 })],
            shading: { fill: "f0f9f7", type: ShadingType.CLEAR },
            border: { left: { style: BorderStyle.SINGLE, size: 18, color: TEAL } },
            indent: { left: 140 },
            spacing: { after: 120 },
          }),
        );
    });
    return out;
  };

  // ── Signature table ─────────────────────────────────────────────────────
  const sigTable = new Table({
    width: { size: W, type: WidthType.DXA },
    columnWidths: [W / 2, W / 2],
    rows: [
      new TableRow({
        children: [
          new TableCell({
            width: { size: W / 2, type: WidthType.DXA },
            margins: { top: 140, bottom: 200, left: 160, right: 160 },
            children: [
              ...(sender.org ? [new Paragraph({ children: [TBold(sender.org)], spacing: { after: 40 } })] : []),
              new Paragraph({
                children: [T([sender.name, sender.title].filter(Boolean).join(", "), { size: 19 })],
                spacing: { after: 300 },
              }),
              new Paragraph({
                children: [T("Signature / Date", { size: 17, color: GRAY })],
                spacing: { after: 0 },
                border: { top: { style: BorderStyle.SINGLE, size: 4, color: "c0cce0" } },
              }),
            ],
          }),
          new TableCell({
            width: { size: W / 2, type: WidthType.DXA },
            margins: { top: 140, bottom: 200, left: 160, right: 160 },
            children: [
              new Paragraph({ children: [TBold(proposal.clientName)], spacing: { after: 40 } }),
              new Paragraph({
                children: [T("Printed Name / Title", { size: 19 })],
                spacing: { after: 300 },
              }),
              new Paragraph({
                children: [T("Signature / Date", { size: 17, color: GRAY })],
                spacing: { after: 0 },
                border: { top: { style: BorderStyle.SINGLE, size: 4, color: "c0cce0" } },
              }),
            ],
          }),
        ],
      }),
    ],
  });

  // ── Numbered sections (skipped sections shift the rest down) ────────────
  let sectionNum = 0;
  const nextNum = () => String(++sectionNum);

  const sectionChildren: (Paragraph | Table)[] = [];
  if (sections?.firm_overview) {
    sectionChildren.push(SecHead(nextNum(), "Firm Overview"), ...parseSec(sections.firm_overview));
  }
  if (sections?.executive_summary) {
    sectionChildren.push(
      SecHead(nextNum(), "Executive Summary & Understanding of the Project"),
      ...parseSec(sections.executive_summary),
    );
  }
  if (sections?.approach) {
    sectionChildren.push(SecHead(nextNum(), "Project Approach and Proposed Phases"), ...parseSec(sections.approach));
  }
  if (sections?.timeline_narrative || milestones?.length) {
    sectionChildren.push(SecHead(nextNum(), "Project Timeline"), ...parseSec(sections?.timeline_narrative));
    if (milestones?.length) {
      sectionChildren.push(SubHead("Milestone Summary"), ...milestoneTable(milestones));
    }
  }
  if (pricingTable?.items?.length) {
    sectionChildren.push(SecHead(nextNum(), "Fixed-Fee Pricing"), ...pricingTableChildren(pricingTable));
  }
  if (caseStudies?.length) {
    sectionChildren.push(SecHead(nextNum(), "Relevant Case Studies"), ...caseStudyChildren(caseStudies));
  }
  if (sections?.references) {
    sectionChildren.push(SecHead(nextNum(), "References"), ...parseSec(sections.references));
  }
  if (sections?.terms) {
    sectionChildren.push(SecHead(nextNum(), "Terms & Governing Agreement"), ...parseSec(sections.terms));
  }

  // ── Assemble document ───────────────────────────────────────────────────
  const children: (Paragraph | Table)[] = [
    ...coverBanner,
    coverTable,
    ...sectionChildren,
    Blank(),
    sigTable,
  ];

  const doc = new Document({
    numbering: {
      config: [
        {
          reference: "bullets",
          levels: [
            {
              level: 0,
              format: LevelFormat.BULLET,
              text: "•",
              alignment: AlignmentType.LEFT,
              style: {
                paragraph: { indent: { left: 560, hanging: 280 } },
                run: { font: "Arial", size: 20 },
              },
            },
          ],
        },
      ],
    },
    styles: { default: { document: { run: { font: "Calibri", size: 21 } } } },
    sections: [
      {
        properties: {
          page: { size: { width: 12240, height: 15840 }, margin: { top: 1080, right: 1260, bottom: 1080, left: 1260 } },
        },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                children: [TSect(sender.org ? `${sender.org}  |  Proposal: ` : "Proposal: "), TSect(proposal.title, { italics: true })],
                border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: BLUE } },
                spacing: { after: 0 },
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                children: [
                  TSect(
                    [sender.org, sender.address.join(", "), sender.phone, sender.website]
                      .filter(Boolean)
                      .join("  ·  "),
                  ),
                ],
                alignment: AlignmentType.CENTER,
                border: { top: { style: BorderStyle.SINGLE, size: 4, color: "dde3f0" } },
              }),
            ],
          }),
        },
        children,
      },
    ],
  });

  const blob = await Packer.toBlob(doc);
  const url = URL.createObjectURL(blob);
  const filename = `${proposal.title.replace(/[^a-z0-9]+/gi, "-")}-proposal.docx`;
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5_000);
  return filename;
}
