import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { PayAppView } from "./ledger";
import { formatBp, formatMoney } from "./money";
import type { G703Row, G703Totals } from "./payapp";
import { UNVERIFIED_BADGE, WAIVER_DISCLAIMER, type WaiverView } from "./waivers";

const INK = rgb(0.11, 0.1, 0.09);
const MUTED = rgb(0.4, 0.38, 0.36);
const RULE = rgb(0.78, 0.76, 0.74);
const SHADE = rgb(0.95, 0.94, 0.93);
const PORTRAIT: [number, number] = [612, 792];
const LANDSCAPE: [number, number] = [792, 612];
const MARGIN = 36;
const ROWS_PER_PAGE = 26;

const WIN_ANSI: Record<string, string> = { "‘": "'", "’": "'", "“": '"', "”": '"', "–": "-", "—": "-", "…": "...", " ": " " };

/** Standard fonts only encode WinAnsi; anything else would make pdf-lib throw. */
function safe(s: string): string {
  return s.replace(/[^\x20-\x7e\xa1-\xff]/g, (ch) => WIN_ANSI[ch] ?? "?");
}

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
}

function fit(text: string, font: PDFFont, size: number, width: number): string {
  let s = safe(text);
  if (font.widthOfTextAtSize(s, size) <= width) return s;
  while (s.length > 1 && font.widthOfTextAtSize(`${s}...`, size) > width) s = s.slice(0, -1);
  return `${s.trimEnd()}...`;
}

function text(page: PDFPage, s: string, x: number, y: number, o: { font: PDFFont; size: number; color?: ReturnType<typeof rgb>; align?: "left" | "right"; width?: number }) {
  const value = o.width ? fit(s, o.font, o.size, o.width) : safe(s);
  const dx = o.align === "right" ? -o.font.widthOfTextAtSize(value, o.size) : 0;
  page.drawText(value, { x: x + dx, y, font: o.font, size: o.size, color: o.color ?? INK });
}

function rule(page: PDFPage, x1: number, y: number, x2: number, thickness = 0.5) {
  page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness, color: RULE });
}

function labelled(page: PDFPage, f: Fonts, label: string, value: string, x: number, y: number, width: number) {
  text(page, label.toUpperCase(), x, y + 11, { font: f.bold, size: 6.5, color: MUTED });
  text(page, value || "-", x, y, { font: f.regular, size: 9.5, width });
}

function headerBlock(page: PDFPage, f: Fonts, orgName: string, v: PayAppView, title: string, top: number, width: number) {
  const { project, payApp } = v;
  text(page, title, MARGIN, top, { font: f.bold, size: 14 });
  text(page, `Application No. ${payApp.number}`, MARGIN + width, top, { font: f.bold, size: 11, align: "right" });
  const y = top - 30;
  const col = width / 4;
  labelled(page, f, "From (contractor)", orgName, MARGIN, y, col - 8);
  labelled(page, f, "To (general contractor)", project.gc_name, MARGIN + col, y, col - 8);
  labelled(page, f, "Project", [project.name, project.number && `#${project.number}`].filter(Boolean).join(" "), MARGIN + col * 2, y, col - 8);
  labelled(page, f, "Period", `${payApp.period_from} to ${payApp.period_to}`, MARGIN + col * 3, y, col - 8);
  const y2 = y - 26;
  labelled(page, f, "Owner", project.owner_name, MARGIN, y2, col - 8);
  labelled(page, f, "Location", [project.location, project.state].filter(Boolean).join(", "), MARGIN + col, y2, col - 8);
  labelled(page, f, "Application date", payApp.submitted_at ? new Date(payApp.submitted_at).toISOString().slice(0, 10) : "Draft", MARGIN + col * 2, y2, col - 8);
  labelled(page, f, "Status", payApp.status === "draft" ? "Draft, not submitted" : payApp.status === "paid" ? "Paid" : "Submitted", MARGIN + col * 3, y2, col - 8);
  rule(page, MARGIN, y2 - 10, MARGIN + width, 1);
  return y2 - 10;
}

