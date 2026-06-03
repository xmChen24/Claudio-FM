const ARC_PHASES = ['opening', 'settling', 'lift', 'landing'];

function createProgramArc({ userInput = '', userIntent = '', title = '', tracks = [], correctionContext = null } = {}) {
  const target = inferTarget(userInput, userIntent, correctionContext);
  const energyCurve = energyCurveForTarget(target);
  return {
    version: 1,
    title: title || target.label,
    target: target.key,
    targetLabel: target.label,
    phase: 'opening',
    startedAt: Date.now(),
    updatedAt: Date.now(),
    trackCount: Array.isArray(tracks) ? tracks.length : 0,
    energyCurve,
    nextMove: energyCurve[1] || energyCurve[0] || 'settle',
    notes: target.notes,
    correction: correctionContext ? summarizeCorrection(correctionContext) : null,
  };
}

function extendProgramArc(arc, { tracksAdded = 0, reason = '' } = {}) {
  const current = arc || createProgramArc();
  const trackCount = Number(current.trackCount || 0) + Number(tracksAdded || 0);
  const phase = phaseForTrackCount(trackCount);
  const phaseIndex = ARC_PHASES.indexOf(phase);
  return {
    ...current,
    phase,
    trackCount,
    updatedAt: Date.now(),
    nextMove: current.energyCurve?.[Math.min(phaseIndex + 1, current.energyCurve.length - 1)] || 'hold',
    lastReason: reason || current.lastReason || '',
  };
}

function formatProgramArcForPrompt(arc) {
  if (!arc) return 'No active program arc yet.';
  const lines = [
    `Program arc: ${arc.targetLabel || arc.target || 'open format'}`,
    `Current phase: ${arc.phase || 'unknown'}`,
    `Track count in arc: ${arc.trackCount || 0}`,
    `Energy curve: ${(arc.energyCurve || []).join(' -> ')}`,
    `Next move: ${arc.nextMove || 'hold the room'}`,
  ];
  if (arc.notes) lines.push(`Arc notes: ${arc.notes}`);
  if (arc.correction) lines.push(`Recent correction: ${arc.correction}`);
  if (arc.lastReason) lines.push(`Last internal reason: ${arc.lastReason}`);
  return lines.join('\n');
}

function inferTarget(userInput, userIntent, correctionContext) {
  const input = String(userInput || '').toLowerCase();
  if (correctionContext) {
    return {
      key: 'correction',
      label: 'Correction recovery',
      notes: 'Recover from the listener correction with a clearer lane and avoid the rejected track/artist/vibe.',
    };
  }
  if (/工作|学习|focus|work|study|coding|写代码/.test(input)) {
    return {
      key: 'focus',
      label: 'Focused private set',
      notes: 'Keep transitions controlled, avoid disruptive peaks, and let momentum build quietly.',
    };
  }
  if (/累|睡|放松|休息|tired|sleep|relax|wind down|rough day/.test(input)) {
    return {
      key: 'soft_landing',
      label: 'Soft landing set',
      notes: 'Lower the room temperature, avoid hard pivots, and keep the DJ voice sparse.',
    };
  }
  if (/提神|兴奋|开心|lift|energy|hype|party|excited/.test(input)) {
    return {
      key: 'lift',
      label: 'Energy lift set',
      notes: 'Build toward brighter energy without jumping abruptly.',
    };
  }
  if (/深夜|夜晚|midnight|late night|night/.test(input)) {
    return {
      key: 'late_night',
      label: 'Late-night signal',
      notes: 'Use texture, space, and restraint; avoid over-explaining.',
    };
  }
  if (userIntent === 'artist_request' || userIntent === 'direct_music_request' || userIntent === 'exact_track_request') {
    return {
      key: 'request_lane',
      label: 'Listener request lane',
      notes: 'Honor the request first, then shape adjacent songs around its energy and era.',
    };
  }
  return {
    key: 'open_format',
    label: 'Open-format private radio',
    notes: 'Make the set feel selected, connected, and paced like a live host is steering it.',
  };
}

function energyCurveForTarget(target) {
  switch (target.key) {
    case 'focus':
      return ['steady open', 'locked groove', 'gentle lift', 'clean handoff'];
    case 'soft_landing':
      return ['soft open', 'settle down', 'deeper calm', 'quiet landing'];
    case 'lift':
      return ['bright open', 'build', 'peak lift', 'controlled landing'];
    case 'late_night':
      return ['low light', 'wide space', 'slow burn', 'after-hours landing'];
    case 'request_lane':
      return ['request confirmation', 'artist/track lane', 'adjacent color', 'smooth exit'];
    case 'correction':
      return ['reset clearly', 'avoid rejected lane', 'confirm the new direction', 'stabilize'];
    default:
      return ['open', 'settle', 'turn', 'land'];
  }
}

function phaseForTrackCount(trackCount) {
  if (trackCount <= 2) return 'opening';
  if (trackCount <= 5) return 'settling';
  if (trackCount <= 8) return 'lift';
  return 'landing';
}

function summarizeCorrection(correctionContext) {
  const parts = [];
  if (correctionContext.rejectedTrack) parts.push(`avoid track ${correctionContext.rejectedTrack}`);
  if (correctionContext.rejectedArtist) parts.push(`avoid artist ${correctionContext.rejectedArtist}`);
  if (correctionContext.message) parts.push(`listener said "${correctionContext.message}"`);
  return parts.join('; ');
}

module.exports = {
  createProgramArc,
  extendProgramArc,
  formatProgramArcForPrompt,
};
