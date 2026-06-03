function buildCorrectionContext(message, { nowPlaying = null, tracks = [], lastMusicIntent = null } = {}) {
  const text = compact(message);
  const current = normalizeTrack(nowPlaying);
  const recentTracks = Array.isArray(tracks) ? tracks.slice(-5).map(normalizeTrack).filter(Boolean) : [];
  const target = extractCorrectionTarget(text);
  const rejectedArtist = target || current?.artist || lastMusicIntent?.musicRequest?.artist || '';
  const rejectedTrack = current ? trackLabel(current) : '';

  return {
    message: text,
    target,
    rejectedTrack,
    rejectedArtist,
    recentTracks,
    lastMusicIntent: summarizeIntent(lastMusicIntent),
    instructions: [
      'Treat this as a listener correction, not a fresh random request.',
      'Do not repeat the rejected current track.',
      target ? `Use "${target}" as the active correction clue. If it is an artist, stay near that artist but choose a different era, energy, or style than the rejected result.` : '',
      !target && rejectedArtist ? `Avoid leaning on ${rejectedArtist} unless the listener explicitly asked to stay with that artist.` : '',
      'Acknowledge the reset briefly in the opening, then move on like a live DJ.',
    ].filter(Boolean),
  };
}

function formatCorrectionForPrompt(correctionContext) {
  if (!correctionContext) return '';
  const lines = [
    `Listener correction: ${correctionContext.message || 'unknown'}`,
  ];
  if (correctionContext.target) lines.push(`Correction target/clue: ${correctionContext.target}`);
  if (correctionContext.rejectedTrack) lines.push(`Rejected current track: ${correctionContext.rejectedTrack}`);
  if (correctionContext.rejectedArtist) lines.push(`Rejected/avoid artist clue: ${correctionContext.rejectedArtist}`);
  if (correctionContext.recentTracks?.length) {
    lines.push(`Recent station tracks to avoid repeating: ${correctionContext.recentTracks.map(trackLabel).join('; ')}`);
  }
  if (correctionContext.lastMusicIntent) lines.push(`Previous music intent: ${correctionContext.lastMusicIntent}`);
  if (correctionContext.instructions?.length) {
    lines.push(`Correction instructions:\n${correctionContext.instructions.map(item => `- ${item}`).join('\n')}`);
  }
  return lines.join('\n');
}

function extractCorrectionTarget(text) {
  const patterns = [
    /不是这种\s*(.+)$/i,
    /不是这个\s*(.+)$/i,
    /换一个版本\s*(.+)?$/i,
    /not this\s*(.+)?$/i,
    /not that\s*(.+)?$/i,
    /wrong\s+(?:version|song)\s*(.+)?$/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return compact(match[1] || '');
  }
  return '';
}

function summarizeIntent(intent) {
  if (!intent) return '';
  const parts = [];
  if (intent.userIntent) parts.push(intent.userIntent);
  if (intent.message) parts.push(`"${intent.message}"`);
  if (intent.musicRequest?.query) parts.push(`query ${intent.musicRequest.query}`);
  return parts.join(' / ');
}

function normalizeTrack(track) {
  if (!track?.title && !track?.query) return null;
  return {
    title: compact(track.title || track.query),
    artist: compact(track.artist || ''),
  };
}

function trackLabel(track) {
  return `${track.title || track.query || ''}${track.artist ? ` - ${track.artist}` : ''}`.trim();
}

function compact(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

module.exports = {
  buildCorrectionContext,
  formatCorrectionForPrompt,
};
