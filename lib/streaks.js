// Given an array of "YYYY-MM-DD" date strings (duplicates allowed), computes every
// consecutive-day run. Shared by the Streaks endpoint and streak-based badge criteria so
// there's exactly one implementation of "what counts as a streak" across the app.
export function computeConsecutiveDayRuns(dateStrings) {
  const uniqueDates = [...new Set(dateStrings.filter(Boolean))].sort();
  if (!uniqueDates.length) return { runs: [], longestEver: null, active: null };

  const runs = [];
  let runStart = uniqueDates[0];
  for (let i = 1; i < uniqueDates.length; i++) {
    const prevDate = new Date(uniqueDates[i - 1] + 'T00:00:00');
    const curDate = new Date(uniqueDates[i] + 'T00:00:00');
    const dayDiff = Math.round((curDate - prevDate) / 86400000);
    if (dayDiff !== 1) {
      const length = Math.round((prevDate - new Date(runStart + 'T00:00:00')) / 86400000) + 1;
      runs.push({ startDate: runStart, endDate: uniqueDates[i - 1], length });
      runStart = uniqueDates[i];
    }
  }
  const lastDate = uniqueDates[uniqueDates.length - 1];
  const finalLength = Math.round((new Date(lastDate + 'T00:00:00') - new Date(runStart + 'T00:00:00')) / 86400000) + 1;
  runs.push({ startDate: runStart, endDate: lastDate, length: finalLength });

  const longestEver = runs.reduce((best, r) => (!best || r.length > best.length) ? r : best, null);
  const todayStr = new Date().toISOString().split('T')[0];
  const yesterdayStr = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  const lastRun = runs[runs.length - 1];
  const active = lastRun && (lastRun.endDate === todayStr || lastRun.endDate === yesterdayStr) ? lastRun : null;

  return { runs, longestEver, active };
}
