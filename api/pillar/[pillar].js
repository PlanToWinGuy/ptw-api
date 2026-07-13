import { sql, pillarIdFromName, PILLARS } from '../../lib/db.js';
import { cors } from '../../lib/cors.js';
import { getUserFromRequest } from '../../lib/auth.js';
import { getPillarState } from '../../lib/pillarState.js';

// Static per-pillar activation questionnaires. These are fixed UI copy, not user data or
// AI output, so they live here as config rather than in the database.
const QUESTIONS = {
  Fitness: [
    { key: 'primary_goal', type: 'text', q: 'What is your most important goal for Fitness right now?' },
    { key: 'activity_type', type: 'single', q: 'What type of exercise do you enjoy the most?', options: ['Strength Training', 'Bodyweight & Calisthenics', 'Cardio & Endurance', 'Flexibility & Mindful Movement'] },
    { key: 'equipment', type: 'single', q: 'What equipment do you have access to?', options: ['Full Gym', 'Basic Home Gym', 'Bodyweight Only'] },
    { key: 'weekly_days', type: 'slider', q: 'Realistically, how many days per week can you dedicate to exercise?', min: 1, max: 7 },
    { key: 'experience', type: 'single', q: "What's your current experience level with this type of exercise?", options: ['Beginner', 'Intermediate', 'Advanced'] },
    { key: 'time_of_day', type: 'single', q: "What's your preferred time of day for exercising?", options: ['Early Morning (6-9am)', 'Mid-Morning (9am-12pm)', 'Early Afternoon (12-3pm)', 'Late Afternoon (3-6pm)', 'Evening (6-9pm)', 'Flexible'] },
    { key: 'notes', type: 'textarea', q: "Anything else I should know? (e.g. 'I have a sensitive lower back', 'I want to focus on my arms')" },
  ],
  Diet: [
    { key: 'primary_goal', type: 'single', q: 'What is your most important goal for your Diet right now?', options: ['Lose Weight', 'Gain Muscle', 'Eat Healthier / More Balanced', 'Improve Energy Levels', 'Manage a Health Condition'] },
    { key: 'restrictions', type: 'multi', q: 'Do you follow a specific dietary approach or have any hard restrictions?', options: ['No Restrictions', 'Vegetarian', 'Vegan', 'Gluten-Free', 'Dairy-Free'] },
    { key: 'challenge', type: 'single', q: 'What is your single biggest challenge when it comes to eating well?', options: ['Snacking & Cravings', 'Portion Control', 'Eating Out / Takeaways', 'Finding Time to Cook', 'Lack of Healthy Recipes'] },
    { key: 'cooking_habits', type: 'single', q: 'How often are you willing to cook or prepare your own meals?', options: ['Most Days', 'A Few Times a Week', 'Rarely'] },
    { key: 'knowledge', type: 'single', q: "What's your current knowledge level about nutrition?", options: ['Beginner', 'Intermediate', 'Advanced'] },
    { key: 'meal_structure', type: 'single', q: 'How do you prefer to structure your daily meals?', options: ['3 Main Meals', '5-6 Smaller Meals', 'Intermittent Fasting (16:8)'] },
    { key: 'notes', type: 'textarea', q: "Any specific foods you dislike or anything else I should know? (e.g. 'I hate broccoli', 'I'm allergic to peanuts')" },
  ],
  Finances: [
    { key: 'primary_goal', type: 'single', q: 'What is your most important financial goal right now?', options: ['Get Out of Debt', 'Save for a Large Purchase', 'Build an Emergency Fund', 'Start Investing', 'Increase My Income'] },
    { key: 'awareness', type: 'single', q: 'How well do you currently track your income and expenses?', options: ['I track everything closely', 'I have a general idea', "I don't track it at all", 'I want to start tracking'] },
    { key: 'challenge', type: 'single', q: 'What is your single biggest challenge when it comes to your finances?', options: ['Overspending on non-essentials', 'Sticking to a budget', 'Not knowing how to invest', 'Living paycheck-to-paycheck', 'Dealing with unexpected expenses'] },
    { key: 'income_stability', type: 'single', q: 'Which best describes your primary source of income?', options: ['Stable Salary', 'Variable / Freelance', 'Commission-Based', 'Currently No Income'] },
    { key: 'knowledge', type: 'single', q: "What's your current knowledge level about personal finance?", options: ['Beginner', 'Intermediate', 'Advanced'] },
    { key: 'risk_tolerance', type: 'single', q: 'When it comes to investing, which approach sounds most like you?', options: ['Conservative', 'Balanced', 'Aggressive', "I'm not ready to invest yet"] },
    { key: 'notes', type: 'textarea', q: "Anything else I should know about your financial situation? (e.g. 'I have student loans', 'I support my family')" },
  ],
  Relations: [
    { key: 'focus_area', type: 'single', q: 'Which area of your relationships would you like to focus on first?', options: ['Romantic Partner', 'Family', 'Friendships', 'Professional Network'] },
    { key: 'desired_outcome', type: 'single', q: 'What is the primary outcome you\'re hoping for in this area?', options: ['Deeper Connection & Intimacy', 'More Quality Time', 'Better Communication', 'Expanding My Social Circle'] },
    { key: 'challenge', type: 'single', q: 'What is the single biggest challenge holding you back in your relationships?', options: ['Not Enough Time / Too Busy', 'Difficulty Expressing Myself', 'Social Anxiety or Shyness', 'Resolving Past Conflicts', 'Meeting New People'] },
    { key: 'connection_style', type: 'single', q: 'How do you naturally prefer to show you care for someone?', options: ['Quality Time', 'Words of Affirmation', 'Acts of Service', 'Gift Giving'] },
    { key: 'initiative_style', type: 'single', q: 'When it comes to making plans or reaching out, what is your typical style?', options: ['I usually take the initiative', "It's about 50/50", 'I tend to wait for others to reach out'] },
    { key: 'weekly_hours', type: 'slider', q: 'How much focused time per week can you dedicate to nurturing these relationships?', min: 0, max: 8 },
    { key: 'notes', type: 'textarea', q: "Is there any other context you'd like to share? (e.g. 'It's a long-distance relationship')" },
  ],
  Personal: [
    { key: 'focus_area', type: 'single', q: 'Which area of your personal growth is most important to you right now?', options: ['Building Discipline & Habits', 'Improving Mental Focus', 'Reducing Stress & Anxiety', 'Learning a New Skill', 'Boosting Confidence'] },
    { key: 'learning_style', type: 'single', q: 'When you want to learn something new, how do you prefer to do it?', options: ['Reading', 'Listening', 'Watching', 'Doing'] },
    { key: 'challenge', type: 'single', q: 'What is the single biggest internal challenge holding you back?', options: ['Procrastination', 'Lack of Consistency', 'Negative Self-Talk', 'Feeling Overwhelmed', 'Fear of Failure'] },
    { key: 'time_of_day', type: 'single', q: 'When is the best time for you to focus on personal development activities?', options: ['Morning', 'Midday', 'Evening', 'Flexible'] },
    { key: 'current_practices', type: 'multi', q: 'Which of these, if any, are you already practicing?', options: ['Meditation', 'Journaling', 'Reading Non-Fiction', 'Practicing Gratitude'] },
    { key: 'weekly_hours', type: 'slider', q: 'How much time per week can you dedicate specifically to these activities?', min: 0, max: 8 },
    { key: 'notes', type: 'textarea', q: 'What specific skill, habit, or mindset are you most excited to cultivate?' },
  ],
  Work: [
    { key: 'primary_goal', type: 'single', q: 'What is your most important professional goal right now?', options: ['Improve Productivity & Focus', 'Advance in My Current Career', 'Find a New Job', 'Start or Grow My Business', 'Achieve Better Work-Life Balance'] },
    { key: 'status', type: 'single', q: 'Which of these best describes your current work situation?', options: ['Employed', 'Self-Employed / Business Owner', 'Student', 'Currently Looking for Work'] },
    { key: 'challenge', type: 'single', q: 'What is your single biggest challenge at work?', options: ['Managing Time & Procrastination', 'Dealing with Stress & Burnout', 'Lack of a Key Skill', 'Navigating Workplace Communication', 'Staying Organized'] },
    { key: 'environment', type: 'single', q: 'What is your primary work environment?', options: ['Primarily in an Office', 'Fully Remote', 'Hybrid', 'In the Field / On-site'] },
    { key: 'key_skill', type: 'text', q: 'What is one professional skill you want to develop right now?' },
    { key: 'work_style', type: 'single', q: 'How do you prefer to manage your workday?', options: ['Deep Work', 'Time-Blocking', 'Task Juggling', 'I need help finding a system'] },
    { key: 'notes', type: 'textarea', q: "Is there anything else I should know about your career ambitions? (e.g. 'I want to become a manager in 2 years')" },
  ],
};

