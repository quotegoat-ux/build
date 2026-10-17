const MONEY_RE = /^(-)?\$?(\d{1,3}(?:,\d{3})+|\d*)(?:\.(\d{0,2}))?$/;

/** "$12,500.50", "(1,200)", "-40" -> cents; null when it is not an amount. */
export function parseMoney(input: string): number | null {
  let s = input.trim().replace(/\s+/g, "");
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  const m = MONEY_RE.exec(s);
  if (!m || (!m[2] && !m[3])) return null;
  const cents = Number((m[2] ?? "").replaceAll(",", "") || "0") * 100 + Number((m[3] ?? "").padEnd(2, "0"));
  return negative !== Boolean(m[1]) ? -cents : cents;
}

/** "10", "10%", "5.25" -> basis points; null when it is not a percentage. */
export function parsePercentBp(input: string): number | null {
  const m = /^(-)?(\d{1,5})(?:\.(\d{0,2}))?%?$/.exec(input.trim());
  if (!m) return null;
  const bp = Number(m[2]) * 100 + Number((m[3] ?? "").padEnd(2, "0"));
  return m[1] ? -bp : bp;
}

const usd = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatMoney(cents: number): string {
  const s = `$${usd.format(Math.abs(cents) / 100)}`;
  return cents < 0 ? `-${s}` : s;
}

/** Plain decimal for form inputs and CSV: 1250050 -> "12500.50". */
export function centsToDecimal(cents: number): string {
  const abs = Math.abs(cents);
  return `${cents < 0 ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function formatBp(bp: number): string {
  const s = (bp / 100).toFixed(2).replace(/\.?0+$/, "");
  return `${s}%`;
}
