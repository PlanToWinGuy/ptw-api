// Badge criteria are deterministic (counts/streaks/thresholds computed from real log/goal
// data), not AI-graded -- same cost-discipline precedent as inferToolHint()/isRecurringAction()
// elsewhere. Fitness gets its own richer, name-matched set (it was spec'd in detail); every
// other pillar reuses a shared generic template built from the same universal signals
// (primary log count, streak length, completed goals/quests) so every pillar's Trophies page
// has real content without hand-authoring 6 separate lists. `rarity` (1-10) is an explicit,
// designer-authored difficulty tier -- there's no cross-user population data to compute a
// real "X% of players have this" statistic from, so "rarest earned" is honestly presented as
// "hardest of your own earned badges" rather than a fabricated population percentage.
function genericBadgeSet(pillarKey, logTypeLabel) {
  return [
    { id: `${pillarKey}_first_log`, name: 'First Step', icon: '🏅', rarity: 1, description: `Log your first ${logTypeLabel} entry.`, check: ctx => ctx.logCount >= 1, dateOf: ctx => ctx.logDatesAsc[0] },
    { id: `${pillarKey}_10_logs`, name: 'Building Momentum', icon: '💪', rarity: 3, description: `Log 10 ${logTypeLabel} entries.`, check: ctx => ctx.logCount >= 10, dateOf: ctx => ctx.logDatesAsc[9] },
    { id: `${pillarKey}_50_logs`, name: 'Dedicated', icon: '👑', rarity: 6, description: `Log 50 ${logTypeLabel} entries.`, check: ctx => ctx.logCount >= 50, dateOf: ctx => ctx.logDatesAsc[49] },
    { id: `${pillarKey}_week_warrior`, name: 'Week Warrior', icon: '🔥', rarity: 4, description: 'Hit a 7-day streak.', check: ctx => ctx.longestStreakLen >= 7, dateOf: ctx => ctx.longestStreakDate },
    { id: `${pillarKey}_iron_will`, name: 'Iron Will', icon: '⛰️', rarity: 8, description: 'Hit a 30-day streak.', check: ctx => ctx.longestStreakLen >= 30, dateOf: ctx => ctx.longestStreakDate },
    { id: `${pillarKey}_goal_getter`, name: 'Goal Getter', icon: '🎯', rarity: 5, description: 'Complete your first goal in this pillar.', check: ctx => ctx.completedGoalsCount >= 1, dateOf: ctx => ctx.completedGoalDatesAsc[0] },
    { id: `${pillarKey}_quest_slayer`, name: 'Side Quest Slayer', icon: '❓', rarity: 2, description: 'Complete your first Side Quest in this pillar.', check: ctx => ctx.completedQuestsCount >= 1, dateOf: ctx => ctx.completedQuestDatesAsc[0] },
  ];
}

export const BADGE_DEFINITIONS = {
  fitness: [
    { id: 'fitness_first_workout', name: 'First Step', icon: '🏅', rarity: 1, description: 'Complete your first logged workout.', check: ctx => ctx.logCount >= 1, dateOf: ctx => ctx.logDatesAsc[0] },
    { id: 'fitness_first_5k', name: 'First 5k', icon: '🏃', rarity: 3, description: 'Log a cardio session of 5km or more.', check: ctx => ctx.max5kDistance >= 5, dateOf: ctx => ctx.first5kDate },
    { id: 'fitness_10_workouts', name: 'Building Momentum', icon: '💪', rarity: 3, description: 'Log 10 total workouts.', check: ctx => ctx.logCount >= 10, dateOf: ctx => ctx.logDatesAsc[9] },
    { id: 'fitness_century_club', name: 'Century Club', icon: '👑', rarity: 9, description: 'Log 100 total workouts.', check: ctx => ctx.logCount >= 100, dateOf: ctx => ctx.logDatesAsc[99] },
    { id: 'fitness_first_pr', name: 'Breaking Through', icon: '✨', rarity: 2, description: 'Set your first personal record.', check: ctx => ctx.prCount >= 1, dateOf: ctx => ctx.prDatesAsc[0] },
    { id: 'fitness_record_breaker', name: 'Record Breaker', icon: '⚡', rarity: 6, description: 'Set 10 personal records.', check: ctx => ctx.prCount >= 10, dateOf: ctx => ctx.prDatesAsc[9] },
    { id: 'fitness_week_warrior', name: 'Week Warrior', icon: '🔥', rarity: 4, description: 'Hit a 7-day workout streak.', check: ctx => ctx.longestStreakLen >= 7, dateOf: ctx => ctx.longestStreakDate },
    { id: 'fitness_mountain_climber', name: 'Mountain Climber', icon: '⛰️', rarity: 10, description: 'Hit a 30-day workout streak.', check: ctx => ctx.longestStreakLen >= 30, dateOf: ctx => ctx.longestStreakDate },
    { id: 'fitness_heavy_lifter', name: 'Heavy Lifter', icon: '🏋️', rarity: 5, description: 'Log 5,000kg of total strength volume.', check: ctx => ctx.totalVolume >= 5000, dateOf: ctx => ctx.volumeCrossDate },
    { id: 'fitness_cross_trainer', name: 'Cross Trainer', icon: '🌈', rarity: 4, description: 'Log a workout in 3 different activity types.', check: ctx => ctx.activityTypesUsed >= 3, dateOf: ctx => ctx.thirdActivityTypeDate },
    { id: 'fitness_goal_getter', name: 'Goal Getter', icon: '🎯', rarity: 5, description: 'Complete your first Fitness goal.', check: ctx => ctx.completedGoalsCount >= 1, dateOf: ctx => ctx.completedGoalDatesAsc[0] },
    { id: 'fitness_quest_slayer', name: 'Side Quest Slayer', icon: '❓', rarity: 2, description: 'Complete your first Fitness Side Quest.', check: ctx => ctx.completedQuestsCount >= 1, dateOf: ctx => ctx.completedQuestDatesAsc[0] },
  ],
  diet: genericBadgeSet('diet', 'meal'),
  finances: genericBadgeSet('finances', 'transaction'),
  relations: genericBadgeSet('relations', 'connection'),
  personal: genericBadgeSet('personal', 'session'),
  work: genericBadgeSet('work', 'work session'),
};

export function evaluateBadges(pillarKey, ctx) {
  const defs = BADGE_DEFINITIONS[pillarKey] || [];
  return defs.map(b => {
    const earned = !!b.check(ctx);
    return {
      badge_id: b.id,
      name: b.name,
      icon: b.icon,
      description: b.description,
      rarity: b.rarity,
      is_earned: earned,
      date_earned: earned ? (b.dateOf(ctx) || null) : null,
    };
  });
}
