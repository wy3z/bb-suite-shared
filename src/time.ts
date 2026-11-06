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

export function longAge(from: number | string, now: number = Date.now()): string {
  const at = typeof from === "number" ? from : Date.parse(from);
  const seconds = Math.max(0, Math.floor((now - (Number.isFinite(at) ? at : now)) / 1000));
  if (seconds < 60) return "just now";
  const [amount, unit] =
    seconds < 3_600
      ? [Math.floor(seconds / 60), "minute"]
      : seconds < 86_400
        ? [Math.floor(seconds / 3_600), "hour"]
        : seconds < 604_800
          ? [Math.floor(seconds / 86_400), "day"]
          : seconds < 2_592_000
            ? [Math.floor(seconds / 604_800), "week"]
            : seconds < 31_536_000
              ? [Math.floor(seconds / 2_592_000), "month"]
              : [Math.floor(seconds / 31_536_000), "year"];
  return `${amount} ${unit}${amount === 1 ? "" : "s"} ago`;
}

export function shortAgo(from: number | string, now: number = Date.now()): string {
  const age = shortAge(from, now);
  return age === "now" ? "just now" : `${age} ago`;
}
