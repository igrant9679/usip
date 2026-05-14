/**
 * Proposal PDF export — print-ready HTML generator.
 *
 * Ported from the LSI proposal-system v5 prototype (buildPrintHTML).
 * Takes a proposal + its sections / milestones / pricing / case studies
 * and returns a complete <html>...</html> string styled for print.
 *
 * Caller opens the result in a new window and calls window.print(), which
 * lets the user save as PDF via the browser's print dialog. No PDF library
 * required — keeps the bundle small.
 */

export type ProposalSectionMap = Record<string, string | null | undefined>;

export type ProposalMilestone = {
  id?: number;
  name: string;
  milestoneDate?: string | Date | null;
  description?: string | null;
  owner?: "lsi_media" | "client" | "both" | string | null;
  sortOrder?: number;
};

export type PricingItem = {
  id?: string | number;
  phase?: string;
  description?: string;
  hours?: number;
  fee?: number;
};

export type PricingTable = {
  items: PricingItem[];
  showHours?: boolean;
  paymentTerms?: string;
  optionalAddons?: string;
};

export type CaseStudy = {
  id?: string | number;
  title?: string;
  client?: string;
  year?: string | number;
  summary?: string;
  results?: string;
};

export type PrintableProposal = {
  title: string;
  clientName: string;
  clientEmail?: string | null;
  clientWebsite?: string | null;
  projectType?: string | null;
  rfpDeadline?: string | Date | null;
  completionDate?: string | Date | null;
  /** Friendly company "Submitted By" block — defaults to LSI Media. */
  senderOrg?: string;
  senderName?: string;
  senderTitle?: string;
  senderAddress?: string[];
  senderPhone?: string;
  senderWebsite?: string;
  /** Header logo URL — optional, omitted if blank. */
  logoUrl?: string;
};

const DEFAULTS = {
  senderOrg: "LSI Media LLC",
  senderName: "Sabine Grant",
  senderTitle: "Chief Creative Officer",
  senderAddress: ["25 Catoctin Cir. SE, #4087", "Leesburg, VA 20177"],
  senderPhone: "1.866.960.8737",
  senderWebsite: "lsi-media.com",
  logoUrl: "https://www.lsi-media.com/wp-content/uploads/2018/03/lsi-media-logo-120_450-retina.png",
};

const esc = (s: unknown): string =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const fmtDate = (d: string | Date | null | undefined): string => {
  if (!d) return "";
  try {
    const date = typeof d === "string" ? new Date(d) : d;
    if (isNaN(date.getTime())) return "";
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return "";
  }
};

const fmtMoney = (n: number | undefined): string =>
  "$" + (Number(n) || 0).toLocaleString("en-US", { maximumFractionDigits: 0 });

function computePricing(pt: PricingTable | null | undefined) {
  const items = pt?.items ?? [];
  const subtotal = items.reduce((s, i) => s + (Number(i.fee) || 0), 0);
  const totalHours = items.reduce((s, i) => s + (Number(i.hours) || 0), 0);
  return { subtotal, totalHours, total: subtotal };
}

const OWNER_LABEL: Record<string, string> = {
  lsi_media: "LSI Media",
  client: "Client",
  both: "Both",
};

/**
 * Convert plain-text section content into formatted HTML.
 *  - Lines starting with "•" become bullets
 *  - All-caps lines >= 5 chars become <h3> subheads
 *  - Blank lines break lists
 */
function renderSection(text: string | null | undefined): string {
  if (!text) return "";
  const lines = text.split("\n");
  let html = "";
  let inList = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      if (inList) {
        html += "</ul>";
        inList = false;
      }
      continue;
    }
    if (line.startsWith("•")) {
      if (!inList) {
        html += '<ul class="blist">';
        inList = true;
      }
      html += `<li>${esc(line.replace(/^•\s*/, ""))}</li>`;
      continue;
    }
    if (inList) {
      html += "</ul>";
      inList = false;
    }
    const isSubhead =
      line.length >= 5 &&
      line === line.toUpperCase() &&
      /[A-Z]{3}/.test(line) &&
      !line.startsWith("$") &&
      !/^\d/.test(line) &&
      !line.startsWith("[") &&
      !/^https?/.test(line);
    html += isSubhead ? `<h3>${esc(line)}</h3>` : `<p>${esc(line)}</p>`;
  }
  if (inList) html += "</ul>";
  return html;
}

