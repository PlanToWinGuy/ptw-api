// Curated, static break types for the "Take a Break" flow (4.14) -- durations, XP, and
// habit-stacking hints are fixed here rather than generated live, same cost-discipline
// reasoning as Shuffle Day's contextual rules. Free Time intentionally earns no XP.
export const BREAK_TYPES = {
  bathroom: { label: 'Bathroom', icon: '🚻', durationMinutes: 5, xp: 10, hint: 'Quick refresh — splash some cold water on your face.' },
  snack: { label: 'Snack / Hydration', icon: '🥤', durationMinutes: 10, xp: 15, hint: 'Pair this with your next glass of water for the day.' },
  stretch: { label: 'Stretch / Breathwork', icon: '🧘', durationMinutes: 10, xp: 20, hint: 'Try box breathing: 4 counts in, 4 hold, 4 out, 4 hold.' },
  walk: { label: 'Walk / Movement', icon: '🚶', durationMinutes: 15, xp: 25, hint: 'A short walk resets focus better than more coffee.' },
  mental_reset: { label: 'Mental Reset', icon: '🌿', durationMinutes: 10, xp: 20, hint: 'Close your eyes and name 5 things you can hear.' },
  free_time: { label: 'Free Time', icon: '☕', durationMinutes: 15, xp: 0, hint: 'No agenda — this one is just for you.' },
};
