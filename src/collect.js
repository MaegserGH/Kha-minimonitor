import * as cheerio from "cheerio";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const sources = [
  ["Ігор Терехов", "ihor_terekhov"],
  ["Олег Синєгубов", "synegubov"],
  ["Харківська ОВА", "kharkivoda"],
  ["ДСНС Харків", "dsns_kharkiv"],
  ["Прокуратура Харків", "prokuratura_kharkiv"],
  ["Поліція Харківщини", "police_kh_region"],
  ["Харківська міськрада", "citykharkivua"],
];

const outputFile = "data/messages.json";

async function readExistingMessages() {
  try {
    return JSON.parse(await readFile(outputFile, "utf8"));
  } catch {
    return [];
  }
}

async function collectChannel(source, channel) {
  const response = await fetch(`https://t.me/s/${channel}`, {
    headers: {
      "User-Agent": "Mozilla/5.0",
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const $ = cheerio.load(await response.text());
  const messages = [];

  $(".tgme_widget_message").each((_, element) => {
    const id = $(element).attr("data-post");
    const publishedAt = $(element).find("time").attr("datetime");
    const text = $(element)
      .find(".tgme_widget_message_text")
      .text()
      .replace(/\s+/g, " ")
      .trim();

    if (!id || !publishedAt || !text) return;

    messages.push({
      id,
      source,
      publishedAt,
      text,
      url: `https://t.me/${id}`,
    });
  });

  return messages;
}

async function main() {
  await mkdir("data", { recursive: true });

  const existing = await readExistingMessages();
  const allMessages = new Map(existing.map((message) => [message.id, message]));

  for (const [source, channel] of sources) {
    try {
      const messages = await collectChannel(source, channel);

      for (const message of messages) {
        allMessages.set(message.id, message);
      }

      console.log(`✓ ${source}: ${messages.length}`);
    } catch (error) {
      console.error(`✗ ${source}: ${error.message}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  const result = [...allMessages.values()].sort(
    (a, b) => new Date(b.publishedAt) - new Date(a.publishedAt),
  );

  await writeFile(outputFile, JSON.stringify(result, null, 2));

  console.log(`Всего сохранено: ${result.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