function renderPricingTable(pt: PricingTable | null | undefined): string {
  if (!pt?.items?.length) return "";
  const showHours = pt.showHours !== false;
  const { subtotal, totalHours } = computePricing(pt);
  const rows = pt.items
    .map(
      (it) => `<tr>
    <td><strong>${esc(it.phase || "")}</strong></td>
    <td>${esc(it.description || "")}</td>
    ${showHours ? `<td style="text-align:center">~${esc(String(it.hours || 0))} hrs</td>` : ""}
    <td style="text-align:right"><strong>${esc(fmtMoney(it.fee))}</strong></td>
  </tr>`,
    )
    .join("");
  const colCount = showHours ? 4 : 3;
  const totalRow = `<tr class="total">
    <td colspan="${colCount - 2}"><strong>TOTAL FIXED FEE</strong></td>
    ${showHours ? `<td style="text-align:center"><strong>~${totalHours} hrs</strong></td>` : ""}
    <td style="text-align:right"><strong>${esc(fmtMoney(subtotal))}</strong></td>
  </tr>`;
  const tbl = `<table class="ptable"><thead><tr>
    <th>Phase</th><th>Description</th>
    ${showHours ? '<th style="text-align:center">Est. Hours</th>' : ""}
    <th style="text-align:right">Fixed Fee</th>
  </tr></thead><tbody>${rows}${totalRow}</tbody></table>`;
  const pay = pt.paymentTerms ? `<div class="paybox">${renderSection(pt.paymentTerms)}</div>` : "";
  const opt = pt.optionalAddons ? renderSection(pt.optionalAddons) : "";
  return tbl + pay + opt;
}

function renderCaseStudies(cs: CaseStudy[] | null | undefined): string {
  if (!cs?.length) return "";
  return cs
    .map(
      (c) => `<div class="csbox">
    <div class="cstop">
      <strong>${esc(c.title || "")}</strong>
      <span class="csmeta">${esc(c.client || "")}${c.year ? " &middot; " + esc(c.year) : ""}</span>
    </div>
    ${c.summary ? `<p class="csbody">${esc(c.summary)}</p>` : ""}
    ${c.results ? `<p class="csres"><strong>Results:</strong> ${esc(c.results)}</p>` : ""}
  </div>`,
    )
    .join("");
}

function renderMilestones(ms: ProposalMilestone[] | null | undefined): string {
  if (!ms?.length) return "";
  const rows = ms
    .map(
      (m, i) => `<tr>
    <td style="text-align:center;width:32px"><span class="mnum">${i + 1}</span></td>
    <td><strong>${esc(m.name)}</strong></td>
    <td style="white-space:nowrap">${esc(fmtDate(m.milestoneDate))}</td>
    <td style="font-size:9pt;color:#475569;line-height:1.4">${esc(m.description || "")}</td>
    <td style="white-space:nowrap">${esc(OWNER_LABEL[String(m.owner)] ?? m.owner ?? "")}</td>
  </tr>`,
    )
    .join("");
  return `<table class="mstable"><thead><tr>
    <th>#</th><th>Milestone</th><th>Target Date</th><th>Description</th><th>Owner</th>
  </tr></thead><tbody>${rows}</tbody></table>`;
}

