// Job and mark spelling shared by every module.

// The job number a job name is filed under, reduced to its leading token so
// "26123 - 25-418" from the job list and "26123" typed in agree.
export function jobKey(job) {
  return String(job ?? '').trim().toUpperCase().split(/\s+/)[0] ?? '';
}

export function normalizeMark(mark) {
  return String(mark ?? '').trim().toUpperCase();
}
