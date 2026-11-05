import "server-only";
import catalogue from "../content/manuals/catalogue.json" with { type: "json" };

type Manual = (typeof catalogue)[number];
type ConversationMessage = {
  role: "user" | "assistant";
  parts: { type: string; text?: string }[];
};
type Passage = {
  manual: Manual;
  page: Manual["pages"][number];
  text: string;
  terms: string[];
};
type ManualExcerpt = {
  appliance: string;
  model: string;
  scope: string;
  section: string;
  url: string;
  text: string;
};

const stopWords = new Set(
  "a an and are as at be can could do does for from get how i in is it its me my of on or our please should that the their them there these this to use using want what when where which with would you your".split(
    " ",
  ),
);
const synonyms: Record<string, string> = {
  emptied: "empty",
  emptying: "empty",
  refilling: "fill",
  refill: "fill",
  filling: "fill",
  cleaned: "clean",
  cleaning: "clean",
  washing: "wash",
  washes: "wash",
  drying: "dry",
  dries: "dry",
  dosing: "dose",
  dosage: "dose",
  charging: "charge",
  charged: "charge",
};

function normalize(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function terms(text: string) {
  return normalize(text)
    .split(" ")
    .filter((word) => word.length > 1 && !stopWords.has(word))
    .map((word) => synonyms[word] ?? word.replace(/s$/, ""));
}

function mentionedManuals(text: string, available: Manual[]) {
  const question = ` ${normalize(text)} `;
  const matched = available.filter((manual) =>
    manual.aliases.some((alias) => question.includes(` ${normalize(alias)} `)),
  );
  if (matched.length > 0) return matched;
  if (/\b(tv|television)\b/.test(question))
    return available.filter((manual) =>
      ["apple-tv", "lg-tv"].includes(manual.id),
    );
  if (/\bvacuum\b/.test(question))
    return available.filter((manual) =>
      ["dyson", "ecovacs"].includes(manual.id),
    );
  if (/\blaundry\b/.test(question))
    return available.filter((manual) =>
      ["washer", "dryer"].includes(manual.id),
    );
  return [];
}

function messageText(message: ConversationMessage) {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join(" ");
}

function chunks(text: string) {
  const result: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + 1700, text.length);
    if (end < text.length) {
      const boundary = text.lastIndexOf(". ", end);
      end = boundary > start + 1000 ? boundary + 1 : text.lastIndexOf(" ", end);
    }
    result.push(text.slice(start, end));
    if (end === text.length) break;
    // Keep context where a numbered procedure or warning crosses a chunk boundary.
    start = Math.max(start + 1, text.indexOf(" ", end - 250) + 1);
  }
  return result;
}

const passages: Passage[] = catalogue.flatMap((manual) =>
  manual.pages.flatMap((page) =>
    chunks(page.text).map((text) => ({
      manual,
      page,
      text,
      terms: terms(text),
    })),
  ),
);
const documentFrequency = new Map<string, number>();
for (const passage of passages)
  for (const term of new Set(passage.terms))
    documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
const averageLength =
  passages.reduce((total, passage) => total + passage.terms.length, 0) /
  passages.length;

export function getManualContext(
  messages: ConversationMessage[],
  readyArticleIds: string[],
): string {
  const available = catalogue.filter((manual) =>
    manual.articleIds.some((id) => readyArticleIds.includes(id)),
  );
  const questions = messages.filter((message) => message.role === "user");
  const latest = questions.at(-1);
  if (!latest) return "[]";
  const question = messageText(latest);
  let selected = mentionedManuals(question, available);
  let previousQuestion = "";
  if (selected.length === 0) {
    // Only resolve appliance follow-ups. A new building/item question must not
    // inherit the previous appliance, nor should an unknown appliance get its manual.
    if (
      /\b(dishwasher|oven|fridge|refrigerator|microwave|aircon|level|gym|pool|garage|parking|wifi)\b/i.test(
        question,
      ) ||
      !/\b(it|its|that|this|filter|tank|button|clean|empty|refill|charge|dry|steam|detergent)\b/i.test(
        question,
      )
    )
      return "[]";
    for (const previous of questions.slice(0, -1).slice(-3).reverse()) {
      previousQuestion = messageText(previous);
      selected = mentionedManuals(previousQuestion, available);
      if (selected.length > 0) break;
      if (/\b(level|gym|pool|garage|parking|wifi)\b/i.test(previousQuestion))
        break;
    }
  }
  if (selected.length === 0) return "[]";
  const deviceTerms = new Set(
    selected.flatMap((manual) => terms(`${manual.title} ${manual.model}`)),
  );
  const query = [...new Set(terms(question))].filter(
    (term) => !deviceTerms.has(term),
  );
  const previousTerms = [...new Set(terms(previousQuestion))].filter(
    (term) => !deviceTerms.has(term),
  );
  const ranked = passages
    .filter((passage) =>
      selected.some((manual) => manual.id === passage.manual.id),
    )
    .map((passage) => {
      function scoreQuery(words: string[]) {
        return words.reduce((total, word) => {
          const count = passage.terms.filter((term) => term === word).length;
          if (count === 0) return total;
          const frequency = documentFrequency.get(word) ?? 0;
          const rarity = Math.log(
            1 + (passages.length - frequency + 0.5) / (frequency + 0.5),
          );
          return (
            total +
            (rarity * count * 2.2) /
              (count +
                1.2 * (0.25 + (0.75 * passage.terms.length) / averageLength))
          );
        }, 0);
      }
      return {
        passage,
        score:
          scoreQuery(query) +
          scoreQuery(previousTerms) * 0.2 +
          (passage.manual.defaultPages.includes(passage.page.page) ? 0.2 : 0),
      };
    })
    .sort((a, b) => b.score - a.score);
  const chosen: ManualExcerpt[] = [];
  const perManual = new Map<string, number>();
  for (const { passage } of ranked) {
    const count = perManual.get(passage.manual.id) ?? 0;
    if (count >= 3) continue;
    const excerpt = {
      appliance: passage.manual.title,
      model: passage.manual.model,
      scope: passage.manual.scope,
      section: passage.page.title,
      url: passage.page.sourceUrl,
      text: passage.text,
    };
    if (JSON.stringify([...chosen, excerpt]).length > 14_000) break;
    chosen.push(excerpt);
    perManual.set(passage.manual.id, count + 1);
    if (chosen.length >= 6) break;
  }
  return JSON.stringify(chosen);
}
