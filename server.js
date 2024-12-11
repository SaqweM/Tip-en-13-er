const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const app = express();

app.use(express.static('public'));
app.use(bodyParser.json());

// Database setup
const db = new sqlite3.Database(':memory:');

db.serialize(() => {
  // Create tables
  db.run(`
    CREATE TABLE IF NOT EXISTS Participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      answers TEXT,
      fingerprint TEXT,
      ip TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS Questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question TEXT,
      options TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS Answers (
      question_id INTEGER PRIMARY KEY,
      correct_option INTEGER
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS Settings (
      id INTEGER PRIMARY KEY,
      allow_submissions BOOLEAN
    )
  `);

  // Insert default setting for allow_submissions
  db.run(`INSERT OR IGNORE INTO Settings (id, allow_submissions) VALUES (1, 1)`);

  // Pre-fill Questions table
  const questions = [
    {
      question: 'What is the capital of France?',
      options: ['Paris', 'Berlin', 'Madrid', 'Rome'],
    },
    {
      question: 'What is 2 + 2?',
      options: ['3', '4', '5', '6'],
    },
    {
      question: 'What is the largest planet in the Solar System?',
      options: ['Earth', 'Mars', 'Jupiter', 'Venus'],
    },
  ];
  questions.forEach(({ question, options }) => {
    db.run(`INSERT INTO Questions (question, options) VALUES (?, ?)`, [
      question,
      JSON.stringify(options),
    ]);
  });
});

// Fetch all questions and options
app.get('/get-questions-and-options', (req, res) => {
  db.all(`SELECT id, question, options FROM Questions`, (err, rows) => {
    if (err) {
      return res.status(500).send({ error: err.message });
    }
    const questions = rows.map(row => ({
      id: row.id,
      question: row.question,
      options: JSON.parse(row.options),
    }));
    res.send(questions);
  });
});

// Fetch all correct answers
app.get('/get-correct-answers', (req, res) => {
  db.all(`SELECT question_id, correct_option FROM Answers`, (err, rows) => {
    if (err) {
      return res.status(500).send({ error: err.message });
    }
    res.send(rows);
  });
});

// Submit correct answers
app.post('/submit-answers', (req, res) => {
  const { correct_answers } = req.body;

  db.serialize(() => {
    db.run(`DELETE FROM Answers`); // Clear previous answers
    correct_answers.forEach(({ question_id, correct_option }) => {
      db.run(
        `INSERT INTO Answers (question_id, correct_option) VALUES (?, ?)`,
        [question_id, correct_option]
      );
    });
    res.send({ message: 'Correct answers saved successfully.' });
  });
});

// Submit quiz with device fingerprint and IP address tracking
app.post('/submit-quiz', (req, res) => {
  const userIP = req.ip; // Get user's IP address
  const { name, answers, fingerprint } = req.body;

  // Check for existing submission by fingerprint or IP
  db.get(
    `SELECT id FROM Participants WHERE fingerprint = ? OR ip = ?`,
    [fingerprint, userIP],
    (err, row) => {
      if (err) {
        return res.status(500).send({ error: err.message });
      }

      if (row) {
        // Update existing submission
        db.run(
          `UPDATE Participants SET name = ?, answers = ?, fingerprint = ?, ip = ? WHERE id = ?`,
          [name, JSON.stringify(answers), fingerprint, userIP, row.id],
          (err) => {
            if (err) {
              return res.status(500).send({ error: err.message });
            }
            res.send({ message: 'Your previous submission has been updated.' });
          }
        );
      } else {
        // Insert new submission
        db.run(
          `INSERT INTO Participants (name, answers, fingerprint, ip) VALUES (?, ?, ?, ?)`,
          [name, JSON.stringify(answers), fingerprint, userIP],
          (err) => {
            if (err) {
              return res.status(500).send({ error: err.message });
            }
            res.send({ message: 'Your submission has been saved.' });
          }
        );
      }
    }
  );
});

