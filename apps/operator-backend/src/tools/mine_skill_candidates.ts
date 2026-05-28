import { mineSkillCandidates } from "../improvement/skill_candidate_miner.js";

const minOccurrence = Number(process.env.OPERATOR_SKILL_MINER_MIN_OCCURRENCE ?? "2");
const minImpact = Number(process.env.OPERATOR_SKILL_MINER_MIN_IMPACT ?? "55");
const limit = Number(process.env.OPERATOR_SKILL_MINER_LIMIT ?? "5");

const candidates = mineSkillCandidates({
  min_occurrence_count: Number.isFinite(minOccurrence) ? minOccurrence : 2,
  min_impact_score: Number.isFinite(minImpact) ? minImpact : 55,
  limit: Number.isFinite(limit) ? limit : 5
});

console.log(
  JSON.stringify(
    {
      generated: candidates.length,
      candidates
    },
    null,
    2
  )
);
