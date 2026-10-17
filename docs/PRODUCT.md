# Drawbook

Pay applications and lien waivers for specialty subcontractors.

## Problem

Subcontractors wait an average of 56 days after submitting a pay application, and 92% floated payroll from their own pockets last year. Pay application errors are the top internal cause of late payment, and 67% of subs spend 11 or more hours a month building them, mostly in Excel. Sources and scoring are in `/mnt/project-files/research/01-problem-ranking.md`.

The incumbents leave the small sub uncovered. Siteline is the only sub-native tool and sells custom annual contracts to larger subs. Levelset and Knowify charge $99 to $149 per user. GCPay and Textura belong to the GC, and Textura bills the sub a percentage of the contract. The top complaints across the market are opaque pricing with renewal shocks, contract lock-in, and no bulk data export. Sources are in `/mnt/project-files/research/02-incumbents.md`.

## Customer

The owner or office manager at a specialty subcontractor (electrical, mechanical, drywall, concrete) with 5 to 50 field staff, running QuickBooks and Excel, billing 2 to 10 progress pay applications a month.

## Offer

$89 a month per company. Unlimited users and projects. No contract, cancel in the app. 14-day trial with no card. One-click export of every record.

## Day-one product

1. **Projects.** GC, owner, job name and location, state, original contract sum, retainage percentages for work and stored materials, first and last furnishing dates.
2. **Schedule of values.** Lines with item number, description, and scheduled value. Paste from Excel.
3. **Change orders.** Pending, approved, or rejected. An approved change order adds a line to the schedule of values and raises the contract sum to date.
4. **Pay applications.** One per period. The sub enters work completed this period and materials presently stored per line. Prior-period totals carry forward. The app computes the G702 summary and G703 continuation sheet, validates the draft (overbilling past 100%, negative values, billing past the contract sum), and tracks status from draft to submitted to paid, with the amount and date paid.
5. **Documents.** A PDF of the Application and Certificate for Payment with its continuation sheet, plus CSV export.
6. **Lien waivers.** Conditional progress waiver on submit, unconditional progress waiver on payment, final waivers on the last application. Statutory text for states that mandate it, generic text elsewhere, with an attorney-review disclaimer.
7. **Lien deadlines.** Preliminary notice and lien filing deadlines computed from the project state and furnishing dates, shown on the dashboard.
8. **Dashboard.** Amount outstanding, retainage held, days outstanding per application, upcoming deadlines.
9. **GC share link.** A read-only tokenized page where the GC can view and download the packet without an account.

## Pay application math

Money is stored as integer cents. For each schedule-of-values line in period `n`:

- C, scheduled value.
- D, work completed in all prior periods.
- E, work completed this period.
- F, materials presently stored, entered as the current balance.
- G = D + E + F, total completed and stored to date.
- G / C, percent complete.
- H = C - G, balance to finish.
- I, retainage = round(retainage_work_pct × (D + E)) + round(retainage_stored_pct × F).

G702 summary:

1. Original contract sum.
2. Net change by approved change orders.
3. Contract sum to date = 1 + 2.
4. Total completed and stored to date = sum of G.
5. Retainage = sum of I.
6. Total earned less retainage = 4 - 5.
7. Less previous certificates for payment = line 6 of the prior application.
8. Current payment due = 6 - 7.
9. Balance to finish including retainage = 3 - 6.
