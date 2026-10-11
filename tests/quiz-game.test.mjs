import test from 'node:test';
import assert from 'node:assert/strict';
import { QUIZ_BANK, QUIZ_QUESTION_COUNTS, buildQuiz, submitQuizAnswer, revealQuizQuestion, quizPlayerResult } from '../quiz-game.js';

test('quiz bank covers requested Karan Patel topics with four-option questions', () => {
  assert.ok(QUIZ_BANK.length >= 30);
  assert.deepEqual(QUIZ_QUESTION_COUNTS, [5, 10, 15, 20, 25, 30]);
  for (const question of QUIZ_BANK) {
    assert.equal(question.options.length, 4);
    assert.equal(new Set(question.options).size, 4);
    assert.ok(question.options.includes(question.correct));
  }
  for (const category of ['Friends & co-stars', 'Family & personal life', 'Awards', 'Yeh Hai Mohabbatein', 'Shows & characters']) {
    assert.ok(QUIZ_BANK.some(question => question.category === category));
  }
});

test('quiz builder selects unique questions and shuffles options with correct indices', () => {
  const quiz = buildQuiz(10, () => 0.25);
  assert.equal(quiz.length, 10);
  assert.equal(new Set(quiz.map(question => question.text)).size, 10);
  for (const question of quiz) {
    assert.equal(question.options[question.correctIndex], QUIZ_BANK.find(item => item.text === question.text).correct);
  }
  assert.throws(() => buildQuiz(7), RangeError);
  assert.throws(() => buildQuiz(35), RangeError);
});

test('players can answer once and are scored only after a question is revealed', () => {
  const question = { text: 'Question', options: ['wrong', 'right'], correctIndex: 1 };
  const quiz = {
    questions: [question],
    index: 0,
    currentAnswers: new Map(),
    revealed: false,
    scores: new Map([[1, { correct: 0, answered: 0, details: [] }], [2, { correct: 0, answered: 0, details: [] }]]),
  };
  const players = [[1, {}], [2, {}]];

  assert.equal(submitQuizAnswer(quiz, 1, 1), true);
  assert.equal(submitQuizAnswer(quiz, 1, 0), false);
  assert.equal(submitQuizAnswer(quiz, 2, 0), true);
  assert.equal(revealQuizQuestion(quiz, players), true);
  assert.equal(submitQuizAnswer(quiz, 2, 1), false);
  assert.equal(revealQuizQuestion(quiz, players), false);
  assert.equal(quizPlayerResult(quiz, 1).pct, 100);
  assert.equal(quizPlayerResult(quiz, 2).pct, 0);
});