function summaryPage(doc: PDFDocument, f: Fonts, orgName: string, v: PayAppView) {
  const page = doc.addPage(PORTRAIT);
  const width = PORTRAIT[0] - MARGIN * 2;
  let y = headerBlock(page, f, orgName, v, "APPLICATION AND CERTIFICATE FOR PAYMENT", PORTRAIT[1] - MARGIN - 14, width) - 24;
  const g = v.result.g702;
  const { payApp } = v;
  text(page, "Contractor's application for payment", MARGIN, y, { font: f.bold, size: 11 });
  y -= 8;
  const lines: [string, string, number, boolean?][] = [
    ["1.", "Original contract sum", g.originalContract],
    ["2.", "Net change by approved change orders", g.netChangeOrders],
    ["3.", "Contract sum to date (line 1 + 2)", g.contractSumToDate, true],
    ["4.", "Total completed and stored to date (column G)", g.completedStoredToDate],
    ["5.", `Retainage: ${formatBp(payApp.retainage_work_bp)} of completed work, ${formatBp(payApp.retainage_stored_bp)} of stored material (column I)`, g.retainage],
    ["6.", "Total earned less retainage (line 4 - 5)", g.earnedLessRetainage, true],
    ["7.", "Less previous certificates for payment (line 6 of prior application)", g.previousCertificates],
    ["8.", "Current payment due (line 6 - 7)", g.currentPaymentDue, true],
    ["9.", "Balance to finish, including retainage (line 3 - 6)", g.balanceToFinish],
  ];
  for (const [n, label, value, strong] of lines) {
    y -= 22;
    if (n === "8.") page.drawRectangle({ x: MARGIN, y: y - 7, width, height: 22, color: SHADE });
    const font = strong ? f.bold : f.regular;
    text(page, n, MARGIN + 4, y, { font, size: 10 });
    text(page, label, MARGIN + 26, y, { font, size: 10, width: width - 150 });
    text(page, formatMoney(value), MARGIN + width - 4, y, { font, size: n === "8." ? 12 : 10, align: "right" });
    rule(page, MARGIN, y - 7, MARGIN + width);
  }

  const approved = v.input.changeOrders.filter((co) => co.status === "approved");
  y -= 34;
  text(page, "Change order summary", MARGIN, y, { font: f.bold, size: 10 });
  y -= 16;
  const additions = approved.filter((co) => co.amountCents > 0).reduce((s, co) => s + co.amountCents, 0);
  const deductions = approved.filter((co) => co.amountCents < 0).reduce((s, co) => s + co.amountCents, 0);
  text(page, `${approved.length} approved. Additions ${formatMoney(additions)}. Deductions ${formatMoney(deductions)}. Net ${formatMoney(additions + deductions)}.`, MARGIN, y, {
    font: f.regular,
    size: 9.5,
  });

  y -= 34;
  const half = width / 2 - 12;
  text(page, "Contractor's certification", MARGIN, y, { font: f.bold, size: 10 });
  text(page, "Certificate for payment", MARGIN + width / 2 + 12, y, { font: f.bold, size: 10 });
  const certify = [
    "The undersigned contractor certifies that the work covered by",
    "this application has been performed in accordance with the",
    "contract documents, that amounts received on prior applications",
    "have been applied to the work, and that the current payment",
    "shown above is now due.",
  ];
  const approve = [
    "Based on review of this application, the undersigned certifies",
    "the amount below for payment to the contractor.",
  ];
  certify.forEach((l, i) => text(page, l, MARGIN, y - 14 - i * 11, { font: f.regular, size: 8.5, color: MUTED }));
  approve.forEach((l, i) => text(page, l, MARGIN + width / 2 + 12, y - 14 - i * 11, { font: f.regular, size: 8.5, color: MUTED }));
  const blank = (label: string, x: number, yy: number, w: number) => {
    text(page, label, x, yy, { font: f.regular, size: 8.5 });
    rule(page, x + f.regular.widthOfTextAtSize(label, 8.5) + 4, yy - 2, x + w, 0.75);
  };
  let ly = y - 86;
  blank(`Contractor: ${safe(orgName)}`, MARGIN, ly, half);
  blank("By:", MARGIN, (ly -= 24), half);
  blank("Title:", MARGIN, (ly -= 24), half);
  blank("Date:", MARGIN, (ly -= 24), half);
  let ry = y - 86;
  const rx = MARGIN + width / 2 + 12;
  blank("Amount certified: $", rx, ry, half);
  blank("Certified by:", rx, (ry -= 24), half);
  blank("Company:", rx, (ry -= 24), half);
  blank("Date:", rx, (ry -= 24), half);

  let ny = ly - 40;
  text(page, "Notary", MARGIN, ny, { font: f.bold, size: 10 });
  blank("State of:", MARGIN, (ny -= 20), half);
  blank("County of:", MARGIN + width / 2 + 12, ny, half);
  blank("Subscribed and sworn to before me this", MARGIN, (ny -= 24), width);
  blank("Notary public:", MARGIN, (ny -= 24), half);
  blank("My commission expires:", MARGIN + width / 2 + 12, ny, half);

  text(page, `Prepared with Drawbook. Continuation sheet attached. Retainage held to date ${formatMoney(g.retainage)}.`, MARGIN, MARGIN - 6, {
    font: f.regular,
    size: 7.5,
    color: MUTED,
  });
}