// GET returns the static questionnaire for this pillar. POST saves the user's answers.
export default async function handler(req, res) {
  if (cors(req, res)) return;

  const pillarName = Object.keys(QUESTIONS).find(p => p.toLowerCase() === String(req.query.pillar).toLowerCase());
  if (!pillarName) return res.status(404).json({ message: 'Unknown pillar' });

  if (req.method === 'GET') {
    return res.status(200).json({ pillar: pillarName, questions: QUESTIONS[pillarName] });
  }

  if (req.method === 'POST' && req.query.action === 'activate') {
    const user = await getUserFromRequest(req);
    if (!user) return res.status(401).json({ message: 'Unauthenticated' });

    const pillarState = await getPillarState(user);
    const alreadyUnlocked = pillarState.unlockedPillars.includes(pillarName.toLowerCase());
    if (!alreadyUnlocked && !pillarState.canActivateNextPillar) {
      return res.status(403).json({ message: "You haven't met the consistency requirements yet to unlock a new pillar." });
    }

    const pillar_id = pillarIdFromName(pillarName);
    await sql`
      INSERT INTO user_pillars (user_id, pillar_id) VALUES (${user.id}, ${pillar_id})
      ON CONFLICT (user_id, pillar_id) DO NOTHING
    `;
    // Resets the consistency-proving window: the clock for "80%/3wk or 95%/1wk on
    // your currently-active pillars" starts fresh from this activation.
    await sql`UPDATE users SET phase_start_date = now() WHERE id = ${user.id}`;

    const rows = await sql`SELECT pillar_id FROM user_pillars WHERE user_id = ${user.id} ORDER BY activated_at ASC`;
    const unlocked_pillars = rows.map(r => (PILLARS[r.pillar_id] || '').toLowerCase());
    return res.status(200).json({ pillar: pillarName, unlocked_pillars });
  }

  if (req.method === 'POST') {
    const user = await getUserFromRequest(req);
    if (!user) return res.status(401).json({ message: 'Unauthenticated' });

    const { answers } = req.body || {};
    if (!answers) return res.status(422).json({ message: 'answers is required' });

    const pillar_id = pillarIdFromName(pillarName);
    const rows = await sql`
      INSERT INTO pillar_answers (user_id, pillar_id, answers)
      VALUES (${user.id}, ${pillar_id}, ${JSON.stringify(answers)}::jsonb)
      RETURNING id
    `;
    return res.status(200).json({ id: rows[0].id, pillar: pillarName });
  }

  res.status(405).json({ message: 'Method not allowed' });
}
