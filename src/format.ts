export const money = (value: number) => `${new Intl.NumberFormat('en-US', {
  minimumFractionDigits: value < 1 ? 4 : 2, maximumFractionDigits: value < 1 ? 4 : 2,
}).format(value)} GEN`;

export const compactMoney = (value: number) => `${new Intl.NumberFormat('en-US', {
  notation: 'compact', maximumFractionDigits: 1,
}).format(value)} GEN`;

/** Every timestamp in the UI is rendered in UTC and labelled as such. */
export const utc = (value: string) => `${new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC',
}).format(new Date(value))} UTC`;

export const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;

export const titleCase = (value: string) => value.replaceAll('_', ' ').replace(/\b\w/g, (match) => match.toUpperCase());