const CSS = `
@page { size: letter; margin: 0.75in 1in; }
*{box-sizing:border-box}
body{font-family:Calibri,'Segoe UI',Arial,sans-serif;font-size:10.5pt;line-height:1.45;color:#1e293b;margin:0;padding:0}
.page{max-width:6.5in;margin:0 auto}
.dh{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:9px;border-bottom:2pt solid #1e55d0;margin-bottom:0}
.dh img{height:46px;object-fit:contain;display:block}
.dh .tag{font-size:8pt;color:#64748b;margin-top:4px}
.dh .hr{text-align:right;font-size:8.5pt;color:#64748b;line-height:1.65}
.dh .hr strong{color:#0e1e3d}
.cb{background:#1e55d0;color:#fff;padding:13px 16px}
.cb .lbl{font-size:9pt;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;opacity:.7}
.cb .ttl{font-size:15pt;font-weight:700;margin:3px 0 2px}
.cb .org{font-size:11pt;opacity:.92}
.cb .dt{font-size:8.5pt;opacity:.7;margin-top:4px}
.mt{width:100%;border-collapse:collapse}
.mt td{width:50%;vertical-align:top;padding:11px 14px;border:.75pt solid #c0cce0;font-size:9.5pt;line-height:1.65}
.mt td:first-child{border-right:none}
.ml{font-size:7.5pt;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#1e55d0;display:block;margin-bottom:5px}
.cn{background:#f0f5ff;border-left:4pt solid #1e55d0;padding:9px 14px;margin:13px 0 20px;font-size:9pt;line-height:1.55}
h2.sh{font-size:12.5pt;font-weight:700;color:#1e55d0;margin:28px 0 10px;padding-bottom:5px;border-bottom:1.5pt solid #1e55d0;page-break-after:avoid}
h3{font-size:10pt;font-weight:700;color:#0e1e3d;text-transform:uppercase;letter-spacing:.4pt;margin:14px 0 5px;page-break-after:avoid}
p{margin:0 0 7px;font-size:10.5pt;line-height:1.5}
ul.blist{margin:0 0 9px;padding-left:0;list-style:none}
ul.blist li{position:relative;padding-left:14px;margin-bottom:4px;font-size:10pt;line-height:1.45}
ul.blist li::before{content:"\\2022";position:absolute;left:0;color:#1e55d0;font-weight:bold}
table.ptable{width:100%;border-collapse:collapse;margin:10px 0 0;font-size:9.5pt}
table.ptable th{background:#1e55d0;color:#fff;padding:7px 9px;text-align:left;font-size:8.5pt;font-weight:700}
table.ptable td{padding:6px 9px;border-bottom:.5pt solid #dde3f0;vertical-align:top}
table.ptable tr:nth-child(even) td{background:#f4f6fb}
table.ptable tr.total td{font-weight:700;background:#e8eeff;border-top:1.5pt solid #1e55d0}
.paybox{border:1pt solid #b0c0e0;background:#f8fbff;padding:9px 13px;margin:12px 0 10px}
.paybox p,.paybox h3{font-size:9pt;margin-bottom:5px}
table.mstable{width:100%;border-collapse:collapse;margin:10px 0;font-size:9pt}
table.mstable th{background:#0e1e3d;color:#fff;padding:6px 9px;text-align:left;font-size:8.5pt;font-weight:700}
table.mstable td{padding:6px 9px;border-bottom:.5pt solid #dde3f0;vertical-align:top}
table.mstable tr:nth-child(even) td{background:#f8f9fc}
.mnum{display:inline-block;width:18px;height:18px;border-radius:50%;background:#1e55d0;color:#fff;text-align:center;line-height:18px;font-size:8pt;font-weight:700}
.csbox{background:#f8fbff;border-left:3pt solid #00b4a0;padding:10px 14px;margin:8px 0 10px;page-break-inside:avoid}
.cstop{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:5px;gap:10px}
.cstop strong{font-size:10.5pt;color:#0e1e3d}
.csmeta{font-size:9pt;color:#64748b;white-space:nowrap}
.csbody{font-size:9.5pt;margin:4px 0;line-height:1.5}
.csres{font-size:9.5pt;margin:4px 0 0;color:#0e1e3d;line-height:1.5;padding-top:4px;border-top:.5pt solid #c0d8d4}
table.sigtbl{width:100%;border-collapse:collapse;margin-top:22px}
table.sigtbl td{width:50%;vertical-align:top;padding:12px 14px;border:.75pt solid #c0cce0;font-size:9.5pt;line-height:1.7}
.sigline{border-top:.75pt solid #94a3b8;margin-top:28px;padding-top:4px;font-size:8.5pt;color:#94a3b8}
.df{margin-top:28px;padding-top:7px;border-top:.5pt solid #dde3f0;font-size:8pt;color:#94a3b8;text-align:center}
@media print{
  body{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important}
  h2.sh,h3{page-break-after:avoid}
  table{page-break-inside:avoid}
}`;

