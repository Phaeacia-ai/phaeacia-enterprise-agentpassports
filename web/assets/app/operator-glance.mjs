/* The glance at the top of the register (HOSTED-F2, evidence/operator-landing.md; item 3 of the brief, the lead's design).
   Raffael, 2026-09-21, as the operator: "nothing takes me there and there's no quick glanceable thing."

   Pure functions over the rows GET /api/operator/companies answered, and nothing else: no route and no field was added
   for the glance, so what the rows do not carry the glance does not say. Each piece stands alone, so any one of them can
   be kept, dropped or moved without touching the others; pages/operator.mjs draws them:

     statusSummary, statusSentence    how many companies, by status;
     endingSoonest                    the agreements ending soonest, each with its company, end date and days, soonest
                                      first; "Ending soon" at 30 days or fewer, "Ended" once the agreement has ended;
     needsYou                         what needs the operator, as far as the rows show it;
     daysLeft, daysText, orderRows    the register table's days column and its two orders.

   Days are whole calendar days in UTC, the way the operator pages word dates (lifecycle-view.mjs dayText), counted from
   the device's date to the stored end date. Whether an agreement has ended is the service's word (accessPeriod.state
   export_window or expired, the same the table's Access column shows), not the device clock's; the device's count is
   held to the service's side of that line, so the glance never says an agreement ended that the table calls current,
   or the reverse. A closed company is left out of the soonest list: its agreement is over and what remains is its
   deletion, which needsYou names.

   What the rows cannot supply: whose an open invitation is (counts.invitationsPending counts every role), so "no
   administrator yet" is said with the number of open invitations and never as "an administrator is invited"; and
   anything beyond the pages read so far, so the page says when more pages follow. */

import { COMPANY_STATUSES, dayText, statusWord } from './lifecycle-view.mjs';

export const ENDING_SOON_DAYS = 30;
export const SOONEST_SHOWN = 5;
export const ORDERS = Object.freeze(['ending', 'service']);

const DAY = 86_400_000;
const ENDED_STATES = new Set(['export_window', 'expired']);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const endOf = (row) => {
  const at = Date.parse(row?.accessPeriod?.endsAt ?? '');
  return Number.isNaN(at) ? null : at;
};

/** Whether the service says this agreement has ended. */
export const hasEnded = (period) => ENDED_STATES.has(period?.state);

/** Whole UTC calendar days from `now` (milliseconds) to the period's end date: positive ahead, negative past, 0 today;
    null without an end date. Held to the service's word: never below 0 while the agreement is current, never above 0
    once it has ended. */
export function daysLeft(period, now) {
  const end = Date.parse(period?.endsAt ?? '');
  if (Number.isNaN(end) || !Number.isFinite(now)) return null;
  const days = Math.floor(end / DAY) - Math.floor(now / DAY);
  return hasEnded(period) ? Math.min(days, 0) : Math.max(days, 0);
}

/** The warning word, as text and never as colour alone: "Ended", "Ending soon" at 30 days or fewer, or null. */
export function agreementWord(period, days) {
  if (hasEnded(period)) return 'Ended';
  return days !== null && days <= ENDING_SOON_DAYS ? 'Ending soon' : null;
}

/** The days as the table's cell says them. */
export function daysText(period, days) {
  if (days === null) return 'No end date';
  if (hasEnded(period)) return days === 0 ? 'Ended today' : `Ended ${plural(-days, 'day', 'days')} ago`;
  return days === 0 ? 'Ends today' : `${plural(days, 'day', 'days')} left`;
}

/** One agreement of the soonest list as a sentence: "Ends 17 November 2026: 56 days left." */
export function endingSentence(period, days) {
  const date = dayText(period?.endsAt) ?? 'a date this page was not given';
  if (hasEnded(period)) return days === 0 ? `Ended today, ${date}.` : `Ended ${date}: ${plural(-days, 'day', 'days')} ago.`;
  return days === 0 ? `Ends today, ${date}.` : `Ends ${date}: ${plural(days, 'day', 'days')} left.`;
}

/** How many companies by status: { total, counts: [[status, n], ...] }, the known statuses in their order and any other
    status after them as the rows name it; a status no row has is left out. */
export function statusSummary(rows) {
  const tally = new Map(COMPANY_STATUSES.map((s) => [s, 0]));
  for (const row of rows) tally.set(String(row?.status), (tally.get(String(row?.status)) ?? 0) + 1);
  return { total: rows.length, counts: [...tally].filter(([, n]) => n > 0) };
}

/** "4 companies: 2 active, 1 suspended, 1 closed." */
export function statusSentence({ total, counts }) {
  if (total === 0) return 'No companies yet.';
  return `${plural(total, 'company', 'companies')}: ${counts.map(([s, n]) => `${n} ${statusWord(s).toLowerCase()}`).join(', ')}.`;
}

/** The agreements ending soonest: { items: [{ row, days, word, sentence }], later } where items are the first `shown`
    companies with an end date, soonest end first (an ended one before one still running), closed companies left out,
    and `later` counts the ones with an end date not shown. */
export function endingSoonest(rows, now, shown = SOONEST_SHOWN) {
  const dated = rows.filter((row) => row?.status !== 'closed' && endOf(row) !== null);
  const sorted = [...dated].sort((a, b) => endOf(a) - endOf(b));
  const items = sorted.slice(0, shown).map((row) => {
    const days = daysLeft(row.accessPeriod, now);
    return { row, days, word: agreementWord(row.accessPeriod, days), sentence: endingSentence(row.accessPeriod, days) };
  });
  return { items, later: sorted.length - items.length };
}

/** What a company's row says needs the operator, in a fixed order; empty when nothing does. */
export function needsOf(row) {
  const period = row?.accessPeriod ?? {};
  const out = [];
  if (period.deletionState === 'overdue') out.push(`Deletion overdue since ${dayText(period.deleteBy) ?? 'a date this page was not given'}`);
  if (period.deletionState === 'due') out.push(`Deletion due by ${dayText(period.deleteBy) ?? 'a date this page was not given'}`);
  if (row?.status === 'suspended') out.push('Suspended');
  if (row?.status === 'held') out.push('Held after a restore');
  if (row?.status === 'active' && period.state === 'expired') out.push('Reading window closed and not yet suspended by the sweep');
  if (row?.status !== 'closed' && (period.state === 'none' || !row?.accessPeriod)) out.push('No agreement dates');
  const admins = row?.counts?.admins;
  const pending = row?.counts?.invitationsPending;
  if (row?.status === 'active' && admins === 0)
    out.push(Number.isInteger(pending) && pending > 0 ? `No administrator yet; ${plural(pending, 'open invitation', 'open invitations')}` : 'No administrator yet and no open invitation');
  return out;
}

/** The companies whose rows say something needs the operator, in the order the rows came: [{ row, reasons }]. */
export function needsYou(rows) {
  return rows.map((row) => ({ row, reasons: needsOf(row) })).filter((x) => x.reasons.length > 0);
}

/** The table's rows in one of the two orders: 'ending', soonest end date first with the companies that have none after
    them, or 'service', the order the routine sent (deletion eligible, due and overdue first, then by id). A new array;
    ties keep the service's order. */
export function orderRows(rows, order) {
  if (order !== 'ending') return [...rows];
  const key = (row) => endOf(row) ?? Number.POSITIVE_INFINITY;
  return [...rows].sort((a, b) => (key(a) === key(b) ? 0 : key(a) < key(b) ? -1 : 1));
}
