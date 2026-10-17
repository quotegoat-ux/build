import { parseMoney } from "./money";

export interface PastedLine {
  itemNo: string;
  description: string;
  scheduledCents: number;
}

export interface PasteResult {
  lines: PastedLine[];
  errors: { row: number; text: string }[];
}

const COMMA_ROW = /^(?<item>"[^"]*"|[^,]*),(?<description>.*?),\s*"?(?<amount>\(?-?\$?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{0,2})?\)?)"?\s*$/;

function unquote(s: string): string {
  const t = s.trim();
  return t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1).replaceAll('""', '"').trim() : t;
}

function splitRow(row: string): string[] | null {
  if (row.includes("\t")) {
    const cells = row.split("\t").map(unquote);
    while (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
    return cells;
  }
  const m = COMMA_ROW.exec(row);
  if (m?.groups) return [unquote(m.groups.item!), unquote(m.groups.description!), m.groups.amount!];
  const two = /^(?<description>.*?),\s*"?(?<amount>[^,"]*)"?\s*$/.exec(row);
  return two?.groups ? [unquote(two.groups.description!), two.groups.amount!] : null;
}

/** Accepts rows copied from Excel (tab separated) or CSV: item, description, amount; or description, amount. */
export function parseSovPaste(text: string, firstItemNo = 1): PasteResult {
  const result: PasteResult = { lines: [], errors: [] };
  const rows = text.split(/\r?\n/);
  rows.forEach((raw, index) => {
    const row = raw.replace(/^ +|[ \t]+$/g, "");
    if (!row.trim()) return;
    const cells = splitRow(row);
    const amount = cells && cells.length >= 2 ? parseMoney(cells[cells.length - 1]!) : null;
    if (!cells || amount === null) {
      if (result.lines.length === 0 && result.errors.length === 0) return;
      result.errors.push({ row: index + 1, text: row });
      return;
    }
    const [itemNo, description] = cells.length >= 3 ? [cells[0]!, cells.slice(1, -1).join(" ").trim()] : ["", cells[0]!];
    if (/^(sub)?total\b/i.test(description) || /^(sub)?total\b/i.test(itemNo)) return;
    if (!description) {
      result.errors.push({ row: index + 1, text: row });
      return;
    }
    result.lines.push({ itemNo: itemNo || String(firstItemNo + result.lines.length), description, scheduledCents: amount });
  });
  return result;
}
