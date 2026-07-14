import { sql, PILLARS } from '../../lib/db.js';
import { cors } from '../../lib/cors.js';
import { getUserFromRequest } from '../../lib/auth.js';

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ message: 'Method not allowed' });
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  const id = Number(req.query.id);
  const rows = await sql`SELECT * FROM side_quests WHERE id = ${id} AND user_id = ${user.id} AND status != 'draft'`;
  const quest = rows[0];
  if (!quest) return res.status(404).json({ message: 'Side Quest not found' });

  const projectTasks = await sql`SELECT * FROM tasks WHERE quest_id = ${id} AND kind = 'project' ORDER BY created_at ASC`;
  const allSubTasks = await sql`SELECT * FROM tasks WHERE quest_id = ${id} AND parent_task_id IS NOT NULL ORDER BY created_at ASC`;

  const projects = projectTasks.map(pt => {
    const subTasks = allSubTasks.filter(st => st.parent_task_id === pt.id);
    const total = subTasks.length;
    const done = subTasks.filter(st => st.status === 'Completed').length;
    return {
      projectId: pt.id,
      projectName: pt.name,
      projectProgressPercent: total ? Math.round((done / total) * 100) : (pt.status === 'Completed' ? 100 : 0),
      subTasks: subTasks.map(st => ({ subTaskId: st.id, name: st.name, isCompleted: st.status === 'Completed' })),
    };
  });

  const totalSub = allSubTasks.length;
  const doneSub = allSubTasks.filter(st => st.status === 'Completed').length;
  const overallProgressPercent = totalSub ? Math.round((doneSub / totalSub) * 100) : (quest.is_completed ? 100 : 0);

  res.status(200).json({
    questId: quest.id,
    title: quest.suggestion,
    aiStrategy: quest.ai_strategy,
    pillar: PILLARS[quest.pillar_id] || null,
    rewards: { xp: quest.xp, badgeName: quest.badge_name },
    endDate: quest.end_date,
    overallProgressPercent,
    projects,
  });
}
