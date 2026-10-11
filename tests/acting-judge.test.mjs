import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTING_CRITERIA, actingJudgePrompt } from '../acting-judge.js';

test('role-play scoring prioritizes character portrayal and in-character interaction', () => {
  const totalWeight = ACTING_CRITERIA.reduce((sum, [, , weight]) => sum + weight, 0);
  assert.equal(totalWeight, 1);
  assert.deepEqual(ACTING_CRITERIA.slice(0, 2).map(([, , weight]) => weight), [0.4, 0.25]);
});

test('judge gets the selected role, the player lines, and full-scene context separately', () => {
  const prompt = actingJudgePrompt({
    character: 'Raman Bhalla',
    scenario: 'SCENARIO: The serial "Yeh Hai Mohabbatein".',
    notes: 'Protective toward his family.',
    lines: 'Raman Bhalla: (concerned) Ruhi, main tumhare saath hoon.',
    transcript: 'AI: Ruhi looks worried.\nRaman Bhalla: (concerned) Ruhi, main tumhare saath hoon.',
  });

  assert.match(prompt, /player's chosen role is "Raman Bhalla"/);
  assert.match(prompt, /Prioritize role fidelity/);
  assert.match(prompt, /respond naturally to what other characters actually said/);
  assert.match(prompt, /Player lines to score:[\s\S]*Raman Bhalla: \(concerned\)/);
  assert.match(prompt, /Full scene transcript for context:[\s\S]*AI: Ruhi looks worried/);
  assert.match(prompt, /Protective toward his family/);
  assert.match(prompt, /Do not reward message quantity by itself/);
});
