// Minimal, dependency-free word filter. It's intentionally basic — a starting
// point, not a moderation system.

const BLOCKED = [
  'fuck', 'shit', 'bitch', 'asshole', 'bastard', 'slut', 'whore', 'cunt',
  'faggot', 'nigger', 'nigga'
];

function cleanText(text) {
  let out = text;
  for (const word of BLOCKED) {
    const re = new RegExp(`\\b${word}\\b`, 'gi');
    out = out.replace(re, '*'.repeat(word.length));
  }
  return out;
}

module.exports = { cleanText };
