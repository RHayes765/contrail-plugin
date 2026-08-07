import { randomInt } from 'node:crypto';

/**
 * Confirmation codes exist for the human-reads-and-repeats ritual (spec §5).
 * They are shown ONLY on the localhost approval page — never in a tool
 * result — so possession of one proves a human read the summary. Unambiguous
 * alphabet: no 0/O, 1/I/L.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateConfirmationCode(): string {
  const pick = () => ALPHABET[randomInt(ALPHABET.length)]!;
  const group = () => pick() + pick() + pick() + pick();
  return `${group()}-${group()}`;
}
