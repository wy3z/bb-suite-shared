const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function shortAge(from: number | string, now: number = Date.now()): string {
  const at = typeof from === "number" ? from : Date.parse(from);
  if (!Number.isFinite(at)) return "";
  const ms = Math.max(0, now - at);
  if (ms < MINUTE) return "now";
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h`;
  if (ms < 7 * DAY) return `${Math.floor(ms / DAY)}d`;
  if (ms < 30 * DAY) return `${Math.floor(ms / (7 * DAY))}w`;
  if (ms < 365 * DAY) return `${Math.floor(ms / (30 * DAY))}mo`;
  return `${Math.floor(ms / (365 * DAY))}y`;
}

export function duration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function elapsed(from: number | string, now: number = Date.now()): string {
  const at = typeof from === "number" ? from : Date.parse(from);
  return duration(Number.isFinite(at) ? (now - at) / 1000 : 0);
}
