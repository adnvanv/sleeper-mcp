/**
 * Minimal RSS 2.0 parser: enough for news feeds (title, link, description,
 * guid, pubDate). No dependencies; handles CDATA and the common entities.
 */

export interface RssItem {
  guid: string;
  title: string;
  link: string;
  description: string;
  pubDate: string;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === "#") {
      const n =
        code[1].toLowerCase() === "x"
          ? parseInt(code.slice(2), 16)
          : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

function tag(block: string, name: string): string {
  const m = block.match(
    new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"),
  );
  if (!m) return "";
  let value = m[1].trim();
  const cdata = value.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (cdata) value = cdata[1];
  else value = decodeEntities(value);
  // strip any markup left in descriptions and squash whitespace
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseRss(xml: string): RssItem[] {
  const items: RssItem[] = [];
  for (const m of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const block = m[1];
    const link = tag(block, "link");
    items.push({
      guid: tag(block, "guid") || link,
      title: tag(block, "title"),
      link,
      description: tag(block, "description"),
      pubDate: tag(block, "pubDate"),
    });
  }
  return items;
}

/**
 * Parse RSS dates. Handles RFC 822 dates with US zone names such as
 * "Thu, 12 Nov 2026 4:39:00 PM PST", which Date.parse rejects as written.
 */
const ZONES: Record<string, string> = {
  EST: "-0500",
  EDT: "-0400",
  CST: "-0600",
  CDT: "-0500",
  MST: "-0700",
  MDT: "-0600",
  PST: "-0800",
  PDT: "-0700",
  GMT: "+0000",
  UTC: "+0000",
};

export function parseRssDate(value: string): string | null {
  if (!value) return null;
  const direct = Date.parse(value);
  if (!Number.isNaN(direct)) return new Date(direct).toISOString();
  const m = value.match(
    /(\d{1,2}) (\w{3}) (\d{4}) (\d{1,2}):(\d{2})(?::(\d{2}))? ?(AM|PM)? ?([A-Z]{3}|[+-]\d{4})?/i,
  );
  if (!m) return null;
  const [, day, mon, year, hh, mm, ss = "0", ampm, zone = "GMT"] = m;
  let hour = Number(hh) % 12;
  if (!ampm) hour = Number(hh);
  else if (ampm.toUpperCase() === "PM") hour += 12;
  const offset = ZONES[zone.toUpperCase()] || zone;
  const iso = `${day} ${mon} ${year} ${String(hour).padStart(2, "0")}:${mm}:${ss.padStart(2, "0")} ${offset}`;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}
