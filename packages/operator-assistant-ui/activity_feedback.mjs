// Presentation only: these indicators never grant or resume computer control.
export function microphoneEnvelope(samples, bars = 24) {
  if (!samples?.length) return Array(bars).fill(0);
  return Array.from({length: bars}, (_, bar) => {
    const from = Math.floor(bar * samples.length / bars);
    const to = Math.max(from + 1, Math.floor((bar + 1) * samples.length / bars));
    let sum = 0;
    for (let i = from; i < to; i++) sum += (Number(samples[i]) || 0) ** 2;
    return Math.min(1, Math.sqrt(sum / (to - from)) * 5);
  });
}

export function recordingPresentation({recording, busy, startedAt = 0}, now = Date.now()) {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  return { visible: recording || busy, stop: recording,
    label: recording ? 'Stop dictation' : busy ? 'Preparing dictation' : 'Start dictation',
    text: recording ? `Recording · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
      : busy ? 'Processing audio…' : '' };
}

export function computerControlPresentation(payload, stale = false) {
  if (stale) return {visible: true, active: false, text: 'Computer control status unavailable · Reconnecting…'};
  const active = payload?.running === true && payload?.desktopCaptureSuppressed === false;
  const unavailable = payload?.computerControlIndicator === 'unavailable';
  return {visible: active, active, text: active ? 'Computer control active · Operator may move the pointer and type'
    + (unavailable ? ' · Desktop outline unavailable' : '') : ''};
}

export function messagePresentation(message) {
  return message?.controlAction === 'resume'
    ? {role: 'activity', label: 'Task activity', text: 'Task resumed'}
    : {role: message?.role === 'user' ? 'user' : message?.role === 'error' ? 'error' : 'assistant', text: message?.text || ''};
}
