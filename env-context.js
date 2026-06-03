const environment = {
  timeZone: validTimeZone(process.env.CLAUDIO_TIME_ZONE) ||
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    'UTC',
  locale: process.env.CLAUDIO_LOCALE || 'en-US',
};

function validTimeZone(value) {
  if (!value) return '';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return value;
  } catch {
    return '';
  }
}

function formatDateParts(date = new Date(), timeZone = environment.timeZone, locale = environment.locale) {
  const parts = new Intl.DateTimeFormat(locale || 'en-US', {
    timeZone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = type => parts.find(part => part.type === type)?.value || '';
  return {
    weekday: get('weekday'),
    month: get('month'),
    day: get('day'),
    year: get('year'),
    hour: get('hour'),
    minute: get('minute'),
  };
}

function currentTimeContext(date = new Date()) {
  const parts = formatDateParts(date);
  return {
    timeZone: environment.timeZone,
    locale: environment.locale,
    iso: date.toISOString(),
    time: `${parts.hour}:${parts.minute}`,
    date: `${parts.weekday}, ${parts.month} ${parts.day}, ${parts.year}`,
    weekday: parts.weekday,
    hour: Number(parts.hour),
  };
}

function updateEnvironment(input = {}) {
  const timeZone = validTimeZone(input.timeZone);
  if (timeZone) environment.timeZone = timeZone;
  if (typeof input.locale === 'string' && input.locale.trim()) {
    environment.locale = input.locale.trim();
  }
}

async function environmentSnapshot() {
  const time = currentTimeContext();
  return { ...time };
}

function environmentPromptText() {
  const time = currentTimeContext();
  const lines = [
    `Local date/time: ${time.date}, ${time.time} (${time.timeZone})`,
  ];
  return lines.join('\n');
}

module.exports = {
  currentTimeContext,
  environmentPromptText,
  environmentSnapshot,
  updateEnvironment,
};
