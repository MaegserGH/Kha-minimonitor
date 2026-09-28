import { readFile, writeFile } from "node:fs/promises";

process.env.TZ = "Europe/Kyiv";

const messages = JSON.parse(
  await readFile("data/messages.json", "utf8"),
);

const cityDistricts =
  /Салтівськ|Київськ|Шевченківськ|Індустріальн|Слобідськ|Основʼянськ|Основ'янськ|Холодногірськ|Немишлянськ|Новобаварськ/i;

const regionPlaces =
  /Харківщин|Харківська область|Ізюм|Андріївк|Чугуїв|Купʼянськ|Куп'янськ|Балаклі|Золочів|Дергач|Берестин/i;

const attackWords =
  /ворожий удар|ворожого удару|російської атаки|обстріл|влучання|влучив|завдав.*удар|завдали.*удар/i;

const historicalWords =
  /за минулий тиждень|202[0-5] року|передали до суду|судитимуть|хвилина мовчання/i;

function getPeriods() {
  const now = new Date();
  const currentStart = new Date(now);

  currentStart.setHours(7, 0, 0, 0);

  if (now < currentStart) {
    currentStart.setDate(currentStart.getDate() - 1);
  }

  const previousStart = new Date(currentStart);
  previousStart.setDate(previousStart.getDate() - 1);

  return {
    now,
    current: {
      start: currentStart,
      end: now,
    },
    previous: {
      start: previousStart,
      end: currentStart,
    },
  };
}

function getScope(text) {
  if (/у Харкові|по Харкову|міста Харкова/i.test(text) || cityDistricts.test(text)) {
    return "city";
  }

  if (regionPlaces.test(text)) {
    return "region";
  }

  return null;
}

function getEventTime(message) {
  const months = {
    січня: 0,
    лютого: 1,
    березня: 2,
    квітня: 3,
    травня: 4,
    червня: 5,
    липня: 6,
    серпня: 7,
    вересня: 8,
    жовтня: 9,
    листопада: 10,
    грудня: 11,
  };

  const match = message.text.match(
    /(\d{1,2})\s+(січня|лютого|березня|квітня|травня|червня|липня|серпня|вересня|жовтня|листопада|грудня).{0,30}?(\d{1,2}):(\d{2})/i,
  );

  if (!match) {
    return new Date(message.publishedAt);
  }

  const published = new Date(message.publishedAt);

  return new Date(
    published.getFullYear(),
    months[match[2].toLowerCase()],
    Number(match[1]),
    Number(match[3]),
    Number(match[4]),
  );
}

function getPeriodName(date, periods) {
  if (date >= periods.current.start && date < periods.current.end) {
    return "current";
  }

  if (date >= periods.previous.start && date < periods.previous.end) {
    return "previous";
  }

  return null;
}

function getStrikeCount(text) {
  if (/подвійн/i.test(text) || /двічі.*завдали удар/i.test(text)) {
    return 2;
  }

  if (/три удари|трьох удар/i.test(text)) {
    return 3;
  }

  return 1;
}

function getVictims(text) {
  const values = [];
  const patterns = [
    /(\d+)\s+(?:людей\s+)?постраждал/gi,
    /постраждал(?:и|их|о)\D{0,20}(\d+)/gi,
    /кількість постраждалих.*?до\s+(\d+)/gi,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      values.push(Number(match[1]));
    }
  }

  if (/двоє.{0,40}(?:зазнали|постраждали)/i.test(text)) {
    values.push(2);
  }

  return values.length ? Math.max(...values) : 0;
}

function getDeaths(text) {
  const values = [];
  const patterns = [
    /(\d+)\s+(?:людей\s+)?загибл/gi,
    /загинул(?:о|и)\D{0,20}(\d+)/gi,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      values.push(Number(match[1]));
    }
  }

  return values.length ? Math.max(...values) : 0;
}

function emptyPeriod() {
  return {
    kharkivStrikes: 0,
    regionStrikes: 0,
    injured: 0,
    deaths: 0,
  };
}

async function readCorrections() {
  try {
    return JSON.parse(
      await readFile("data/corrections.json", "utf8"),
    );
  } catch {
    return {};
  }
}

