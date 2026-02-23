/**
 * Text search utilities.
 * Uses Supabase full-text search (tsvector/tsquery) instead of vector embeddings.
 * No external API required.
 */

/**
 * Prepare text for full-text search by cleaning it up.
 */
export function prepareSearchText(text: string): string {
  return text
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Convert a user query into a tsquery-compatible format.
 * Splits by whitespace and joins with '&' for AND matching,
 * using ':*' suffix for prefix matching.
 */
export function toSearchQuery(query: string): string {
  const words = query
    .replace(/[^\w\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 2) // Skip very short words
    .map((w) => w.toLowerCase());

  if (words.length === 0) return "";

  // Use OR for broader matching with prefix support
  return words.map((w) => `${w}:*`).join(" | ");
}