// Fetch leaderboard
app.get('/leaderboard', (req, res) => {
  // Fetch correct answers
  db.all(`SELECT question_id, correct_option FROM Answers`, (err, correctRows) => {
    if (err) {
      return res.status(500).send({ error: err.message });
    }

    const correctAnswers = correctRows.reduce((acc, { question_id, correct_option }) => {
      acc[question_id] = correct_option;
      return acc;
    }, {});

    // Fetch all participants
    db.all(`SELECT name, answers FROM Participants`, (err, participantRows) => {
      if (err) {
        return res.status(500).send({ error: err.message });
      }

      const leaderboard = participantRows.map(({ name, answers }) => {
        const parsedAnswers = JSON.parse(answers || '{}');
        let score = 0;

        for (const questionId in correctAnswers) {
          if (correctAnswers[questionId] === parsedAnswers[questionId]) {
            score++;
          }
        }

        return { name, score };
      });

      // Sort leaderboard by score descending
      leaderboard.sort((a, b) => b.score - a.score);

      res.send(leaderboard);
    });
  });
});

// Calculate scores
app.get('/calculate-scores', (req, res) => {
  const { name } = req.query; // Optional query parameter to calculate for a single participant

  // Fetch correct answers
  db.all(`SELECT question_id, correct_option FROM Answers`, (err, correctRows) => {
    if (err) {
      return res.status(500).send({ error: err.message });
    }

    const correctAnswers = correctRows.reduce((acc, { question_id, correct_option }) => {
      acc[question_id] = correct_option;
      return acc;
    }, {});

    if (name) {
      // Single participant's score
      db.get(`SELECT name, answers FROM Participants WHERE name = ?`, [name], (err, participantRow) => {
        if (err) {
          return res.status(500).send({ error: err.message });
        }
        if (!participantRow) {
          return res.status(404).send({ message: 'Participant not found' });
        }

        const result = calculateParticipantScore(participantRow, correctAnswers);
        res.send(result);
      });
    } else {
      // All participants' scores
      db.all(`SELECT name, answers FROM Participants`, (err, participantRows) => {
        if (err) {
          return res.status(500).send({ error: err.message });
        }

        const results = participantRows.map(participant =>
          calculateParticipantScore(participant, correctAnswers)
        );
        res.send(results);
      });
    }
  });
});

// Helper function to calculate participant score
function calculateParticipantScore(participant, correctAnswers) {
  const { name, answers } = participant;
  const parsedAnswers = JSON.parse(answers || '{}');
  let correctCount = 0;
  let incorrectCount = 0;
  let unansweredCount = 0;

  for (const questionId in correctAnswers) {
    if (parsedAnswers.hasOwnProperty(questionId)) {
      if (parsedAnswers[questionId] === correctAnswers[questionId]) {
        correctCount++;
      } else {
        incorrectCount++;
      }
    } else {
      unansweredCount++;
    }
  }

  return {
    name,
    correct: correctCount,
    incorrect: incorrectCount,
    unanswered: unansweredCount,
  };
}

// Toggle submission status
app.post('/toggle-submission-status', (req, res) => {
  const { allow_submissions } = req.body;
  db.run(
    `UPDATE Settings SET allow_submissions = ? WHERE id = 1`,
    [allow_submissions],
    (err) => {
      if (err) {
        return res.status(500).send({ error: err.message });
      }
      res.send({ message: `Submissions have been ${allow_submissions ? 'activated' : 'deactivated'}.` });
    }
  );
});

// Fetch submission status
app.get('/get-submission-status', (req, res) => {
  db.get(`SELECT allow_submissions FROM Settings WHERE id = 1`, (err, row) => {
    if (err) {
      return res.status(500).send({ error: err.message });
    }
    res.send({ allow_submissions: !!row.allow_submissions });
  });
});

// Start server
app.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});