export function buildPrintHTML(opts: {
  proposal: PrintableProposal;
  sections?: ProposalSectionMap;
  milestones?: ProposalMilestone[];
  pricingTable?: PricingTable;
  caseStudies?: CaseStudy[];
}): string {
  const { proposal, sections, milestones, pricingTable, caseStudies } = opts;
  const sender = {
    org: proposal.senderOrg ?? DEFAULTS.senderOrg,
    name: proposal.senderName ?? DEFAULTS.senderName,
    title: proposal.senderTitle ?? DEFAULTS.senderTitle,
    address: proposal.senderAddress ?? DEFAULTS.senderAddress,
    phone: proposal.senderPhone ?? DEFAULTS.senderPhone,
    website: proposal.senderWebsite ?? DEFAULTS.senderWebsite,
    logo: proposal.logoUrl ?? DEFAULTS.logoUrl,
  };

  const submittedDate = new Date().toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const submittedSection = `<table class="mt"><tr>
  <td>
    <span class="ml">Submitted By</span>
    <strong>${esc(sender.name)}</strong><br>${esc(sender.title)}<br><br>
    <strong>${esc(sender.org)}</strong><br>${sender.address.map(esc).join("<br>")}<br>
    ${esc(sender.phone)}<br>${esc(sender.website)}
  </td>
  <td>
    <span class="ml">Submitted To</span>
    <strong>${esc(proposal.clientName)}</strong><br>
    ${proposal.clientEmail ? esc(proposal.clientEmail) + "<br>" : ""}
    ${proposal.clientWebsite ? esc(proposal.clientWebsite) + "<br>" : ""}
    <br>RFP: ${esc(proposal.projectType || "")}<br>
    Project Deadline: ${esc(fmtDate(proposal.completionDate))}
  </td>
</tr></table>`;

  // Section numbering — skipped sections shift the rest down
  let sectionNum = 0;
  const nextNum = () => ++sectionNum;

  const renderedSections: string[] = [];
  if (sections?.firm_overview) {
    renderedSections.push(`<h2 class="sh">${nextNum()}. Firm Overview</h2>${renderSection(sections.firm_overview)}`);
  }
  if (sections?.executive_summary) {
    renderedSections.push(
      `<h2 class="sh">${nextNum()}. Executive Summary &amp; Understanding of the Project</h2>${renderSection(sections.executive_summary)}`,
    );
  }
  if (sections?.approach) {
    renderedSections.push(
      `<h2 class="sh">${nextNum()}. Project Approach and Proposed Phases</h2>${renderSection(sections.approach)}`,
    );
  }
  if (sections?.timeline_narrative || milestones?.length) {
    renderedSections.push(`<h2 class="sh">${nextNum()}. Project Timeline</h2>${renderSection(sections?.timeline_narrative)}`);
    if (milestones?.length) {
      renderedSections.push(`<h3>Milestone Summary</h3>${renderMilestones(milestones)}`);
    }
  }
  if (pricingTable?.items?.length) {
    renderedSections.push(`<h2 class="sh">${nextNum()}. Fixed-Fee Pricing</h2>${renderPricingTable(pricingTable)}`);
  }
  if (caseStudies?.length) {
    renderedSections.push(`<h2 class="sh">${nextNum()}. Relevant Case Studies</h2>${renderCaseStudies(caseStudies)}`);
  }
  if (sections?.references) {
    renderedSections.push(`<h2 class="sh">${nextNum()}. References</h2>${renderSection(sections.references)}`);
  }
  if (sections?.terms) {
    renderedSections.push(`<h2 class="sh">${nextNum()}. Terms &amp; Governing Agreement</h2>${renderSection(sections.terms)}`);
  }

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>${esc(proposal.title)} — ${esc(proposal.clientName)}</title>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@700;800&display=swap" rel="stylesheet">
<style>${CSS}</style></head>
<body><div class="page">

<div class="dh">
  <div>
    ${sender.logo ? `<img src="${esc(sender.logo)}" alt="${esc(sender.org)}" onerror="this.style.display='none'"/>` : `<strong style="font-size:14pt;color:#0e1e3d">${esc(sender.org)}</strong>`}
    <div class="tag">Digital Media Agency &nbsp;&middot;&nbsp; Leesburg, VA</div>
  </div>
  <div class="hr">
    <strong>${esc(sender.org)}</strong><br>
    ${sender.address.map(esc).join(" &nbsp;&middot;&nbsp; ")}<br>
    ${esc(sender.phone)} &nbsp;&middot;&nbsp; ${esc(sender.website)}
  </div>
</div>

<div class="cb">
  <div class="lbl">Proposal for</div>
  <div class="ttl">${esc(proposal.title)}</div>
  <div class="org">${esc(proposal.clientName)}${proposal.clientWebsite ? " &nbsp;&middot;&nbsp; " + esc(proposal.clientWebsite) : ""}</div>
  <div class="dt">Submitted ${esc(submittedDate)} &nbsp;|&nbsp; Deadline: ${esc(fmtDate(proposal.rfpDeadline))} &nbsp;|&nbsp; Project Completion: ${esc(fmtDate(proposal.completionDate))}</div>
</div>

${submittedSection}

${renderedSections.join("\n")}

<table class="sigtbl">
  <tr>
    <td>
      <strong>${esc(sender.org)}</strong><br>${esc(sender.name)}, ${esc(sender.title)}
      <div class="sigline">Signature &nbsp;/&nbsp; Date</div>
    </td>
    <td>
      <strong>${esc(proposal.clientName)}</strong><br>Printed Name / Title
      <div class="sigline">Signature &nbsp;/&nbsp; Date</div>
    </td>
  </tr>
</table>

<div class="df">${esc(sender.org)} &nbsp;&middot;&nbsp; ${sender.address.map(esc).join(" &nbsp;&middot;&nbsp; ")} &nbsp;&middot;&nbsp; ${esc(sender.phone)} &nbsp;&middot;&nbsp; ${esc(sender.website)}</div>
</div></body></html>`;
}

/**
 * Open the rendered HTML in a new tab and trigger the browser print dialog.
 * User can then save as PDF or hit Cancel for print preview.
 */
export function openPrintWindow(html: string): void {
  const win = window.open("", "_blank");
  if (!win) {
    alert("Pop-up blocked. Allow pop-ups for this site to view the print preview.");
    return;
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
  // Wait for fonts/images, then trigger print. setTimeout dance is the cross-
  // browser way to avoid printing a half-rendered page.
  setTimeout(() => {
    try {
      win.focus();
      win.print();
    } catch {
      // User can manually print via Ctrl+P
    }
  }, 500);
}
