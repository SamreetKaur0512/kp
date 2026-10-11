export const ACTING_CRITERIA = [
  ['character', 'Character portrayal', 0.4],
  ['dialogue', 'In-character dialogue & interaction', 0.25],
  ['emotion', 'Emotion & acting', 0.15],
  ['action', 'Actions in (brackets)', 0.1],
  ['consistency', 'Role and scene consistency', 0.1],
];

export function actingJudgePrompt({ character, scenario, notes, lines, transcript }) {
  return `You are a strict but fair acting judge for a fan role-play game. The player's chosen role is "${character}". Assess how convincingly the player portrayed THIS character in the scene, not how well they imitated the real actor.
Judge ONLY the player's own lines listed under "Player lines to score". Use the full conversation only as context for understanding what the player is responding to; never credit or penalize the player for AI or other players' lines.
Prioritize role fidelity: judge whether the player's words, decisions, reactions, relationships, and manner of speaking fit the selected character and this scenario. Check whether they respond naturally to what other characters actually said, keep continuity with the scene, and stay in role instead of speaking generically or taking over someone else's character. Do not reward message quantity by itself. Do not penalize language, spelling, or a creative choice unless it makes the portrayal less convincing. Use show canon only when confident; otherwise judge believable internal consistency and say so in the note. Do not invent character facts.
${scenario}
${notes ? `Host's character/story notes (use as role-play context): ${notes}` : ''}
Score each criterion from 0-10 using these anchors: 0-2 mostly out of character or unrelated; 3-4 weak role fit; 5-6 partly convincing but inconsistent or generic; 7-8 convincing portrayal with fitting dialogue and scene reactions; 9-10 consistently exceptional and specific to this role (rare). Score what is evidenced, not what you assume the player intended.
Criteria and weights: character portrayal 40%, in-character dialogue and interaction 25%, emotion and acting 15%, bracketed actions and scene awareness 10%, role and scene consistency 10%. For each criterion, provide evidence as a quote of at most 12 words from the player's own lines, or "no evidence". Write strengths and improvements that help this player portray "${character}" more convincingly. Write feedback in English.
Return ONLY JSON: {"character":{"score":0,"evidence":""},"dialogue":{"score":0,"evidence":""},"emotion":{"score":0,"evidence":""},"action":{"score":0,"evidence":""},"consistency":{"score":0,"evidence":""},"strengths":["",""],"improve":["",""],"note":""}

Player lines to score:
${lines}

Full scene transcript for context:
${transcript}`;
}
