import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isRoleplayMediaMessage, roleplaySystemPrompt, roleplayTurnPrompt } from '../roleplay.js';

const promptFor = (show, mode = 'serial') => roleplaySystemPrompt({
  mode,
  show,
  lang: 'Hinglish',
  characters: ['Raman Bhalla'],
});

test('link-derived role, family, and friendship facts are not sent to the model', () => {
  const prompt = promptFor('Yeh Hai Mohabbatein');
  assert.match(prompt, /no external links, curated notes, or supplied biographies are provided/);
  assert.doesNotMatch(prompt, /Mehr|Ankita Bhargava|long-standing friendship|Raman and Romi/);
  assert.match(prompt, /Use general knowledge when confident/);
});

test('private or safety-sensitive limits are explained transparently', () => {
  const prompt = promptFor('Kasturi');
  assert.match(prompt, /home address/);
  assert.match(prompt, /do not provide, confirm, infer, or help discover them/);
  assert.match(prompt, /explain that you can't help disclose that information/);
  assert.match(prompt, /Be honest about the reason/);
  assert.match(prompt, /You may step out of character/);
  assert.match(prompt, /no forced redirect or topic pivot is needed/);
  assert.match(prompt, /do not accuse the player/);
  assert.doesNotMatch(prompt, /Do not mention privacy rules/);
  assert.match(prompt, /Do not give a breadcrumb/);
});

test('AI can play multiple relevant characters but never takes over player roles', () => {
  const prompt = roleplaySystemPrompt({
    mode: 'serial',
    show: 'Yeh Hai Mohabbatein',
    lang: 'Hinglish',
    characters: ['Raman Bhalla', 'Ishita Iyer'],
  });
  assert.match(prompt, /Human players portray: Raman Bhalla, Ishita Iyer/);
  assert.match(prompt, /when two or more AI-controlled characters are present and would naturally react, let multiple of them speak in the same turn/);
  assert.match(prompt, /not every character must speak every turn/);
  assert.match(prompt, /Prioritize the latest player turn/);
  assert.match(prompt, /if that person is AI-controlled, let them answer directly/);
  assert.match(prompt, /merely talking about someone does not bring them into the scene/);
  assert.match(prompt, /Aly didn't come today/);
  assert.match(prompt, /Aly, come here/);
  assert.match(prompt, /Aly just arrived/);
  assert.match(prompt, /If presence is unclear, don't invent an entrance/);
  assert.match(prompt, /Never write dialogue, thoughts, or decisions for a human-played character/);
  assert.match(prompt, /up to about 140 words/);
});

test('latest player turn guides whether a mentioned character is present', () => {
  const request = roleplayTurnPrompt({
    transcript: 'AI: Director and co-star are speaking.\nKaran: Aly just arrived; I need to talk to you.',
    latestPlayerTurn: 'Karan: Aly just arrived; I need to talk to you.',
    first: false,
  });
  assert.match(request, /Latest player turn \(respond to this first\)/);
  assert.match(request, /Aly just arrived/);
  assert.match(request, /negative\/past\/future mention.*keeps them absent/);
  assert.match(request, /direct call.*summons them as nearby/);
  assert.match(request, /affirmative arrival.*gets an entrance and line now/);
  assert.match(request, /If presence is unclear, do not invent it/);
  assert.match(request, /have that AI-controlled character reply/);
});

test('selected show title does not inject a curated reference', () => {
  const prompt = promptFor('An unfamiliar serial');
  assert.match(prompt, /general knowledge/);
  assert.doesNotMatch(prompt, /PUBLIC CAREER REFERENCE|SELECTED TITLE REFERENCE|Credit caution/);
});

test('real-life mode is removed from app settings and UI', () => {
  const serverText = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const uiText = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

  assert.doesNotMatch(serverText, /Karan Patel's Real Life|life:\s*['"]Karan Patel's Real Life/);
  assert.doesNotMatch(uiText, /Karan Patel's Real Life|life:\s*['"]Karan Patel's Real Life/);
});

test('role-play rejects media fields and permits ordinary text-only messages', () => {
  assert.equal(isRoleplayMediaMessage({ t2: 'Hello' }), false);
  assert.equal(isRoleplayMediaMessage({ t2: 'Hello', image: 'data:image/png;base64,...' }), true);
  assert.equal(isRoleplayMediaMessage({ t2: 'Hello', attachments: [] }), true);
});
