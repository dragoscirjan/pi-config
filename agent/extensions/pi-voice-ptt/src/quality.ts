/** Extra acceptance checks, not a replacement for the original voice extension's filter. */
export function transcriptProblem(text: string, locale: string | undefined): string | undefined {
  const compact = text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]/gu, '');
  // Unlike whitespace-token checks, this also catches Japanese/Chinese loops and loops after a prefix.
  for (const match of compact.matchAll(/(.{2,80}?)\1{3,}/gu)) {
    if (match[0].length >= 24 && match[0].length >= compact.length * 0.4) {
      return 'Whisper returned a repeated-text loop. Dictation was discarded; please try again.';
    }
  }
  if ((locale?.split('-')[0] ?? 'en') === 'en') {
    const letters = text.match(/\p{L}/gu) ?? [];
    const nonLatin = letters.filter((letter) => !/\p{Script=Latin}/u.test(letter)).length;
    if (nonLatin >= 6 && nonLatin >= letters.length * 0.25) {
      return 'Whisper returned text inconsistent with English. Dictation was discarded; please try again.';
    }
  }
  return undefined;
}
