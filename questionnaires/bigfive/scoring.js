// Adapted from @bigfive-org/score@1.2.2, used by the pinned upstream web app.
// MIT, Copyright (c) 2024 B5 Holding AS. See LICENSE and SOURCE.md.
export const SCORING_VERSION = "@bigfive-org/score@1.2.2";
export const DOMAINS = Object.freeze(["N", "E", "O", "A", "C"]);

function classification(score, count) {
  const average = score / count;
  if (average > 3) return "high";
  if (average < 3) return "low";
  return "neutral";
}

export function scoreBigFive(answers) {
  if (!Array.isArray(answers) || answers.length !== 120) {
    throw new Error("BIGFIVE_ANSWERS_INCOMPLETE");
  }
  const ids = new Set();
  const result = {};
  for (const answer of answers) {
    if (!answer || typeof answer.id !== "string" || ids.has(answer.id) ||
        !DOMAINS.includes(answer.domain) ||
        !Number.isInteger(answer.facet) || answer.facet < 1 || answer.facet > 6 ||
        !Number.isInteger(answer.score) || answer.score < 1 || answer.score > 5) {
      throw new Error("BIGFIVE_ANSWER_INVALID");
    }
    ids.add(answer.id);
    const domain = result[answer.domain] ||= { score: 0, count: 0, result: "neutral", facet: {} };
    domain.score += answer.score;
    domain.count++;
    const facet = domain.facet[answer.facet] ||= { score: 0, count: 0, result: "neutral" };
    facet.score += answer.score;
    facet.count++;
  }
  for (const name of DOMAINS) {
    const domain = result[name];
    if (!domain || domain.count !== 24) throw new Error("BIGFIVE_DOMAIN_INCOMPLETE");
    domain.result = classification(domain.score, domain.count);
    for (let number = 1; number <= 6; number++) {
      const facet = domain.facet[number];
      if (!facet || facet.count !== 4) throw new Error("BIGFIVE_FACET_INCOMPLETE");
      facet.result = classification(facet.score, facet.count);
    }
  }
  return result;
}
