export const QUIZ_QUESTION_COUNTS = [5, 10, 15, 20, 25, 30];

export const QUIZ_BANK = [
  { category: 'Early career', text: 'What was Karan Patel’s first acting role?', options: ['Vigyaat in Kahaani Ghar Ghar Kii', 'Raman Bhalla in Yeh Hai Mohabbatein', 'Robbie Sabharwal in Kasturi', 'Rishabh Bajaj in Kasautii Zindagii Kay'], correct: 'Vigyaat in Kahaani Ghar Ghar Kii' },
  { category: 'Shows & characters', text: 'Which character did Karan Patel play in Yeh Hai Mohabbatein?', options: ['Raman Bhalla', 'Romi Bhalla', 'Rishabh Bajaj', 'Robbie Sabharwal'], correct: 'Raman Bhalla' },
  { category: 'Shows & characters', text: 'In which show did Karan Patel play Robbie Sabharwal?', options: ['Kasturi', 'Kasamh Se', 'Kkavyanjali', 'Kahaani Ghar Ghar Kii'], correct: 'Kasturi' },
  { category: 'Shows & characters', text: 'Which character did Karan Patel play in the 2018 version of Kasautii Zindagii Kay?', options: ['Rishabh Bajaj', 'Anurag Basu', 'Raman Bhalla', 'Kanishk Malhotra'], correct: 'Rishabh Bajaj' },
  { category: 'Shows & characters', text: 'Who played Rishabh Bajaj in Kasautii Zindagii Kay before Karan Patel joined in 2020?', options: ['Karan Singh Grover', 'Ram Kapoor', 'Rithvik Dhanjani', 'Saurabh Raj Jain'], correct: 'Karan Singh Grover' },
  { category: 'Shows & characters', text: 'Which role is Karan Patel credited with in Kasamh Se?', options: ['Rohit Chopra', 'Jai Walia', 'Ranvijay', 'Romi Bhalla'], correct: 'Rohit Chopra' },
  { category: 'Shows & characters', text: 'Which character did Karan Patel play in Kkavyanjali?', options: ['Kanishk Malhotra', 'Kkavya Nanda', 'Soham Nanda', 'Rohit Chopra'], correct: 'Kanishk Malhotra' },
  { category: 'Films & characters', text: 'What was Karan Patel’s character called in Shootout at Wadala?', options: ['Jamal', 'Naru', 'Goli', 'Maanav'], correct: 'Jamal' },
  { category: 'Films & characters', text: 'Which character did Karan Patel play in City of Gold (Lalbaug Parel)?', options: ['Naru', 'Jamal', 'Goli', 'Radhe'], correct: 'Naru' },
  { category: 'Films & characters', text: 'In the film Phamous, what was Karan Patel’s character called?', options: ['Goli', 'Naru', 'Jamal', 'Maanav Awasthi'], correct: 'Goli' },
  { category: 'Films & characters', text: 'Which role is Karan Patel credited with in the 2023 film Darran Chhoo?', options: ['Maanav Awasthi', 'Raman Bhalla', 'Robbie Sabharwal', 'Kanishk Malhotra'], correct: 'Maanav Awasthi' },
  { category: 'Yeh Hai Mohabbatein', text: 'Who played Ishita Iyer opposite Karan Patel in Yeh Hai Mohabbatein?', options: ['Divyanka Tripathi', 'Anita Hassanandani', 'Ankita Bhargava', 'Amita Chandekar'], correct: 'Divyanka Tripathi' },
  { category: 'Yeh Hai Mohabbatein', text: 'Which actor played Shagun, Raman Bhalla’s former wife in Yeh Hai Mohabbatein?', options: ['Anita Hassanandani', 'Divyanka Tripathi', 'Ekta Kapoor', 'Ankita Bhargava'], correct: 'Anita Hassanandani' },
  { category: 'Yeh Hai Mohabbatein', text: 'What is Ishita Iyer’s profession in Yeh Hai Mohabbatein?', options: ['Dentist', 'Lawyer', 'Teacher', 'Doctor in a hospital'], correct: 'Dentist' },
  { category: 'Yeh Hai Mohabbatein', text: 'Who is Raman Bhalla’s brother in Yeh Hai Mohabbatein?', options: ['Romi (Romesh) Bhalla', 'Rohit Chopra', 'Rishabh Bajaj', 'Raunak'], correct: 'Romi (Romesh) Bhalla' },
  { category: 'Yeh Hai Mohabbatein', text: 'Who are Raman Bhalla’s parents in Yeh Hai Mohabbatein?', options: ['Omprakash and Santoshi', 'Jai and Bani', 'Purushottam and Devika', 'Om and Parvati'], correct: 'Omprakash and Santoshi' },
  { category: 'Yeh Hai Mohabbatein', text: 'Which set lists Raman and Ishita’s children in Yeh Hai Mohabbatein?', options: ['Ruhi, Aditya and Pihu', 'Kukki, Ruhi and Aditya', 'Shivani, Ruhi and Pihu', 'Nihita, Ruhi and Aditya'], correct: 'Ruhi, Aditya and Pihu' },
  { category: 'Kasturi', text: 'Who is Robbie Sabharwal’s close friend and later rival in Kasturi?', options: ['Raunak', 'Romi', 'Anurag', 'Jamal'], correct: 'Raunak' },
  { category: 'Kasautii Zindagii Kay', text: 'Who is Rishabh Bajaj’s daughter in Kasautii Zindagii Kay?', options: ['Kukki', 'Ruhi', 'Pihu', 'Shivani'], correct: 'Kukki' },
  { category: 'Friends & co-stars', text: 'Which actor often played Shagun opposite Karan Patel’s Raman and is also described in public reporting as his friend?', options: ['Anita Hassanandani', 'Amita Chandekar', 'Rithvik Dhanjani', 'Santoshi Bhalla'], correct: 'Anita Hassanandani' },
  { category: 'Family & personal life', text: 'What is Karan Patel’s publicly reported date of birth?', options: ['23 November 1983', '23 October 1985', '13 November 1983', '23 December 1981'], correct: '23 November 1983' },
  { category: 'Family & personal life', text: 'Who is Karan Patel’s wife?', options: ['Ankita Bhargava', 'Anita Hassanandani', 'Divyanka Tripathi', 'Amita Chandekar'], correct: 'Ankita Bhargava' },
  { category: 'Family & personal life', text: 'What is the publicly reported name of Karan Patel and Ankita Bhargava’s daughter?', options: ['Mehr', 'Pihu', 'Ruhi', 'Kukki'], correct: 'Mehr' },
  { category: 'Awards', text: 'For which show did Karan Patel win Zee Gold Awards for Best Actor (Popular) in 2014–2016?', options: ['Yeh Hai Mohabbatein', 'Kasturi', 'Kasamh Se', 'Kkavyanjali'], correct: 'Yeh Hai Mohabbatein' },
  { category: 'Awards', text: 'Which award did Karan Patel receive in 2015 for Best Romantic Actor (Male)?', options: ['Indian Television Academy Award', 'National Film Award', 'Filmfare Award', 'Screen Award'], correct: 'Indian Television Academy Award' },
  { category: 'Awards', text: 'How many consecutive years (2014, 2015 and 2016) did Karan Patel win the Zee Gold Award for Best Actor (Popular)?', options: ['Three years', 'One year', 'Two years', 'Five years'], correct: 'Three years' },
  { category: 'TV hosting', text: 'Which show marked Karan Patel’s debut as a television host in 2008?', options: ['Kaho Na Yaar Hai', 'Nach Baliye 7', 'Jhalak Dikhhla Jaa 6', 'Survivor India'], correct: 'Kaho Na Yaar Hai' },
  { category: 'Reality shows', text: 'In which season of Jhalak Dikhhla Jaa did Karan Patel participate in 2013?', options: ['Season 6', 'Season 3', 'Season 7', 'Season 10'], correct: 'Season 6' },
  { category: 'Reality shows', text: 'What was Karan Patel’s result on Khatron Ke Khiladi 10?', options: ['Runner-up', 'Winner', 'Host', 'Wildcard judge'], correct: 'Runner-up' },
  { category: 'Reality shows', text: 'Who competed with Karan Patel as his partner on Nach Baliye 3?', options: ['Amita Chandekar', 'Anita Hassanandani', 'Ankita Bhargava', 'Divyanka Tripathi'], correct: 'Amita Chandekar' },
  { category: 'Reality shows', text: 'Who co-hosted Nach Baliye 7 with Karan Patel?', options: ['Rithvik Dhanjani', 'Rohit Shetty', 'Sameer Kochhar', 'Virender Sehwag'], correct: 'Rithvik Dhanjani' },
  { category: 'Reality shows', text: 'Who hosted Khatron Ke Khiladi 10, where Karan Patel was a contestant?', options: ['Rohit Shetty', 'Sameer Kochhar', 'Rithvik Dhanjani', 'Virender Sehwag'], correct: 'Rohit Shetty' },
];