function getPeriodKey(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Kyiv",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );

  return `${values.year}-${values.month}-${values.day}`;
}

function applyCorrection(statsPeriod, correction) {
  if (!correction) {
    return;
  }

  for (const key of [
    "kharkivStrikes",
    "regionStrikes",
    "injured",
    "deaths",
  ]) {
    if (Number.isInteger(correction[key]) && correction[key] >= 0) {
      statsPeriod[key] = correction[key];
    }
  }
}

const periods = getPeriods();
const stats = {
  updatedAt: periods.now.toISOString(),
  current: emptyPeriod(),
  previous: emptyPeriod(),
};

const strikeEvents = [];
const casualtyMaximums = {
  current: {
    city: 0,
    region: 0,
  },
  previous: {
    city: 0,
    region: 0,
  },
};

const deathMaximums = {
  current: {
    city: 0,
    region: 0,
  },
  previous: {
    city: 0,
    region: 0,
  },
};

for (const message of messages) {
  const text = message.text;

  if (!attackWords.test(text) || historicalWords.test(text)) {
    continue;
  }

  const scope = getScope(text);

  if (!scope) {
    continue;
  }

  const eventTime = getEventTime(message);
  const periodName = getPeriodName(eventTime, periods);

  if (!periodName) {
    continue;
  }

  const victims = getVictims(text);
  const deaths = getDeaths(text);

  casualtyMaximums[periodName][scope] = Math.max(
    casualtyMaximums[periodName][scope],
    victims,
  );

  deathMaximums[periodName][scope] = Math.max(
    deathMaximums[periodName][scope],
    deaths,
  );

  const canCountStrike =
    (scope === "city" && message.source === "Ігор Терехов") ||
    (scope === "region" && message.source === "ДСНС Харків");

  const confirmsStrike =
    /зафіксовано.*(?:удар|влучання)|завдав.*удар|завдали.*удар|влучив/i.test(text);

  const isAftermathOnly =
    /ліквідації наслідків/i.test(text) && !confirmsStrike;

  if (canCountStrike && confirmsStrike && !isAftermathOnly) {
    strikeEvents.push({
      periodName,
      scope,
      time: eventTime,
      count: getStrikeCount(text),
      text: message.text,
      source: message.source,
      url: message.url,
    });
  }
}

strikeEvents.sort((a, b) => a.time - b.time);

const acceptedEvents = [];

for (const event of strikeEvents) {
  const duplicate = acceptedEvents.find((saved) => {
    const timeDifference = Math.abs(saved.time - event.time);

    return (
      saved.periodName === event.periodName &&
      saved.scope === event.scope &&
      timeDifference < 60 * 60 * 1000
    );
  });

  if (duplicate) {
    duplicate.count = Math.max(duplicate.count, event.count);
  } else {
    acceptedEvents.push(event);
  }
}

for (const event of acceptedEvents) {
  if (event.scope === "city") {
    stats[event.periodName].kharkivStrikes += event.count;
  } else {
    stats[event.periodName].regionStrikes += event.count;
  }
}

for (const periodName of ["current", "previous"]) {
  stats[periodName].injured =
    casualtyMaximums[periodName].city +
    casualtyMaximums[periodName].region;

  stats[periodName].deaths =
    deathMaximums[periodName].city +
    deathMaximums[periodName].region;
}

const corrections = await readCorrections();

applyCorrection(
  stats.current,
  corrections[getPeriodKey(periods.current.start)],
);

applyCorrection(
  stats.previous,
  corrections[getPeriodKey(periods.previous.start)],
);

stats.periods = {
  current: {
    start: periods.current.start.toISOString(),
    end: periods.current.end.toISOString(),
  },
  previous: {
    start: periods.previous.start.toISOString(),
    end: periods.previous.end.toISOString(),
  },
};

stats.currentKharkivEvents = acceptedEvents
  .filter(
    (event) =>
      event.periodName === "current" &&
      event.scope === "city",
  )
  .map((event) => ({
    time: event.time.toISOString(),
    count: event.count,
    text: event.text,
    source: event.source,
    url: event.url,
  }));

await writeFile(
  "data/stats.json",
  JSON.stringify(stats, null, 2),
);

console.log(stats);