const COLUMNS: { key: keyof G703Totals | "itemNo" | "description"; head: [string, string, string]; width: number }[] = [
  { key: "itemNo", head: ["A", "Item", "no."], width: 38 },
  { key: "description", head: ["B", "Description", "of work"], width: 172 },
  { key: "c", head: ["C", "Scheduled", "value"], width: 68 },
  { key: "d", head: ["D", "From previous", "application"], width: 68 },
  { key: "e", head: ["E", "Work completed", "this period"], width: 68 },
  { key: "f", head: ["F", "Materials", "presently stored"], width: 66 },
  { key: "g", head: ["G", "Completed and", "stored to date"], width: 70 },
  { key: "pctBp", head: ["", "%", "(G / C)"], width: 38 },
  { key: "h", head: ["H", "Balance", "to finish"], width: 68 },
  { key: "i", head: ["I", "Retainage", ""], width: 64 },
];

function cell(row: G703Row | G703Totals, key: (typeof COLUMNS)[number]["key"]): string {
  if (key === "itemNo" || key === "description") return key in row ? (row as G703Row)[key] : "";
  return key === "pctBp" ? formatBp(row.pctBp) : formatMoney(row[key]);
}

function continuationPages(doc: PDFDocument, f: Fonts, orgName: string, v: PayAppView) {
  const width = LANDSCAPE[0] - MARGIN * 2;
  const rows = v.result.rows;
  const pageCount = Math.max(1, Math.ceil(rows.length / ROWS_PER_PAGE));
  for (let p = 0; p < pageCount; p++) {
    const page = doc.addPage(LANDSCAPE);
    let y = headerBlock(page, f, orgName, v, "CONTINUATION SHEET", LANDSCAPE[1] - MARGIN - 14, width) - 14;
    let x = MARGIN;
    page.drawRectangle({ x: MARGIN, y: y - 30, width, height: 38, color: SHADE });
    for (const col of COLUMNS) {
      const numeric = col.key !== "itemNo" && col.key !== "description";
      const anchor = numeric ? x + col.width - 3 : x + 3;
      col.head.forEach((h, i) => text(page, h, anchor, y - i * 9, { font: i === 0 ? f.bold : f.regular, size: 7, align: numeric ? "right" : "left", color: i === 0 ? INK : MUTED }));
      x += col.width;
    }
    y -= 46;
    const slice = rows.slice(p * ROWS_PER_PAGE, (p + 1) * ROWS_PER_PAGE);
    const drawRow = (row: G703Row | G703Totals, font: PDFFont) => {
      let cx = MARGIN;
      for (const col of COLUMNS) {
        const numeric = col.key !== "itemNo" && col.key !== "description";
        text(page, cell(row, col.key), numeric ? cx + col.width - 3 : cx + 3, y, { font, size: 7.5, align: numeric ? "right" : "left", width: col.width - 6 });
        cx += col.width;
      }
      rule(page, MARGIN, y - 5, MARGIN + width);
      y -= 15;
    };
    for (const row of slice) drawRow(row, f.regular);
    if (p === pageCount - 1) {
      y -= 2;
      text(page, "Grand total", MARGIN + COLUMNS[0]!.width + 3, y, { font: f.bold, size: 7.5 });
      drawRow(v.result.totals, f.bold);
    }
    text(page, `Page ${p + 1} of ${pageCount}`, MARGIN + width, MARGIN - 6, { font: f.regular, size: 7.5, color: MUTED, align: "right" });
    text(page, "Amounts in US dollars. Column I uses the retainage rates on the summary page.", MARGIN, MARGIN - 6, { font: f.regular, size: 7.5, color: MUTED });
  }
}