export function buildQuiz(questionCount, random = Math.random) {
  if (!QUIZ_QUESTION_COUNTS.includes(questionCount) || questionCount > QUIZ_BANK.length) {
    throw new RangeError(`Choose a quiz with ${QUIZ_QUESTION_COUNTS.filter(count => count <= QUIZ_BANK.length).join(', ')} questions.`);
  }
  const questions = [...QUIZ_BANK];
  for (let i = questions.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [questions[i], questions[j]] = [questions[j], questions[i]];
  }
  return questions.slice(0, questionCount).map(question => {
    const options = [...question.options];
    for (let i = options.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [options[i], options[j]] = [options[j], options[i]];
    }
    return { category: question.category, text: question.text, options, correctIndex: options.indexOf(question.correct) };
  });
}

export function submitQuizAnswer(quiz, uid, choice) {
  const question = quiz.questions[quiz.index];
  if (!question || quiz.revealed || quiz.currentAnswers.has(uid) || !Number.isInteger(choice) || choice < 0 || choice >= question.options.length) return false;
  quiz.currentAnswers.set(uid, choice);
  return true;
}

export function revealQuizQuestion(quiz, players) {
  if (quiz.revealed || !quiz.questions[quiz.index]) return false;
  const question = quiz.questions[quiz.index];
  for (const [uid] of players) {
    const choice = quiz.currentAnswers.get(uid);
    const score = quiz.scores.get(uid);
    if (!score) continue;
    const correct = choice === question.correctIndex;
    score.answered += choice === undefined ? 0 : 1;
    if (correct) score.correct += 1;
    score.details.push([
      `Q${quiz.index + 1}: ${question.text}`,
      choice === undefined ? 'No answer' : correct ? 'Correct' : 'Incorrect',
      choice === undefined ? `Correct answer: ${question.options[question.correctIndex]}` : `Your answer: ${question.options[choice]} | Correct answer: ${question.options[question.correctIndex]}`,
    ]);
  }
  quiz.revealed = true;
  return true;
}

export function quizPlayerResult(quiz, uid) {
  const score = quiz.scores.get(uid) || { correct: 0, answered: 0, details: [] };
  const pct = score.correct / quiz.questions.length * 100;
  return {
    pct,
    verdict: pct >= 85 ? 'Outstanding' : pct >= 70 ? 'Very good' : pct >= 55 ? 'Good' : pct >= 40 ? 'Average' : 'Needs practice',
    det: score.details,
    strengths: [`Answered ${score.answered} of ${quiz.questions.length} questions.`, `${score.correct} answer${score.correct === 1 ? '' : 's'} correct.`],
    improve: score.correct < quiz.questions.length ? ['Review the questions answered incorrectly or skipped.'] : [],
    note: '',
    extra: `Quiz score: ${score.correct} correct out of ${quiz.questions.length} questions. Unanswered questions count as incorrect.`,
  };
}
