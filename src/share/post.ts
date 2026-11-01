// POST ON X: one ready tweet, a plain link to x.com/intent/post (the X app on a phone), so the tap itself opens X: no
// share sheet, no download, no copy. CARD_SERVICE is THE WALL ARCADE's own service (people.json, stats, the jackpot).
export const CARD_SERVICE = 'https://wall-arcade-cards.netlify.app';

export const intentHref = (text: string): string => `https://x.com/intent/post?text=${encodeURIComponent(text)}`;

/** X counts every link as 23 characters. */
const weighted = (text: string, link: string): number => text.replace(link, '').length + 23;
/**
 * The tweet `before(names) + link`, at most 280 characters as X counts them: names are dropped from the end (with " …")
 * until it fits. Repeated handles are written once.
 */
export function fitTweet(names: string[], build: (names: string, more: boolean) => string, link: string): string {
  const unique = [...new Set(names)];
  for (let n = unique.length; n >= 0; n--) {
    const text = build(unique.slice(0, n).join(' · '), n < unique.length);
    if (weighted(text, link) <= 280) return text;
  }
  return build('', true);
}
/** "@handle" when the panel has one, else the name as painted on the wall. */
export const tag = (name: string, handle: string): string => (handle ? `@${handle}` : name.toUpperCase());