export async function payAppPdf(orgName: string, v: PayAppView): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(safe(`Pay application ${v.payApp.number} - ${v.project.name}`));
  doc.setAuthor(safe(orgName));
  doc.setCreator("Drawbook");
  const fonts = { regular: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold) };
  summaryPage(doc, fonts, orgName, v);
  continuationPages(doc, fonts, orgName, v);
  return (await doc.save()).slice().buffer;
}

function wrap(s: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of safe(s).split(/ +/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && font.widthOfTextAtSize(next, size) > width) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  return [...lines, line];
}

export async function waiverPdf(orgName: string, v: WaiverView): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  const d = v.document;
  doc.setTitle(safe(`${d.title} - ${v.project.name}`));
  doc.setAuthor(safe(orgName));
  doc.setCreator("Drawbook");
  const f = { regular: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold) };
  const margin = 54;
  const width = PORTRAIT[0] - margin * 2;
  const bottom = margin + 40;
  let page = doc.addPage(PORTRAIT);
  let y = PORTRAIT[1] - margin;
  const ensure = (needed: number) => {
    if (y - needed >= bottom) return;
    page = doc.addPage(PORTRAIT);
    y = PORTRAIT[1] - margin;
  };
  const paragraph = (s: string, o: { font: PDFFont; size: number; color?: ReturnType<typeof rgb>; leading?: number }) => {
    for (const line of wrap(s, o.font, o.size, width)) {
      ensure(o.size + 3);
      text(page, line, margin, y - o.size, { font: o.font, size: o.size, color: o.color });
      y -= o.leading ?? o.size + 3.5;
    }
  };

  text(page, orgName, margin, y - 8, { font: f.regular, size: 8, color: MUTED });
  text(page, [v.project.name, v.payAppNumber !== null && `Pay application #${v.payAppNumber}`].filter(Boolean).join(" - "), margin + width, y - 8, {
    font: f.regular,
    size: 8,
    color: MUTED,
    align: "right",
  });
  y -= 22;
  if (!d.verified) {
    page.drawRectangle({ x: margin, y: y - 18, width, height: 18, color: SHADE });
    text(page, UNVERIFIED_BADGE.toUpperCase(), margin + 6, y - 12.5, { font: f.bold, size: 8.5 });
    y -= 26;
  }
  if (d.source === "generic") paragraph(d.reason, { font: f.regular, size: 8.5, color: MUTED });
  else paragraph(`Statutory form: ${d.citation}`, { font: f.regular, size: 8, color: MUTED });
  if (d.notarize) paragraph("This state requires the waiver to be notarized.", { font: f.bold, size: 8.5 });
  if (d.witness) paragraph("This state requires a witness to the signature.", { font: f.bold, size: 8.5 });
  y -= 6;
  rule(page, margin, y, margin + width, 1);
  y -= 10;

  // One type size for the whole form: several states require the notice to be at least as large as any other type, Georgia at least 12 point.
  const [heading, ...rest] = d.body.split("\n");
  paragraph(heading ?? d.title, { font: f.bold, size: 12, leading: 16 });
  for (const line of rest) {
    if (line.trim() === "") y -= 6;
    else paragraph(line, { font: /^NOTICE/.test(line) || (/^[A-Z0-9 .,'():-]{4,}$/.test(line) && line.length < 80) ? f.bold : f.regular, size: 12, leading: 15 });
  }

  const pages = doc.getPages();
  pages.forEach((p, i) => {
    wrap(WAIVER_DISCLAIMER, f.regular, 7, width - 60).forEach((line, j) => text(p, line, margin, margin - 2 - j * 9, { font: f.regular, size: 7, color: MUTED }));
    text(p, `Page ${i + 1} of ${pages.length}`, margin + width, margin - 2, { font: f.regular, size: 7, color: MUTED, align: "right" });
  });
  return (await doc.save()).slice().buffer;
}
